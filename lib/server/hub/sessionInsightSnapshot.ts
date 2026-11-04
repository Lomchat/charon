import 'server-only';

/**
 * Non-blocking snapshots for the read-only session inspector.
 *
 * Context, MCP and provider inventories are control-plane RPCs. Some Codex
 * app-server versions can take tens of seconds to answer one while a large
 * thread is busy. Awaiting those RPCs from the browser used one HTTP/1.1
 * connection per panel section; focus/remount bursts could therefore occupy
 * every browser connection (the SSE already owns one) and leave chat input
 * queued until its client timeout fired.
 *
 * A cold read starts exactly one background refresh and immediately returns a
 * loading envelope. Further readers share it, including other browser tabs.
 * Different inspector resources are serialized per session so this low-value
 * telemetry can never flood the provider transport. Last-good data remains
 * visible while it refreshes.
 */

export type SessionInsightSnapshotMeta = {
  state: 'loading' | 'fresh' | 'refreshing' | 'stale' | 'error';
  updated_at?: number;
  retry_after_ms?: number;
  last_error?: string;
};

type JsonObject = Record<string, any>;
type Entry = {
  good?: JsonObject;
  goodAt: number;
  failure?: JsonObject;
  lastAttemptAt: number;
  lastAccessAt: number;
  inflight?: Promise<void>;
};

type SnapshotGlobals = {
  __charonSessionInsightSnapshots?: Map<string, Entry>;
  __charonSessionInsightQueues?: Map<string, Promise<void>>;
};

const globals = globalThis as unknown as SnapshotGlobals;
const snapshots = (globals.__charonSessionInsightSnapshots ??= new Map());
const sessionQueues = (globals.__charonSessionInsightQueues ??= new Map());

const MAX_ENTRIES = 512;
const EVICT_AFTER_MS = 10 * 60_000;
const DEFAULT_MAX_AGE_MS = 30_000;
const DEFAULT_FAILURE_RETRY_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

function snapshotKey(sessionId: string, resource: string): string {
  return `${sessionId}\u0000${resource}`;
}

function errorText(value: JsonObject | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.error ?? value.message;
  return typeof text === 'string' && text ? text.slice(0, 300) : undefined;
}

function withMeta(value: JsonObject, meta: SessionInsightSnapshotMeta): JsonObject {
  return { ...value, _snapshot: meta };
}

function failure(error: unknown): JsonObject {
  return {
    ok: false,
    reason: 'error',
    error: String((error as Error)?.message || error).slice(0, 300),
  };
}

function prune(now: number): void {
  if (snapshots.size <= MAX_ENTRIES) return;
  for (const [key, entry] of snapshots) {
    if (!entry.inflight && now - entry.lastAccessAt > EVICT_AFTER_MS) snapshots.delete(key);
  }
  if (snapshots.size <= MAX_ENTRIES) return;
  const evictable = [...snapshots.entries()]
    .filter(([, entry]) => !entry.inflight)
    .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);
  for (const [key] of evictable) {
    snapshots.delete(key);
    if (snapshots.size <= MAX_ENTRIES) break;
  }
}

function startRefresh(
  sessionId: string,
  entry: Entry,
  loader: () => Promise<JsonObject>,
): void {
  if (entry.inflight) return;

  // One low-priority inspector RPC at a time per session. This queue is
  // deliberately separate from chat input: input still goes straight to the
  // AgentClient and is never placed behind the remaining inspector resources.
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  let work: Promise<void>;
  work = previous
    .catch(() => {})
    .then(async () => {
      let result: JsonObject;
      try {
        const loaded = await loader();
        result = loaded && typeof loaded === 'object'
          ? loaded
          : failure('inspector RPC returned a non-object result');
      } catch (error) {
        result = failure(error);
      }

      const now = Date.now();
      entry.lastAttemptAt = now;
      entry.lastAccessAt = now;
      if (result.ok === false) {
        // A transient outage must not erase the last useful snapshot.
        entry.failure = result;
      } else {
        entry.good = result;
        entry.goodAt = now;
        entry.failure = undefined;
      }
    })
    .finally(() => {
      if (entry.inflight === work) entry.inflight = undefined;
      if (sessionQueues.get(sessionId) === work) sessionQueues.delete(sessionId);
    });

  entry.inflight = work;
  sessionQueues.set(sessionId, work);
  // The cache and queue retain the promise. Attaching a terminal catch keeps a
  // future loader regression from becoming an unhandled rejection even though
  // the normal path above already converts errors into envelopes.
  void work.catch(() => {});
}

export function readSessionInsightSnapshot(
  sessionId: string,
  resource: string,
  loader: () => Promise<JsonObject>,
  options: {
    force?: boolean;
    maxAgeMs?: number;
    failureRetryMs?: number;
  } = {},
): JsonObject {
  const now = Date.now();
  const key = snapshotKey(sessionId, resource);
  let entry = snapshots.get(key);
  if (!entry) {
    entry = { goodAt: 0, lastAttemptAt: 0, lastAccessAt: now };
    snapshots.set(key, entry);
  }
  entry.lastAccessAt = now;
  prune(now);

  const maxAgeMs = Math.max(0, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  const failureRetryMs = Math.max(0, options.failureRetryMs ?? DEFAULT_FAILURE_RETRY_MS);
  const goodFresh = !!entry.good && now - entry.goodAt < maxAgeMs;
  const failureCoolingDown = !!entry.failure
    && now - entry.lastAttemptAt < failureRetryMs;

  if (!entry.inflight && (options.force || (!goodFresh && !failureCoolingDown))) {
    startRefresh(sessionId, entry, loader);
  }

  if (entry.good) {
    if (entry.inflight) {
      return withMeta(entry.good, {
        state: 'refreshing',
        updated_at: entry.goodAt,
        retry_after_ms: DEFAULT_RETRY_AFTER_MS,
      });
    }
    if (!goodFresh) {
      const remaining = Math.max(
        DEFAULT_RETRY_AFTER_MS,
        failureRetryMs - Math.max(0, now - entry.lastAttemptAt),
      );
      return withMeta(entry.good, {
        state: 'stale',
        updated_at: entry.goodAt,
        retry_after_ms: remaining,
        last_error: errorText(entry.failure),
      });
    }
    return withMeta(entry.good, { state: 'fresh', updated_at: entry.goodAt });
  }

  if (entry.inflight) {
    return {
      ok: false,
      reason: 'loading',
      _snapshot: { state: 'loading', retry_after_ms: DEFAULT_RETRY_AFTER_MS },
    };
  }

  const failed = entry.failure ?? failure('inspector snapshot unavailable');
  return withMeta(failed, {
    state: 'error',
    updated_at: entry.lastAttemptAt || undefined,
  });
}

/** Drop one resource after a mutation, or every inspector value for a session. */
export function invalidateSessionInsightSnapshot(sessionId: string, resource?: string): void {
  if (resource) {
    snapshots.delete(snapshotKey(sessionId, resource));
    return;
  }
  const prefix = `${sessionId}\u0000`;
  for (const key of snapshots.keys()) if (key.startsWith(prefix)) snapshots.delete(key);
}
