'use client';
import { api } from '@/lib/api';
import type { AgentSessionDetailResponse, AgentSessionMessageWindow } from '@/lib/types/api';
import type { TranscriptView } from '@/lib/transcriptRows';

// Module-level cache for session detail/messages. HubPanel prefetches the
// sidebar sessions on mount → switching between sessions is instant via
// `<SessionView key={id}>` (re-mount, but the hook reads the cache on
// mount).
//
// Originally `app/m/chatCache.ts` (mobile-only); promoted here and renamed when
// the UI was unified into the single responsive `/` (CLAUDE.md §11).
//
// Entries are keyed `${id}|${view}` (a conversation-view window is another
// answer than the full one, CLAUDE.md §14.25) and carry the answer's `sync`
// stamp. The transcript paints a cached entry only before its first fresh
// snapshot: the entry is older, so the fresh answer always wins (§14.107).

type CacheEntry = {
  data: AgentSessionDetailResponse;
  fetchedAt: number;
  approxBytes: number;
};

// One shared request per session and view. `holders` counts the callers that passed an
// AbortSignal and have not aborted; a caller without one pins the request.
// The request is cancelled only when its LAST holder leaves — a view that
// unmounts stops competing for bandwidth with the session opened next.
type Inflight = {
  promise: Promise<AgentSessionDetailResponse>;
  controller: AbortController;
  holders: number;
  pinned: boolean;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Inflight>();

// A cached detail response contains parsed message objects and strings, whose
// actual JS heap cost is several times their wire size. Keep the hot working
// set deliberately small: session switching remains instant for recent tabs,
// while a long-lived browser can no longer retain every transcript forever.
const MAX_ENTRIES = 5;
const MAX_APPROX_BYTES = 24 * 1024 * 1024;

// An entry is "fresh" for STALE_MS. Beyond that, we refetch (but we
// return the cache first to render instantly; the caller re-applies
// when the fresh data arrives).
const STALE_MS = 15_000;

function estimateBytes(data: AgentSessionDetailResponse): number {
  let n = 2_048;
  for (const m of data.messages ?? []) {
    n += 256 + (typeof m.content === 'string' ? m.content.length * 2 : 0);
  }
  return n;
}

// What we STORE, as opposed to what we return to the caller. `streamingText` is
// the hub's unflushed assistant accumulation — live state, not history: the
// moment the turn moves on it describes nothing. Cached, it outlived its turn
// and got replayed into the preview bubble at the next mount, pinning half a
// sentence under a transcript that had long since finished
// (app/streamingPreview.ts, CLAUDE.md §14.105). The fresh response the caller
// receives keeps it, so opening a session that IS streaming still previews it.
// `streamingThinking` (a delta provider's open reasoning block), the running
// tools' output (`streamingToolOutput`) and the reopened row the text extends
// (`streamingExtends`) and a running compaction (`liveCompacting`) are the
// same kind of live state and are blanked the same way.
function withoutLiveState(data: AgentSessionDetailResponse): AgentSessionDetailResponse {
  if (!data.streamingText && !data.streamingThinking && !data.streamingToolOutput?.length
      && !data.streamingExtends && !data.liveCompacting) return data;
  return {
    ...data,
    streamingText: '',
    ...(data.liveCompacting ? { liveCompacting: false } : {}),
    ...(data.streamingThinking ? { streamingThinking: '', streamingThinkingTsMs: null } : {}),
    ...(data.streamingToolOutput?.length ? { streamingToolOutput: [] } : {}),
    ...(data.streamingExtends ? { streamingExtends: null } : {}),
  };
}

const keyOf = (id: string, view: TranscriptView = 'full'): string => `${id}|${view}`;

function touch(id: string, entry: CacheEntry): void {
  cache.delete(id);
  cache.set(id, entry);
}

function prune(): void {
  let total = 0;
  for (const e of cache.values()) total += e.approxBytes;
  while (cache.size > MAX_ENTRIES || total > MAX_APPROX_BYTES) {
    const oldest = cache.entries().next().value as [string, CacheEntry] | undefined;
    if (!oldest) break;
    cache.delete(oldest[0]);
    total -= oldest[1].approxBytes;
  }
}

export function getCached(id: string, view: TranscriptView = 'full'): AgentSessionDetailResponse | undefined {
  const key = keyOf(id, view);
  const e = cache.get(key);
  if (!e) return undefined;
  touch(key, e);
  return e.data;
}

export function isCacheFresh(id: string, view: TranscriptView = 'full'): boolean {
  const e = cache.get(keyOf(id, view));
  return !!e && (Date.now() - e.fetchedAt < STALE_MS);
}

function hold(id: string, req: Inflight, signal?: AbortSignal): void {
  if (!signal) { req.pinned = true; return; }
  if (signal.aborted) return;
  req.holders += 1;
  const onAbort = () => {
    req.holders -= 1;
    if (req.pinned || req.holders > 0) return;
    // Forget it NOW, not in the settle handler: a remount in the same tick
    // must start a fresh request instead of joining the cancelled one.
    if (inflight.get(id) === req) inflight.delete(id);
    req.controller.abort(new DOMException('session view closed', 'AbortError'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  // The signal outlives the request (it is the VIEW's lifetime): a listener
  // left behind would pin every response of every reload in memory.
  const release = () => signal.removeEventListener('abort', onAbort);
  req.promise.then(release, release);
}

export type FetchSessionOptions = {
  /** Transcript view (default `full`). */
  view?: TranscriptView;
  /** Bypass a fresh entry. */
  force?: boolean;
  /** This caller no longer needs the answer (see `Inflight`). */
  signal?: AbortSignal;
  /** Apply this SSE connection's focus atomically inside the GET (the
   *  transcript's window request). Such a request never joins another one
   *  and is never joined: its answer is tied to that focus. */
  focus?: { conn: string; focusSeq: number };
};

/**
 * Fetch + cache a session window. Dedups concurrent calls (same id + view,
 * no `focus`). If a fresh entry exists and `force` is false → return it.
 */
export async function fetchAndCache(
  id: string,
  opts: FetchSessionOptions = {},
): Promise<AgentSessionDetailResponse> {
  const { view = 'full', force = false, signal, focus } = opts;
  if (signal?.aborted) throw new DOMException('session view closed', 'AbortError');
  const key = keyOf(id, view);
  if (!force && !focus) {
    const e = cache.get(key);
    if (e && Date.now() - e.fetchedAt < STALE_MS) return e.data;
  }
  if (!focus) {
    const existing = inflight.get(key);
    if (existing) {
      hold(key, existing, signal);
      return existing.promise;
    }
  }
  const controller = new AbortController();
  const req: Inflight = {
    promise: undefined as unknown as Promise<AgentSessionDetailResponse>,
    controller, holders: 0, pinned: false,
  };
  req.promise = (async () => {
    try {
      const data = await api.getAgentSession(id, controller.signal, {
        view, ...(focus ? { conn: focus.conn, focusSeq: focus.focusSeq } : {}),
      });
      // Never let an older answer replace a newer stored one (a request
      // without focus may land after the focused one).
      const prev = cache.get(key)?.data.sync;
      const next = data?.sync;
      if (!(prev && next && (next.epoch < prev.epoch || (next.epoch === prev.epoch && next.rev < prev.rev)))) {
        const entry = {
          data: withoutLiveState(data), fetchedAt: Date.now(), approxBytes: estimateBytes(data),
        };
        touch(key, entry);
        prune();
      }
      return data;
    } finally {
      if (inflight.get(key) === req) inflight.delete(key);
    }
  })();
  if (!focus) inflight.set(key, req);
  hold(key, req, signal);
  return req.promise;
}

/** Forget every view of a session. */
export function invalidate(id: string): void {
  cache.delete(keyOf(id, 'full'));
  cache.delete(keyOf(id, 'conversation'));
}

/**
 * Extend a session's cache entry with a window of older messages
 * (the result of a loadOlderMessages). Preserves the position
 * in history across session switches / component remounts.
 *
 * No error if the entry doesn't exist (no-op) — the caller may still
 * have fresh data locally. Note: extended pages are NOT preserved
 * across a `fetchAndCache({force: true})` — a fresh window resets the entry
 * to the latest window. The trade-off: simplicity > absolute
 * scroll fidelity after long absence.
 */
export function extendWithOlder(id: string, older: AgentSessionMessageWindow, view: TranscriptView = 'full'): void {
  const key = keyOf(id, view);
  const e = cache.get(key);
  if (!e) return;
  // The merge keeps asc order by id. The older messages come, by definition,
  // before the current ones (smaller ids). We keep hasMore/oldestChatId
  // from the last loaded page (the oldest).
  cache.set(key, {
    ...e,
    data: {
      ...e.data,
      messages: [...older.messages, ...e.data.messages],
      hasMore: older.hasMore,
      oldestChatId: older.oldestChatId,
    },
    approxBytes: e.approxBytes + estimateBytes({ ...e.data, messages: older.messages } as AgentSessionDetailResponse),
    // fetchedAt unchanged: we didn't refresh the session, just extended it.
  });
  prune();
}
