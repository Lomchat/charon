import 'server-only';

/**
 * What every session is doing right now — the desk's live feed (app/desk).
 *
 * Tool calls, thinking and assistant text are FOCUS-routed (§14.16): a page
 * that watches the whole fleet receives none of them. This folds the frames a
 * stream already publishes into one small state per session and re-publishes
 * it LOW, rate-capped, and ONLY while a desk is watching (`markWatched`, set
 * by the snapshot GET the desk polls): nobody on the desk ⇒ no frame.
 *
 * In memory and short-lived on purpose, like fileActivity.ts: a liveness
 * light, not a record. Never fed from a replay.
 */
import {
  isStateBeat, oneLine, tailLine, toolDetail, type SessionActivity,
} from '@/lib/sessionActivity';

type Entry = {
  /** The latest STATE beat (what a freshly opened desk shows). */
  current: SessionActivity | null;
  turnStartedAt: number | null;
  turnTools: number;
  /** Text being streamed (say/think), kept as a tail. */
  tail: string;
  tailBeat: 'say' | 'think' | null;
  /** Last frame SENT per lane (rate caps). */
  sentToolAt: number;
  sentTextAt: number;
};

type State = { bySession: Map<string, Entry>; watchedUntil: number };
const g = globalThis as unknown as { __charonSessionActivity?: State };
const state: State = (g.__charonSessionActivity ??= { bySession: new Map(), watchedUntil: 0 });

/** A desk polls its snapshot every minute: frames flow for a bit longer. */
const WATCH_TTL_MS = 150_000;
const TOOL_MIN_GAP_MS = 200;
const TEXT_MIN_GAP_MS = 1_800;
const TAIL_MAX = 400;
/** A state nobody refreshed for this long is no longer "now". */
const STALE_MS = 15 * 60_000;

function entryFor(sessionId: string): Entry {
  let e = state.bySession.get(sessionId);
  if (!e) {
    e = { current: null, turnStartedAt: null, turnTools: 0, tail: '', tailBeat: null, sentToolAt: 0, sentTextAt: 0 };
    state.bySession.set(sessionId, e);
  }
  return e;
}

export function markWatched(now = Date.now()): void {
  state.watchedUntil = now + WATCH_TTL_MS;
}

function watched(now: number): boolean {
  return now < state.watchedUntil;
}

type Frame = { type: string; [key: string]: unknown };

/**
 * Fold one LIVE frame of a session. Returns the activity to publish, or null
 * (not an activity, rate-capped, or nobody watching — the state is kept
 * either way, so the next snapshot is right).
 */
export function noteSessionFrame(sessionId: string, ev: Frame, now = Date.now()): SessionActivity | null {
  const beat = (partial: Omit<SessionActivity, 'at' | 'turnStartedAt' | 'turnTools'>, e: Entry): SessionActivity => ({
    ...partial, at: now, turnStartedAt: e.turnStartedAt, turnTools: e.turnTools,
  });
  const open = (e: Entry) => { e.turnStartedAt ??= now; };
  const send = (a: SessionActivity, e: Entry): SessionActivity | null => {
    if (isStateBeat(a.beat)) e.current = a;
    return watched(now) ? a : null;
  };

  switch (ev.type) {
    case 'tool_use': {
      const e = entryFor(sessionId);
      open(e);
      e.turnTools = typeof ev.turnTools === 'number' ? ev.turnTools : e.turnTools + 1;
      e.tail = ''; e.tailBeat = null;
      const a = beat({ beat: 'tool', tool: String(ev.name ?? ''), detail: toolDetail(ev.input) }, e);
      e.current = a;
      if (now - e.sentToolAt < TOOL_MIN_GAP_MS) return null;
      e.sentToolAt = now;
      return send(a, e);
    }
    case 'assistant_text':
    case 'thinking': {
      const lane = ev.type === 'thinking' ? 'think' as const : 'say' as const;
      const text = String((lane === 'think' ? ev.text : ev.delta) ?? '');
      if (!text) return null;
      const e = entryFor(sessionId);
      open(e);
      const first = e.tailBeat !== lane;
      e.tail = first ? text.slice(-TAIL_MAX) : `${e.tail}${text}`.slice(-TAIL_MAX);
      e.tailBeat = lane;
      // Streaming is the hot path (a frame every 25 ms): between two sends,
      // only the tail moves — the snapshot reads its line off it.
      if ((!first && now - e.sentTextAt < TEXT_MIN_GAP_MS) || !watched(now)) {
        e.current = beat({ beat: lane }, e);
        return null;
      }
      e.sentTextAt = now;
      return send(beat({ beat: lane, detail: tailLine(e.tail) }, e), e);
    }
    case 'compaction': {
      const e = entryFor(sessionId);
      return send(beat({ beat: 'compact' }, e), e);
    }
    case 'user_echo': {
      const e = entryFor(sessionId);
      // A message typed mid-turn steers the turn; it does not restart it.
      if (e.turnStartedAt == null) { e.turnStartedAt = now; e.turnTools = 0; }
      return send(beat({ beat: 'prompt', detail: oneLine(String(ev.content ?? '')) }, e), e);
    }
    case 'external_message': {
      const e = entryFor(sessionId);
      if (e.turnStartedAt == null) { e.turnStartedAt = now; e.turnTools = 0; }
      return send(beat({
        beat: 'peer_in', detail: oneLine(String(ev.text ?? '')),
        ...(typeof ev.sourceSessionId === 'string' ? { peerSessionId: ev.sourceSessionId } : {}),
        ...(typeof ev.from === 'string' ? { peerHandle: ev.from } : {}),
      }, e), e);
    }
    case 'peer_message_status': {
      if (ev.status !== 'replied') return null;
      const e = entryFor(sessionId);
      return send(beat({
        beat: 'peer_reply', detail: oneLine(String(ev.text ?? '')),
        ...(typeof ev.targetSessionId === 'string' ? { peerSessionId: ev.targetSessionId } : {}),
        ...(typeof ev.target === 'string' ? { peerHandle: ev.target } : {}),
      }, e), e);
    }
    case 'bg_task': {
      if (ev.kind !== 'started') return null;
      const e = entryFor(sessionId);
      return send(beat({ beat: 'bg', detail: oneLine(String(ev.description ?? '')) }, e), e);
    }
    case 'stop': {
      const e = entryFor(sessionId);
      const failed = typeof ev.subtype === 'string' && ev.subtype !== '' && ev.subtype !== 'success';
      const a = beat({ beat: 'stop', ...(failed ? { failed: true } : {}) }, e);
      state.bySession.delete(sessionId);
      return watched(now) ? a : null;
    }
    case 'status': {
      // A session that left the live states is doing nothing.
      const status = String(ev.status ?? '');
      if (status === 'sleeping' || status === 'error' || status === 'killed') state.bySession.delete(sessionId);
      return null;
    }
    default:
      return null;
  }
}

/** Every session's current state (the desk's snapshot), pruned on the way. */
export function activitySnapshot(now = Date.now()): Record<string, SessionActivity> {
  const out: Record<string, SessionActivity> = {};
  for (const [id, e] of state.bySession) {
    if (!e.current) continue;
    if (now - e.current.at > STALE_MS) { state.bySession.delete(id); continue; }
    const streaming = e.current.beat === e.tailBeat && e.tail !== '';
    out[id] = {
      ...e.current, turnStartedAt: e.turnStartedAt, turnTools: e.turnTools,
      ...(streaming ? { detail: tailLine(e.tail) } : {}),
    };
  }
  return out;
}

export function dropSessionActivity(sessionId: string): void {
  state.bySession.delete(sessionId);
}
