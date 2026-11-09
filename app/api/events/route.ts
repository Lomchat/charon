import { getModelNotices } from '@/lib/server/hub/modelNotices';
import { requireApiSession } from '@/lib/server/session';
import { seedInitialData } from '@/lib/server/seed';
import { connectionFocusOf, markConnectionLive, registerConnection } from '@/lib/server/agent/eventConnections';
import { sweepExpiredInteractions } from '@/lib/server/agent/sessionOps';
import type { GlobalSessionEvent } from '@/lib/server/agent/sessionOps';
import { listVpsRuntimeSnapshots } from '@/lib/server/agent/vpsRuntimeSnapshot';
import { pickVpsRuntimeFields } from '@/lib/vpsRuntimeFields';
import { listInstalls } from '@/lib/server/install/installSession';
import { timeSection } from '@/lib/server/perf/loopLag';
import {
  currentRev, epoch as busEpoch, flushSummaries, recordClose, recordResume, recordResync, replayFrom, syncStats,
} from '@/lib/server/sync/syncBus';
import { frameReaches } from '@/lib/server/sync/frameRouting';
import { buildId } from '@/lib/server/sync/buildId';
import { createOutbox, OUTBOX_HWM, RESUME_MAX_BYTES } from '@/lib/server/sync/outbox';
import { writeLegacySnapshot } from '@/lib/server/sync/legacyEvents';
import { reconcileAllSummaries } from '@/lib/server/sync/sessionSummaries';
import { parseRev, type SyncRev } from '@/lib/sync/rev';
import type { SyncControlFrame } from '@/lib/sync/protocol';
import type { VpsRuntimeSnapshot } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ResyncReason = 'first' | 'epoch' | 'gap' | 'cap' | 'future';

// GET /api/events?conn=<uuid>&focus=<sid>&focusSeq&visible&attentive&attentiveAgeMs
//                        [&proto=2&since=<epoch>.<rev>]
//
// THE multiplexed SSE (one per tab; focus switches via POST /api/focus).
// Live = bus frames (`id: <epoch>.<rev>`, encoded once at publish) routed by
// focus (`frameRouting.ts`) + the registry heartbeat (eventConnections.ts),
// written through a pull-driven outbox (lib/server/sync/outbox.ts: overflow
// closes, never drops).
//
// Every request registers its connection NOT live, writes its initial lines
// and marks it live in ONE synchronous tick: a frame published meanwhile is
// ≤ what those lines reflect.
//   - proto=2 (CLAUDE.md §9): `since` = header `Last-Event-ID`, else `?since=`.
//     Resume iff the ring still covers (since, now] for this connection's
//     CURRENT focus within RESUME_MAX_BYTES: `sync_hello{resume}` → the missed
//     bus lines (their own ids) → `sync_replay_end`. Otherwise an EXPLICIT
//     resync: `sync_hello{resync}` → `sync_summaries` → `sync_vps` →
//     `sync_installs` → `model_notices` → `id: E.R` + `sync_snapshot_end`.
//     Any exception closes the stream without its end frame (the client
//     reconnects); a resync is never left open half-written.
//   - no proto (legacy bundles, G11): lib/server/sync/legacyEvents.ts.
// Headers unchanged; no `retry:` line (the client reconnects manually).
export async function GET(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;

  // Cold-start safety net (CLAUDE.md §14.45). A browser tab that survives a
  // `systemctl restart charon` reconnects its singleton SSE HERE without any
  // SSR render, so without this call the AgentClientPool + SessionStream maps
  // would stay empty (no SSH proxy, no attached stream) and no live agent
  // event would ever arrive on the reconnected SSE — "frozen until F5". This
  // is the ONE endpoint every live tab is guaranteed to hit after a restart.
  // seedInitialData is idempotent (guarded), so this is ~free after boot.
  try { seedInitialData(); } catch {}

  const url = new URL(req.url);
  const connId = url.searchParams.get('conn');
  if (!connId || connId.length < 8 || connId.length > 64) {
    return new Response('missing or invalid conn id', { status: 400 });
  }
  const initialFocus = url.searchParams.get('focus');
  const initialVisible = url.searchParams.get('visible') !== '0';
  const initialFocusSeqRaw = Number(url.searchParams.get('focusSeq') ?? 0);
  const initialFocusSeq = Number.isSafeInteger(initialFocusSeqRaw) && initialFocusSeqRaw >= 0
    ? initialFocusSeqRaw : 0;
  // `attentive=1|0` (a client that reports attention, §14.47); absent ⇒ a
  // legacy client, for which "attended" keeps meaning "visible".
  const attentiveParam = url.searchParams.get('attentive');
  const initialAttentive = attentiveParam === '1' ? true : attentiveParam === '0' ? false : undefined;
  // Age of that proof (ms since the last input): dates the grant by the input.
  const ageRaw = url.searchParams.get('attentiveAgeMs');
  const ageNum = ageRaw == null || ageRaw === '' ? NaN : Number(ageRaw);
  const initialAttentiveAgeMs = Number.isFinite(ageNum) && ageNum >= 0 ? ageNum : undefined;
  const proto2 = url.searchParams.get('proto') === '2';
  // The header (a native EventSource reconnect) wins over the query.
  const since: SyncRev | null = proto2
    ? parseRev(req.headers.get('last-event-id')) ?? parseRev(url.searchParams.get('since'))
    : null;

  const encoder = new TextEncoder();
  let unregister: (() => void) | null = null;
  let disposeOutbox: (() => void) | null = null;
  let drainOutbox: (() => void) | null = null;
  let ended = false;

  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      timeSection('SSE start', () => {
      const close = (reason: string) => {
        if (ended) return;
        ended = true;
        recordClose(reason);
        if (unregister) { unregister(); unregister = null; }
        disposeOutbox?.();
        try { controller.close(); } catch {}
      };

      // A registration exists only while a consumer can still end it. The
      // client may be gone already (closed or reloaded during the handler's
      // async prologue, e.g. a hub stall): its signal aborted BEFORE this
      // start(), so a listener added now would never fire, and Next does not
      // cancel the body of a destroyed response either — registering would
      // leave a live zombie conn counting as watching its focus (G8, §14.15).
      if (req.signal?.aborted) {
        ended = true;
        try { controller.close(); } catch {}
        return;
      }

      const outbox = createOutbox(controller, close);
      disposeOutbox = outbox.dispose;
      drainOutbox = outbox.drain;
      const push = (chunk: Uint8Array) => { if (!ended) outbox.push(chunk); };
      // Control / legacy snapshot frames are per-connection: no `id:`.
      const sendNow = (ev: GlobalSessionEvent | SyncControlFrame | Record<string, unknown>) => {
        push(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      };

      // Register BEFORE reading the snapshot, NOT live: the bus router skips
      // this connection until `markConnectionLive` below, in this same
      // synchronous tick — a frame published meanwhile is already reflected
      // by the snapshot (or inside the replayed range). `close`: a newer
      // stream registering the same connId ends THIS one instead of leaving
      // it running unregistered (CLAUDE.md §14.15).
      unregister = registerConnection({
        connId, push, queuedBytes: outbox.queuedBytes, close: (reason) => close(reason),
        initialFocus, initialFocusSeq, initialVisible, initialAttentive, initialAttentiveAgeMs,
        proto: proto2 ? 2 : 1,
      });
      // Right after registering (not after the snapshot): an abort from here
      // on always reaches this stream's unregister.
      req.signal?.addEventListener('abort', () => close('abort'), { once: true });

      // Any throw below ends the stream AND unregisters it (no `live:false`
      // conn left behind in the registry).
      try {
        // The REGISTERED focus (it may have inherited a newer one than the URL's
        // from the superseded stream), not the raw URL param.
        if (proto2) writeSyncPrologue({ since, focus: connectionFocusOf(connId) ?? null, push, sendNow });
        else writeLegacySnapshot(sendNow);
        if (ended) return;
        // Initial lines enqueued: route bus frames here from now on. The
        // registry sends the first heartbeat now and every 8 s after (a TYPED
        // data frame — EventSource never surfaces `: comment` lines; the
        // client's 20 s watchdog reconnects a silent stream). NEVER before the
        // resync's end frame: a conn dying mid-snapshot must not adopt R.
        outbox.markLive();
        markConnectionLive(connId);
      } catch (err) {
        console.warn(`[${proto2 ? 'sync' : 'events'}] snapshot error:`, err);
        close('snapshot-error');
      }
      });
    },
    pull() {
      drainOutbox?.();
    },
    cancel() {
      if (ended) return;
      ended = true;
      recordClose('cancel');
      if (unregister) { unregister(); unregister = null; }
      disposeOutbox?.();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: OUTBOX_HWM }));

  return new Response(sseStream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/**
 * The proto-2 prologue (CLAUDE.md §9), synchronous: resume from the ring when
 * it covers `since` for this focus, else an explicit resync. Throws on any
 * failure (the caller closes the stream before its end frame).
 */
function writeSyncPrologue(o: {
  since: SyncRev | null;
  focus: string | null;
  push: (chunk: Uint8Array) => void;
  sendNow: (ev: SyncControlFrame | Record<string, unknown>) => void;
}): void {
  const E = busEpoch();
  const bid = buildId();
  let reason: ResyncReason;
  if (!o.since) reason = 'first';
  else if (o.since.epoch !== E) reason = 'epoch';
  else if (o.since.rev > currentRev().rev) reason = 'future';
  else {
    // Replay and live routing share ONE filter (frameReaches): they can never
    // disagree on what this connection is owed.
    const lines = replayFrom(o.since.rev, (f) => frameReaches(f, o.focus), RESUME_MAX_BYTES);
    if (lines) {
      o.sendNow({
        type: 'sync_hello', proto: 2, mode: 'resume', epoch: E, rev: currentRev().rev,
        from: o.since.rev, buildId: bid,
      } satisfies SyncControlFrame);
      for (const chunk of lines) o.push(chunk);
      o.sendNow({ type: 'sync_replay_end', rev: currentRev().rev } satisfies SyncControlFrame);
      recordResume();
      return;
    }
    reason = o.since.rev < syncStats().oldestRev - 1 ? 'gap' : 'cap';
  }

  // Resync. Repair what expired, publish pending summary diffs (to the OTHER
  // connections — this one is not live yet), THEN stamp R: every frame ≤ R is
  // reflected by what follows (I1/I2), with no await in between.
  sweepExpiredInteractions();
  flushSummaries();
  const sessions = reconcileAllSummaries();
  const R = currentRev();
  o.sendNow({
    type: 'sync_hello', proto: 2, mode: 'resync', reason, epoch: R.epoch, rev: R.rev, buildId: bid,
  } satisfies SyncControlFrame);
  o.sendNow({ type: 'sync_summaries', sessions } satisfies SyncControlFrame);
  o.sendNow({
    type: 'sync_vps',
    // `id` is not a runtime key (§14.52): the snapshot keeps it beside them.
    vps: listVpsRuntimeSnapshots().map((v) => ({
      id: v.id, ...pickVpsRuntimeFields(v as unknown as Record<string, unknown>),
    }) as VpsRuntimeSnapshot),
  } satisfies SyncControlFrame);
  o.sendNow({
    type: 'sync_installs',
    running: listInstalls().filter((i) => i.status === 'running').map((i) => ({
      installId: i.id, vpsId: i.vpsId, vpsName: i.vpsName, status: 'running' as const,
    })),
  } satisfies SyncControlFrame);
  o.sendNow({ type: 'model_notices', notices: getModelNotices() });
  o.push(new TextEncoder().encode(`id: ${R.epoch}.${R.rev}\ndata: ${JSON.stringify({
    type: 'sync_snapshot_end', rev: R.rev,
  } satisfies SyncControlFrame)}\n\n`));
  recordResync(reason);
}
