// The client's sync baseline (CLAUDE.md §9, SPEC §3.3.1) — PURE, browser-safe.
//
// One state per tab, owned by globalEventStream.ts, which feeds it every SSE
// message as `{type, lastEventId, payload}` and acts on the answer. The rules,
// binding:
//   - `sync_hello{resume}` requires `hello.epoch === epoch`; `lastRev` is left
//     UNCHANGED (the replay starts at `lastRev + 1`).
//   - `sync_hello{resync}`: `epoch = hello.epoch; lastRev = null` (any reason).
//     Never `lastRev = hello.rev` (I16): a stream cut before its end frame must
//     resync again, never resume from a snapshot it did not finish.
//   - replayed and live BUS lines: `rev ≤ lastRev ⇒ drop` (control types are
//     exempt), else deliver and `lastRev = rev`.
//   - `sync_replay_end{rev}`: `lastRev = max(lastRev, rev)` (frames filtered out
//     for this connection are irrelevant to it).
//   - resync snapshot frames never advance `lastRev`; `sync_snapshot_end` (its
//     `id: E.R`) sets `lastRev = R` and fires the resync listeners.
//   - a heartbeat (`id: E.<current>`) on a LIVE connection proves that every
//     frame ≤ that rev routed to this connection was written before it (C11:
//     the registry pushes it after them, same FIFO): `lastRev = max(lastRev,
//     rev)`. This is what makes the transcript probe's "wait until the SSE
//     delivered ≤ probe.rev" immediate on an idle connection.
//   - a frame without a parseable id (an old hub, or before any hello on this
//     connection) is delivered with `rev: null` and touches nothing.
// The reconnect URL carries `since = epoch.lastRev` when both are set, else
// nothing (`sinceParam`): a cut mid-replay resumes from the last delivered
// line, a cut mid-snapshot resyncs.
import { SYNC_CONTROL_TYPES } from '@/lib/sync/protocol';
import { parseRev, type SyncRev } from '@/lib/sync/rev';

export type SyncPhase = 'idle' | 'replay' | 'snapshot' | 'live';
export type ResyncReason = 'first' | 'epoch' | 'gap' | 'cap' | 'future';

export type SyncClientState = {
  epoch: number | null;
  lastRev: number | null;
  /** Of the CURRENT connection: `idle` until its hello (a legacy hub never
   *  sends one), `replay` until `sync_replay_end`, `snapshot` until
   *  `sync_snapshot_end`, then `live`. */
  phase: SyncPhase;
  /** The resync's R (from its hello): the stamp of `sync_summaries`/`sync_vps`/
   *  `sync_installs`, which carry no id of their own. */
  snapshotStamp: SyncRev | null;
  resyncReason: ResyncReason | null;
  /** The build this page was rendered by (`initialSync.buildId`); null = unknown. */
  expectedBuildId: string | null;
};

export type SyncInput = { type: string; lastEventId: string | null | undefined; payload: Record<string, unknown> };

export type SyncOutput = {
  state: SyncClientState;
  /** Hand the frame to consumers (false: dropped by the dup guard, or a
   *  heartbeat — liveness only). */
  deliver: boolean;
  /** The frame's bus revision (null: control frame, or rev-less). */
  rev: SyncRev | null;
  /** Part of a ring resume (between `sync_hello{resume}` and its end). */
  catchUp: boolean;
  fire: 'resync' | 'buildMismatch' | null;
  /** A resume hello that does not match this baseline (cannot happen with a
   *  well-behaved hub): the transport drops its position and reconnects. */
  reconnect?: true;
};

export function initialSyncState(): SyncClientState {
  return {
    epoch: null, lastRev: null, phase: 'idle', snapshotStamp: null, resyncReason: null, expectedBuildId: null,
  };
}

/** The page seed's stamp (first connect of the page resumes from it instead of
 *  resyncing). Ignored once a position exists. */
export function withInitialPosition(
  s: SyncClientState, stamp: (SyncRev & { buildId?: string | null }) | null | undefined,
): SyncClientState {
  if (!stamp) return s;
  const next = { ...s };
  if (typeof stamp.buildId === 'string' && stamp.buildId) next.expectedBuildId ??= stamp.buildId;
  if (s.epoch == null && s.lastRev == null
    && Number.isSafeInteger(stamp.epoch) && Number.isSafeInteger(stamp.rev)) {
    next.epoch = stamp.epoch;
    next.lastRev = stamp.rev;
  }
  return next;
}

/** A new connection opened: nothing of it has been seen yet. */
export function onOpen(s: SyncClientState): SyncClientState {
  return { ...s, phase: 'idle', snapshotStamp: null, resyncReason: null };
}

/** `?since=` for the next connect: `epoch.lastRev` when both are set. */
export function sinceParam(s: SyncClientState): string | null {
  return s.epoch != null && s.lastRev != null ? `${s.epoch}.${s.lastRev}` : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

export function onFrame(s: SyncClientState, input: SyncInput): SyncOutput {
  const { type, payload } = input;
  const none = (state: SyncClientState, deliver: boolean): SyncOutput =>
    ({ state, deliver, rev: null, catchUp: false, fire: null });

  if (type === 'sync_hello') {
    const epoch = num(payload.epoch);
    const helloRev = num(payload.rev);
    if (epoch == null || helloRev == null) return none(s, false);
    const buildId = typeof payload.buildId === 'string' ? payload.buildId : null;
    const mismatch = buildId != null && s.expectedBuildId != null && buildId !== s.expectedBuildId;
    const fire = mismatch ? 'buildMismatch' as const : null;
    if (payload.mode === 'resume') {
      const from = num(payload.from);
      if (s.epoch !== epoch || s.lastRev == null || (from != null && from !== s.lastRev)) {
        // Not the baseline we asked from: forget it, reconnect for a resync.
        return {
          state: { ...s, epoch: null, lastRev: null, phase: 'idle', snapshotStamp: null },
          deliver: false, rev: null, catchUp: false, fire, reconnect: true,
        };
      }
      return { state: { ...s, phase: 'replay', snapshotStamp: null, resyncReason: null },
        deliver: true, rev: null, catchUp: false, fire };
    }
    const reason = (['first', 'epoch', 'gap', 'cap', 'future'] as const)
      .find((r) => r === payload.reason) ?? 'first';
    return {
      state: {
        ...s, epoch, lastRev: null, phase: 'snapshot',
        snapshotStamp: { epoch, rev: helloRev }, resyncReason: reason,
      },
      deliver: true, rev: null, catchUp: false, fire,
    };
  }

  if (type === 'sync_replay_end') {
    const rev = num(payload.rev);
    if (s.phase !== 'replay') return none(s, false);
    const lastRev = rev != null && (s.lastRev == null || rev > s.lastRev) ? rev : s.lastRev;
    return none({ ...s, lastRev, phase: 'live' }, true);
  }

  if (type === 'sync_snapshot_end') {
    if (s.phase !== 'snapshot' || !s.snapshotStamp) return none(s, false);
    const idRev = parseRev(input.lastEventId);
    const R = num(payload.rev) ?? idRev?.rev ?? s.snapshotStamp.rev;
    const epoch = idRev?.epoch ?? s.snapshotStamp.epoch;
    return {
      state: { ...s, epoch, lastRev: R, phase: 'live' },
      deliver: true, rev: { epoch, rev: R }, catchUp: false, fire: 'resync',
    };
  }

  if (type === 'heartbeat') {
    const idRev = parseRev(input.lastEventId);
    if (s.phase === 'live' && idRev && idRev.epoch === s.epoch && s.lastRev != null && idRev.rev > s.lastRev) {
      return none({ ...s, lastRev: idRev.rev }, false);
    }
    return none(s, false);
  }

  if (SYNC_CONTROL_TYPES.has(type)) {
    // sync_summaries / sync_vps / sync_installs / model_notices: exempt from
    // the dup guard, never advance lastRev. A LIVE `model_notices` is a bus
    // frame with its own id (it may advance lastRev like any line).
    if (type === 'model_notices' && (s.phase === 'live' || s.phase === 'replay')) {
      const idRev = parseRev(input.lastEventId);
      if (idRev && idRev.epoch === s.epoch && s.lastRev != null && idRev.rev > s.lastRev) {
        return { state: { ...s, lastRev: idRev.rev }, deliver: true, rev: idRev, catchUp: s.phase === 'replay', fire: null };
      }
    }
    return none(s, true);
  }

  // A bus frame.
  if (s.phase === 'idle' || s.phase === 'snapshot') {
    // No hello on this connection (a legacy hub), or impossible mid-snapshot:
    // rev-less passthrough.
    return none(s, true);
  }
  const rev = parseRev(input.lastEventId);
  if (!rev || rev.epoch !== s.epoch) return none(s, true);
  if (s.lastRev != null && rev.rev <= s.lastRev) {
    return { state: s, deliver: false, rev, catchUp: s.phase === 'replay', fire: null };
  }
  return {
    state: { ...s, lastRev: rev.rev },
    deliver: true, rev, catchUp: s.phase === 'replay', fire: null,
  };
}
