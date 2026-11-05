// Prompt cache: a provider keeps a request's prompt PREFIX for a while, and a
// later request that re-sends it reads it at a fraction of the input price.
// Two facts, written by the hub and read by the browser:
//
//  - PromptCacheState (agentSessions.prompt_cache): the session's LAST request
//    — its prompt size and when the provider drops it. The countdown is the
//    browser's own clock; nothing polls.
//  - TurnLedger (session_messages.turn_usage, on the turn's FINAL assistant
//    row): what that turn's input actually was — read from the cache, written
//    to it, uncached — counted per API request by the agent.
//
// A turn is several requests (one per tool call), each re-reading the whole
// prefix, so a cold turn is not 0 % cached: its FIRST request misses and
// rewrites the prefix, the next ones read what it just wrote. The miss count
// and the relative cost show that; the percentage alone hides it.
//
// Browser-safe: no server import.
import { PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';

/** Below this, a cold cache costs too little to mention: the UI stays quiet. */
export const BIG_PROMPT_TOKENS = 100_000;

export type PromptCacheState = {
  /** ms: start of the last API request that read or wrote the prefix. */
  at: number;
  /** ms: when the provider drops it, unless a request reads it first. */
  expiresAt: number;
  ttlS: number;
  /** Prompt size of that request = what the next message re-reads. */
  promptTokens: number;
  /** The TTL is an estimate (the provider reports none): shown with "≈". */
  approx?: boolean;
  /** Selected model and account when it was written. Caches are per model
   *  and per organisation: a session switched since then starts cold. */
  model?: string | null;
  account?: string | null;
};

export type CachePhase = 'live' | 'warm' | 'cold' | 'small';

export type CacheReading = {
  /** live = a turn runs (each request refreshes it); small = cold but too
   *  small to matter. */
  phase: CachePhase;
  /** Warm quarter of the TTL, 4 = fresh. Live reads 4. */
  level: 1 | 2 | 3 | 4;
  /** Remaining fraction of the TTL, 0..1. */
  frac: number;
  remainingMs: number;
  expiresAt: number;
  reason: 'expired' | 'model' | 'account' | null;
  promptTokens: number;
  ttlS: number;
  approx: boolean;
};

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parsePromptCache(raw: unknown): PromptCacheState | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const at = finite(o.at), expiresAt = finite(o.expiresAt), ttlS = finite(o.ttlS), promptTokens = finite(o.promptTokens);
  if (at == null || expiresAt == null || ttlS == null || ttlS <= 0 || promptTokens == null) return null;
  return {
    at, expiresAt, ttlS, promptTokens,
    ...(o.approx === true ? { approx: true } : {}),
    ...(typeof o.model === 'string' || o.model === null ? { model: o.model as string | null } : {}),
    ...(typeof o.account === 'string' || o.account === null ? { account: o.account as string | null } : {}),
  };
}

/** The cache as of `now`. `model`/`account` = the session's CURRENT selection
 *  (a switch since the write means the next request starts cold). */
export function cacheReading(
  pc: PromptCacheState | null | undefined,
  ctx: { now: number; busy?: boolean; model?: string | null; account?: string | null },
): CacheReading | null {
  if (!pc || !(pc.ttlS > 0)) return null;
  const ttlMs = pc.ttlS * 1000;
  const base = { expiresAt: pc.expiresAt, promptTokens: pc.promptTokens, ttlS: pc.ttlS, approx: !!pc.approx };
  if (ctx.busy) return { ...base, phase: 'live', level: 4, frac: 1, remainingMs: ttlMs, reason: null };
  const switched: CacheReading['reason'] =
    pc.model != null && ctx.model != null && pc.model !== ctx.model ? 'model'
      : pc.account !== undefined && ctx.account !== undefined && (pc.account ?? null) !== (ctx.account ?? null) ? 'account'
        : null;
  const remainingMs = pc.expiresAt - ctx.now;
  if (switched || remainingMs <= 0) {
    return {
      ...base, phase: pc.promptTokens >= BIG_PROMPT_TOKENS ? 'cold' : 'small',
      level: 1, frac: 0, remainingMs: 0, reason: switched ?? 'expired',
    };
  }
  const frac = Math.max(0, Math.min(1, remainingMs / ttlMs));
  const level = frac > 0.75 ? 4 : frac > 0.5 ? 3 : frac > 0.25 ? 2 : 1;
  return { ...base, phase: 'warm', level, frac, remainingMs, reason: null };
}

export function isCacheWarm(r: CacheReading | null | undefined): boolean {
  return r?.phase === 'warm' || r?.phase === 'live';
}

/** Does this state still need a ticking clock (warm, or just expired)? */
export function cacheNeedsClock(pc: PromptCacheState | null | undefined, now: number): boolean {
  return !!pc && pc.expiresAt > now - 60_000;
}

/** THE colour of a reading: hot (attention) cooling to cold (info) over the
 *  TTL, continuous inside each icon level. Theme tokens only (§14.99). */
export function cacheHeat(r: CacheReading): string {
  if (r.phase === 'cold') return 'var(--info)';
  if (r.phase === 'small') return 'var(--text-faint)';
  const pct = Math.round(22 + 78 * r.frac);
  return `color-mix(in oklab, var(--attention) ${pct}%, var(--info))`;
}

// ── Turn ledger ─────────────────────────────────────────────────────────────

export type TurnLedger = {
  /** Input tokens read from the cache, written to it, and neither. */
  read: number;
  write: number;
  uncached: number;
  out: number;
  /** API requests of the turn (main thread), those that read the prefix, and
   *  those that missed it and rewrote it (`missWrite` tokens). Absent from
   *  agents too old to count them. */
  requests?: number;
  hits?: number;
  misses?: number;
  missWrite?: number;
  /** Wall time of the turn as the provider measured it, and the part spent in
   *  the model API (Claude only). */
  durMs?: number;
  apiMs?: number;
  /** Tool calls the turn made (hub-counted from its rows). */
  tools?: number;
  ttlS?: number | null;
  /** Price multipliers vs plain input used for the relative cost. */
  readX?: number | null;
  writeX?: number | null;
  costUsd?: number | null;
  /** Prompt size of the turn's last request. */
  promptTokens?: number;
};

export function parseTurnLedger(raw: unknown): TurnLedger | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const read = finite(o.read), write = finite(o.write), uncached = finite(o.uncached), out = finite(o.out);
  if (read == null || write == null || uncached == null || out == null) return null;
  const opt = (k: string) => { const n = finite(o[k]); return n == null ? {} : { [k]: n }; };
  return {
    read, write, uncached, out,
    ...opt('requests'), ...opt('hits'), ...opt('misses'), ...opt('missWrite'),
    ...opt('durMs'), ...opt('apiMs'), ...opt('tools'), ...opt('ttlS'), ...opt('readX'), ...opt('writeX'),
    ...opt('costUsd'), ...opt('promptTokens'),
  } as TurnLedger;
}

export function ledgerInput(l: TurnLedger): number {
  return l.read + l.write + l.uncached;
}

/** Share of the turn's input read from the cache, 0..100; null without input. */
export function ledgerCachedPct(l: TurnLedger): number | null {
  const input = ledgerInput(l);
  return input > 0 ? Math.round((l.read / input) * 100) : null;
}

/** What the input cost relative to the same tokens at full price (1 = no
 *  cache at all); null when the multipliers are unknown. */
export function ledgerRelativeCost(l: TurnLedger): number | null {
  const input = ledgerInput(l);
  if (!(input > 0) || l.readX == null || l.writeX == null) return null;
  return (l.read * l.readX + l.write * l.writeX + l.uncached) / input;
}

/** The same turn had every request hit (the missed rewrites read instead):
 *  "≈ N× a warm turn" divides by this. */
export function ledgerWarmCost(l: TurnLedger): number | null {
  const input = ledgerInput(l);
  if (!(input > 0) || l.readX == null || l.writeX == null) return null;
  const missed = Math.min(l.write, l.missWrite ?? 0);
  return ((l.read + missed) * l.readX + (l.write - missed) * l.writeX + l.uncached) / input;
}

/** The agent's per-turn cache counters (`usage.turn_cache`, agent ≥ 0.121). */
export type AgentTurnCache = {
  requests?: number; hits?: number; misses?: number; miss_write_tokens?: number;
  read_tokens?: number; write_tokens?: number; uncached_tokens?: number;
  output_tokens?: number | null;
  ttl_s?: number | null; last_request_at?: number | null; last_prompt_tokens?: number;
};

type FinalUsage = {
  output_tokens?: number; input_tokens?: number;
  cache_read_tokens?: number; cache_write_tokens?: number;
  duration_ms?: number; duration_api_ms?: number | null; cost_usd?: number | null;
  turn_cache?: AgentTurnCache | null;
};

/** The ledger of a `usage final:true` frame; null when the backend reports no
 *  usable cache counters (registry `promptCache: null`, or an old agent whose
 *  flat fields do not follow the uncached-input convention). */
export function ledgerFromUsage(
  provider: SessionProvider, ev: FinalUsage, opts: { model: string | null; ttlS: number | null; tools?: number | null },
): TurnLedger | null {
  const pc = PROVIDERS[provider].promptCache;
  if (!pc) return null;
  const tc = ev.turn_cache;
  const n = (v: unknown) => finite(v) ?? 0;
  let ledger: TurnLedger;
  if (tc && n(tc.requests) > 0) {
    ledger = {
      read: n(tc.read_tokens), write: n(tc.write_tokens), uncached: n(tc.uncached_tokens),
      out: finite(tc.output_tokens) ?? n(ev.output_tokens),
      requests: n(tc.requests), hits: n(tc.hits), misses: n(tc.misses), missWrite: n(tc.miss_write_tokens),
      promptTokens: n(tc.last_prompt_tokens),
    };
  } else if (pc.inputExcludesCache) {
    ledger = {
      read: n(ev.cache_read_tokens), write: n(ev.cache_write_tokens), uncached: n(ev.input_tokens),
      out: n(ev.output_tokens),
    };
  } else {
    return null;
  }
  if (ledgerInput(ledger) <= 0) return null;
  const ttlS = finite(tc?.ttl_s) ?? opts.ttlS;
  const x = pc.multipliers(opts.model, ttlS ?? pc.defaultTtlS);
  return {
    ...ledger,
    ...(finite(ev.duration_ms) ? { durMs: n(ev.duration_ms) } : {}),
    ...(finite(ev.duration_api_ms) ? { apiMs: n(ev.duration_api_ms) } : {}),
    ...(finite(opts.tools) != null ? { tools: opts.tools as number } : {}),
    ttlS: ttlS ?? null,
    readX: x.read, writeX: x.write,
    ...(finite(ev.cost_usd) != null ? { costUsd: ev.cost_usd as number } : {}),
  };
}

/** The session state a `usage final:true` frame leaves; null when the agent
 *  did not report the turn's last request. */
export function cacheStateFromUsage(
  provider: SessionProvider, tc: AgentTurnCache | null | undefined,
  opts: { previousTtlS: number | null; model: string | null; account: string | null },
): PromptCacheState | null {
  const pc = PROVIDERS[provider].promptCache;
  const at = finite(tc?.last_request_at);
  if (!pc || !tc || at == null || at <= 0) return null;
  const reported = finite(tc.ttl_s);
  const ttlS = reported ?? pc.ttlS ?? opts.previousTtlS ?? pc.defaultTtlS;
  return {
    at, expiresAt: at + ttlS * 1000, ttlS,
    promptTokens: finite(tc.last_prompt_tokens) ?? 0,
    ...(reported == null && pc.approx ? { approx: true } : {}),
    model: opts.model, account: opts.account,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmtTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** "48 min", "1 h 05", "12 s". */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m / 60} h`;
}

/** Compact countdown for a badge: "48m", "1h05". */
export function fmtSpanShort(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

/** A turn duration: "8.4s", "42s", "3m12s". */
export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The tooltip lines of a reading, ONE FACT PER LINE (tooltipText.ts). */
export function cacheTipLines(r: CacheReading): string[] {
  const ax = r.approx ? '≈' : '';
  const size = `${fmtTokens(r.promptTokens)} tokens of context`;
  if (r.phase === 'live') return ['Prompt cache live — the running turn keeps it warm', size];
  if (r.phase === 'warm') {
    return [
      `Prompt cache warm · ${ax}${fmtSpan(r.remainingMs)} left`,
      `Until ${ax}${fmtClock(r.expiresAt)}`,
      size,
      'The next message reads it from the cache',
    ];
  }
  const why = r.reason === 'model' ? 'Prompt cache cold · the model changed since'
    : r.reason === 'account' ? 'Prompt cache cold · the account changed since'
      : `Prompt cache ${r.approx ? 'probably ' : ''}cold since ${fmtClock(r.expiresAt)}`;
  return [why, size, r.phase === 'cold' ? 'The next message re-reads it at full price' : 'Small context: re-reading it costs little'];
}
