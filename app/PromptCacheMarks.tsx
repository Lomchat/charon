'use client';

// The prompt-cache marks (lib/promptCache.ts): the I2 flame that empties over
// the TTL, the sidebar card mark, the context-row marker and the bubble-header
// ledger. Colour = `cacheHeat` (attention cooling to info, theme tokens only);
// shape = the TTL quarter, so four levels read apart at 12 px.
import React, { useId, useSyncExternalStore } from 'react';
import {
  cacheHeat, cacheReading, cacheTipLines, fmtDuration, fmtSpan, fmtSpanShort, fmtTokens,
  ledgerCachedPct, ledgerInput, ledgerRelativeCost, ledgerWarmCost,
  type CacheReading, type PromptCacheState, type TurnLedger,
} from '@/lib/promptCache';
import { showsTurnCost, type SessionProvider } from '@/lib/sessionCapabilities';
import { tipAttrs } from './tooltipText';

// ── Clock ───────────────────────────────────────────────────────────────────
// One shared 30 s interval, alive only while a warm (or just expired) cache is
// on screen. Server render and hydration read 0 = "unknown": nothing is drawn
// until the browser's own clock is in.

const TICK_MS = 30_000;
const IDLE = Number.MAX_SAFE_INTEGER;
let clockNow = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribeClock(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer) {
    clockNow = Date.now();
    timer = setInterval(() => {
      clockNow = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}
const noSubscribe = () => () => {};
const readClock = () => clockNow;
const readIdle = () => IDLE;
const readServer = () => 0;

/** "Now" for cache readings. Inactive (nothing warm): a far-future constant —
 *  every expired state reads the same, and nothing ticks. 0 during SSR. */
export function useCacheTick(active: boolean): number {
  return useSyncExternalStore(active ? subscribeClock : noSubscribe, active ? readClock : readIdle, readServer);
}

export function cacheClockActive(pc: PromptCacheState | null | undefined): boolean {
  return !!pc && pc.expiresAt > Date.now() - 60_000;
}

/** Statuses during which every request refreshes the cache. */
const LIVE_STATUSES = new Set(['thinking', 'starting']);

/** A session row's reading as of the shared clock; null = nothing to draw. */
export function useSessionCacheReading(s: {
  promptCache?: PromptCacheState | null; liveStatus?: string | null; status: string;
  model?: string | null; accountProfile?: string;
}): CacheReading | null {
  const now = useCacheTick(cacheClockActive(s.promptCache));
  if (!now) return null;
  return cacheReading(s.promptCache, {
    now, busy: LIVE_STATUSES.has(String(s.liveStatus ?? s.status)),
    model: s.model ?? null, account: s.accountProfile,
  });
}

// ── Icons ───────────────────────────────────────────────────────────────────

/** Bootstrap Icons `fire`, outer silhouette only (the I2 outline). */
const FIRE_OUTLINE = 'M8 16c3.314 0 6-2 6-5.5 0-1.5-.5-4-2.5-6 .25 1.5-1.25 2-1.25 2C11 4 9 .5 6 0c.357 2 .5 4-2 6-1.25 1-2 2.729-2 4.5C2 14 4.686 16 8 16';
/** Fill height per TTL quarter (viewBox units): 100 / 66 / 40 / 15 %. */
const FILL_H: Record<1 | 2 | 3 | 4, number> = { 4: 16.6, 3: 11, 2: 7, 1: 3.2 };

/** The flame that empties: outline + a fill clipped from the bottom. */
export function CacheFlame({ level, className }: { level: 1 | 2 | 3 | 4; className?: string }) {
  const id = `cf${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const h = FILL_H[level];
  return (
    <svg className={`cache-icon${className ? ` ${className}` : ''}`} viewBox="-0.7 -0.7 17.4 17.4" aria-hidden="true">
      <defs><clipPath id={id}><rect x={-1} y={16.3 - h} width={18} height={h + 1} /></clipPath></defs>
      <path d={FIRE_OUTLINE} fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <path d={FIRE_OUTLINE} fill="currentColor" clipPath={`url(#${id})`} />
    </svg>
  );
}

/** Bootstrap Icons `snow`, verbatim. */
export function IconSnow({ className }: { className?: string }) {
  return (
    <svg className={`cache-icon${className ? ` ${className}` : ''}`} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 16a.5.5 0 0 1-.5-.5v-1.293l-.646.647a.5.5 0 0 1-.707-.708L7.5 12.793V8.866l-3.4 1.963-.496 1.85a.5.5 0 1 1-.966-.26l.237-.882-1.12.646a.5.5 0 0 1-.5-.866l1.12-.646-.884-.237a.5.5 0 1 1 .26-.966l1.848.495L7 8 3.6 6.037l-1.85.495a.5.5 0 0 1-.258-.966l.883-.237-1.12-.646a.5.5 0 1 1 .5-.866l1.12.646-.237-.883a.5.5 0 1 1 .966-.258l.495 1.849L7.5 7.134V3.207L6.147 1.854a.5.5 0 1 1 .707-.708l.646.647V.5a.5.5 0 1 1 1 0v1.293l.647-.647a.5.5 0 1 1 .707.708L8.5 3.207v3.927l3.4-1.963.496-1.85a.5.5 0 1 1 .966.26l-.236.882 1.12-.646a.5.5 0 0 1 .5.866l-1.12.646.883.237a.5.5 0 1 1-.26.966l-1.848-.495L9 8l3.4 1.963 1.849-.495a.5.5 0 0 1 .259.966l-.883.237 1.12.646a.5.5 0 0 1-.5.866l-1.12-.646.236.883a.5.5 0 1 1-.966.258l-.495-1.849-3.4-1.963v3.927l1.353 1.353a.5.5 0 0 1-.707.708l-.647-.647V15.5a.5.5 0 0 1-.5.5z" />
    </svg>
  );
}

/** The symbol of a reading; null when a cold cache is too small to matter. */
export function CacheSymbol({ reading }: { reading: CacheReading }) {
  if (reading.phase === 'small') return null;
  if (reading.phase === 'cold') return <IconSnow />;
  return <CacheFlame level={reading.level} className={reading.phase === 'live' ? 'cache-live' : undefined} />;
}

// ── Sidebar card ────────────────────────────────────────────────────────────

/** The card mark: the symbol alone. Its tooltip is the card's (`cacheTipLines`
 *  joins the card's detail), so the empty title stays transparent. */
export function SessionCacheMark({ reading }: { reading: CacheReading | null }) {
  if (!reading || reading.phase === 'small') return null;
  return (
    <span className={`cs-cache cs-cache-${reading.phase}`} style={{ color: cacheHeat(reading) }} title="">
      <CacheSymbol reading={reading} />
    </span>
  );
}

/** The time on the card's details line: "48m left", "193k to re-read". */
export function sessionCacheFootText(reading: CacheReading | null): string | null {
  if (!reading || reading.phase === 'small') return null;
  if (reading.phase === 'live') return 'cache live';
  if (reading.phase === 'cold') return `${fmtTokens(reading.promptTokens)} to re-read`;
  return `cache ${reading.approx ? '≈' : ''}${fmtSpanShort(reading.remainingMs)}`;
}

// ── Context row (session header) ────────────────────────────────────────────

/** After the token count: the symbol + time left, "live" or "cold". */
export function CacheGaugeMark({ reading }: { reading: CacheReading | null }) {
  if (!reading || reading.phase === 'small') return null;
  const lines = cacheTipLines(reading);
  const text = reading.phase === 'live' ? 'live'
    : reading.phase === 'cold' ? 'cold'
      : `${reading.approx ? '≈' : ''}${fmtSpanShort(reading.remainingMs)}`;
  return (
    <span className={`bar-context-cache cs-cache-${reading.phase}`} style={{ color: cacheHeat(reading) }}
      title={lines[0]} data-tip-instant="" {...tipAttrs({ detail: lines.slice(1) })}>
      <CacheSymbol reading={reading} />{text}
    </span>
  );
}

// ── Bubble header ledger ────────────────────────────────────────────────────

/** "8% of full price", "0.4%": a relative cost that reads at a glance. */
function pctText(x: number): string {
  const p = x * 100;
  return p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
}

function ledgerTip(l: TurnLedger, provider: SessionProvider): { title: string; lines: string[] } {
  const pct = ledgerCachedPct(l);
  const misses = l.misses ?? 0;
  const rel = ledgerRelativeCost(l);
  const warm = ledgerWarmCost(l);
  const x = (v: number | null | undefined) => (v == null ? '' : ` (${v}×)`);
  const lines: (string | null)[] = [
    `Read from the cache: ${fmtTokens(l.read)} tokens${x(l.readX)}`,
    `Written to the cache: ${fmtTokens(l.write)} tokens${x(l.writeX)}`,
    `Uncached input: ${fmtTokens(l.uncached)} tokens`,
    `Output: ${fmtTokens(l.out)} tokens`,
    l.requests != null
      ? `${l.requests} request${l.requests === 1 ? '' : 's'} · ${l.hits ?? 0} hit${l.hits === 1 ? '' : 's'}`
        + (misses ? ` · ${misses} miss${misses === 1 ? '' : 'es'} (re-wrote ${fmtTokens(l.missWrite ?? 0)})` : '')
      : null,
    rel != null ? `Input cost: ${pctText(rel)} of full price` : null,
    rel != null && warm != null && misses > 0 && warm > 0 ? `≈ ${(rel / warm).toFixed(1)}× the input cost of a warm turn` : null,
    l.durMs != null ? `Duration: ${fmtDuration(l.durMs)} since the agent got the message` : null,
    l.apiMs != null ? `Model API time: ${fmtDuration(l.apiMs)}` : null,
    l.apiMs != null && l.durMs != null && l.durMs > l.apiMs ? `Tools and waiting: ${fmtDuration(l.durMs - l.apiMs)}` : null,
    l.apiMs != null && l.apiMs > 0 && l.out > 0 ? `Output speed: ${Math.round(l.out / (l.apiMs / 1000))} tokens/s` : null,
    l.promptTokens != null ? `Prompt at the end of the turn: ${fmtTokens(l.promptTokens)} tokens` : null,
    l.ttlS != null ? `Cache lifetime: ${fmtSpan(l.ttlS * 1000)}` : null,
    showsTurnCost(provider) && l.costUsd != null ? `Cost: $${l.costUsd < 0.1 ? l.costUsd.toFixed(3) : l.costUsd.toFixed(2)}` : null,
  ];
  const title = misses > 0 ? 'Turn input · the cache was cold'
    : pct != null ? `Turn input · ${pct}% from the prompt cache` : 'Turn input';
  return { title, lines: lines.filter((v): v is string => !!v) };
}

/** The turn's ledger, on its own line under the bubble header: mini-bar, %,
 *  tokens read, output, relative cost, duration — then every other detail.
 *  Wraps on a narrow bubble; the tooltip repeats it with labels. */
export function TurnLedgerLine({ ledger, provider }: { ledger: TurnLedger; provider: SessionProvider }) {
  const input = ledgerInput(ledger);
  if (!(input > 0)) return null;
  const pct = ledgerCachedPct(ledger);
  const rel = ledgerRelativeCost(ledger);
  const warm = ledgerWarmCost(ledger);
  const misses = ledger.misses ?? 0;
  const cold = misses > 0;
  const tip = ledgerTip(ledger, provider);
  const w = (n: number) => `${((n / input) * 100).toFixed(1)}%`;
  const items: (React.ReactNode | null)[] = [
    pct != null ? <span key="pct" className="turn-ledger-pct">{cold && <IconSnow />}{pct}%</span> : null,
    <span key="read">{fmtTokens(ledger.read)} read</span>,
    <span key="out">{fmtTokens(ledger.out)} out</span>,
    rel != null ? <span key="cost" className="turn-ledger-cost">cost {pctText(rel)}</span> : null,
    ledger.durMs != null ? <span key="dur">{fmtDuration(ledger.durMs)}</span> : null,
    <span key="write" className={cold ? 'turn-ledger-cold' : undefined}>{fmtTokens(ledger.write)} written</span>,
    <span key="uncached">{fmtTokens(ledger.uncached)} uncached</span>,
    ledger.requests != null
      ? <span key="hits">{ledger.hits ?? 0}/{ledger.requests} hit{ledger.requests === 1 ? '' : 's'}</span> : null,
    cold ? <span key="miss" className="turn-ledger-cold">{misses} miss · {fmtTokens(ledger.missWrite ?? 0)} rewritten</span> : null,
    cold && rel != null && warm != null && warm > 0
      ? <span key="warm" className="turn-ledger-cold">≈ {(rel / warm).toFixed(1)}× a warm turn</span> : null,
    ledger.apiMs != null ? <span key="api">API {fmtDuration(ledger.apiMs)}</span> : null,
    ledger.apiMs != null && ledger.durMs != null && ledger.durMs > ledger.apiMs
      ? <span key="tools">tools {fmtDuration(ledger.durMs - ledger.apiMs)}</span> : null,
    ledger.apiMs != null && ledger.apiMs > 0 && ledger.out > 0
      ? <span key="speed">{Math.round(ledger.out / (ledger.apiMs / 1000))} tok/s</span> : null,
    ledger.promptTokens != null ? <span key="prompt">prompt {fmtTokens(ledger.promptTokens)}</span> : null,
    ledger.ttlS != null ? <span key="ttl">TTL {fmtSpan(ledger.ttlS * 1000)}</span> : null,
    showsTurnCost(provider) && ledger.costUsd != null
      ? <span key="usd">${ledger.costUsd < 0.1 ? ledger.costUsd.toFixed(3) : ledger.costUsd.toFixed(2)}</span> : null,
  ];
  return (
    <div className={`turn-ledger${cold ? ' cold' : ''}`} title={tip.title} data-tip-instant="" {...tipAttrs({ detail: tip.lines })}>
      <span className="turn-ledger-bar" aria-hidden="true">
        <i className="read" style={{ width: w(ledger.read) }} />
        <i className="write" style={{ width: w(ledger.write) }} />
      </span>
      {items.filter(Boolean)}
    </div>
  );
}
