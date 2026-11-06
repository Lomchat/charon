'use client';

// The prompt-cache marks (lib/promptCache.ts): the I2 flame that empties over
// the TTL, the sidebar card mark, the context-row marker and the bubble-header
// ledger. Colour = `cacheHeat` (attention cooling to info, theme tokens only);
// shape = the TTL quarter, so four levels read apart at 12 px.
import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  cacheHeat, cacheReading, cacheTipLines, fmtDuration, fmtSpan, fmtSpanShort, fmtTokens,
  ledgerCachedPct, ledgerInput, ledgerRelativeCost, ledgerWarmCost,
  type CacheReading, type PromptCacheState, type TurnLedger,
} from '@/lib/promptCache';
import { showsTurnCost, type SessionProvider } from '@/lib/sessionCapabilities';
import { tipAttrs, type TipSection } from './tooltipText';

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

/** The card mark: the flame while warm or live, NOTHING once cold (the card's
 *  tooltip still says it). Its empty title stays transparent. */
export function SessionCacheMark({ reading }: { reading: CacheReading | null }) {
  if (!reading || (reading.phase !== 'warm' && reading.phase !== 'live')) return null;
  return (
    <span className={`cs-cache cs-cache-${reading.phase}`} style={{ color: cacheHeat(reading) }} title="">
      <CacheSymbol reading={reading} />
    </span>
  );
}

/** The cache block of a tooltip: the headline in the reading's colour with
 *  its symbol, then the facts (cacheTipLines). */
export function cacheTipSection(reading: CacheReading): TipSection {
  return {
    lines: cacheTipLines(reading),
    color: cacheHeat(reading),
    icon: reading.phase === 'cold' || reading.phase === 'small' ? 'snow' : `flame-${reading.level}`,
  };
}

/** The time on the card's details line ("cache 48m"); nothing once cold. */
export function sessionCacheFootText(reading: CacheReading | null): string | null {
  if (!reading || (reading.phase !== 'warm' && reading.phase !== 'live')) return null;
  if (reading.phase === 'live') return 'cache live';
  return `cache ${reading.approx ? '≈' : ''}${fmtSpanShort(reading.remainingMs)}`;
}

// ── Context row (session header) ────────────────────────────────────────────

/** After the token count: the symbol + time left, "live" or "cold". */
export function CacheGaugeMark({ reading }: { reading: CacheReading | null }) {
  if (!reading || reading.phase === 'small') return null;
  const text = reading.phase === 'live' ? 'live'
    : reading.phase === 'cold' ? 'cold'
      : `${reading.approx ? '≈' : ''}${fmtSpanShort(reading.remainingMs)}`;
  return (
    <span className={`bar-context-cache cs-cache-${reading.phase}`} style={{ color: cacheHeat(reading) }}
      title="Prompt cache" data-tip-instant="" {...tipAttrs({ section: cacheTipSection(reading) })}>
      <CacheSymbol reading={reading} />{text}
    </span>
  );
}

// ── Bubble header ledger ────────────────────────────────────────────────────

/** The open session's context window in tokens (its context gauge's reading),
 *  so a ledger can say how full the context was; null = unknown. */
export const ContextWindowContext = createContext<number | null>(null);

/** "8% of full price", "0.4%": a relative cost that reads at a glance. */
function pctText(x: number): string {
  const p = x * 100;
  return p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`;
}

/** The turn's ledger, on its own line under the bubble header: mini-bar, %,
 *  read, written, uncached, output, relative cost, duration — then the rest.
 *  Narrow or touch (app.css): folded to its mark + %, the popover holds the rest. */
export function TurnLedgerLine({ ledger, provider }: { ledger: TurnLedger; provider: SessionProvider }) {
  const ctxWindow = useContext(ContextWindowContext);
  // The popover, the line's own anchor. A mouse opens it on hover, at once: `x`
  // = the pointer, the card opens under it and follows it along the line. A tap
  // toggles it (`tapped`): no hover to end it, see LedgerPopover.
  const [anchor, setAnchor] = useState<{ rect: DOMRect; x: number; tapped: boolean } | null>(null);
  // The last x the card was placed at, read synchronously by the handler.
  const placedX = useRef<number | null>(null);
  // What pressed the line: a mouse's click means nothing, it already hovered.
  const pressedBy = useRef<string | null>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { placedX.current = null; setAnchor(null); }, []);
  const moved = useCallback((rect: DOMRect) => setAnchor((a) => a && { ...a, rect }), []);
  const popId = `ledger${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const input = ledgerInput(ledger);
  if (!(input > 0)) return null;
  const pct = ledgerCachedPct(ledger);
  const rel = ledgerRelativeCost(ledger);
  const warm = ledgerWarmCost(ledger);
  const misses = ledger.misses ?? 0;
  const cold = misses > 0;
  const w = (n: number) => `${((n / input) * 100).toFixed(1)}%`;
  const items: (React.ReactNode | null)[] = [
    pct != null ? (
      <span key="pct" className={`turn-ledger-pct ${cold || !pct ? 'cold' : 'warm'}`}>
        {cold ? <IconSnow /> : pct ? <CacheFlame level={4} className="turn-ledger-mark" /> : <IconSnow className="turn-ledger-mark" />}
        {pct}%
      </span>
    ) : null,
    <span key="read">{fmtTokens(ledger.read)} read</span>,
    <span key="write" className={cold ? 'turn-ledger-cold' : undefined}>{fmtTokens(ledger.write)} written</span>,
    <span key="uncached">{fmtTokens(ledger.uncached)} uncached</span>,
    <span key="out">{fmtTokens(ledger.out)} out</span>,
    rel != null ? <span key="cost" className="turn-ledger-cost">cost {pctText(rel)}</span> : null,
    ledger.durMs != null ? <span key="dur">{fmtDuration(ledger.durMs)}</span> : null,
    ledger.tools != null ? <span key="tools-n">{ledger.tools} tool{ledger.tools === 1 ? '' : 's'}</span> : null,
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
    ledger.promptTokens != null
      ? <span key="context">context {ctxWindow ? `${Math.round((ledger.promptTokens / ctxWindow) * 100)}% (${fmtTokens(ledger.promptTokens)})` : fmtTokens(ledger.promptTokens)}</span>
      : null,
    ledger.ttlS != null ? <span key="ttl">TTL {fmtSpan(ledger.ttlS * 1000)}</span> : null,
    showsTurnCost(provider) && ledger.costUsd != null
      ? <span key="usd">${ledger.costUsd < 0.1 ? ledger.costUsd.toFixed(3) : ledger.costUsd.toFixed(2)}</span> : null,
  ];
  return (
    <div ref={lineRef} className={`turn-ledger${cold ? ' cold' : ''}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        placedX.current = e.clientX;
        setAnchor({ rect: e.currentTarget.getBoundingClientRect(), x: e.clientX, tapped: false });
      }}
      onPointerMove={(e) => {
        if (e.pointerType !== 'mouse') return;
        // Everything the event gives is read HERE: React nulls `currentTarget`
        // once the handler returns, and a queued state updater runs later.
        if (placedX.current != null && Math.abs(placedX.current - e.clientX) < 6) return;
        placedX.current = e.clientX;
        setAnchor({ rect: e.currentTarget.getBoundingClientRect(), x: e.clientX, tapped: false });
      }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') close(); }}
      onPointerDown={(e) => { pressedBy.current = e.pointerType; }}
      onClick={(e) => {
        if (pressedBy.current === 'mouse') return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX;
        setAnchor((a) => (a ? null : { rect, x, tapped: true }));
      }}
      aria-describedby={anchor ? popId : undefined}>
      <span className="turn-ledger-bar" aria-hidden="true">
        <i className="read" style={{ width: w(ledger.read) }} />
        <i className="write" style={{ width: w(ledger.write) }} />
      </span>
      {items.filter(Boolean)}
      {anchor && <LedgerPopover id={popId} ledger={ledger} ctxWindow={ctxWindow} anchor={anchor.rect} pointerX={anchor.x}
        tapped={anchor.tapped} lineRef={lineRef} onMoved={moved} onGone={close} />}
    </div>
  );
}

// ── The ledger popover: four tiles, one ring each ───────────────────────────

const POP_W = 352;

function Ring({ frac, color }: { frac: number; color: string }) {
  const size = 44, w = 6, r = (size - w) / 2, c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return (
    <svg className="ledger-ring" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ledger-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={w} />
      {f > 0 && (
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round"
          strokeDasharray={`${(c * Math.max(0.01, f)).toFixed(2)} ${c.toFixed(2)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      )}
    </svg>
  );
}

function Donut({ parts }: { parts: [frac: number, color: string][] }) {
  const size = 44, w = 7, r = (size - w) / 2, c = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg className="ledger-ring" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ledger-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={w} />
      {parts.map(([frac, color], i) => {
        const len = c * Math.max(0, Math.min(1, frac));
        const arc = (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={w}
            strokeDasharray={`${len.toFixed(2)} ${(c - len).toFixed(2)}`} strokeDashoffset={(-off).toFixed(2)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        );
        off += len;
        return arc;
      })}
    </svg>
  );
}

/** Under the pointer, below the line (above when the bottom is short), clamped to the viewport.
 *  Hovered: informational, no pointer events, gone on scroll. Tapped: it stays
 *  until a tap (on it or the line: their click toggles; elsewhere: at once), and
 *  a live turn's autoscroll only moves it along with its line, until off screen. */
function LedgerPopover({ id, ledger, ctxWindow, anchor, pointerX, tapped, lineRef, onMoved, onGone }: {
  id: string; ledger: TurnLedger; ctxWindow: number | null; anchor: DOMRect; pointerX: number; tapped: boolean;
  lineRef: React.RefObject<HTMLDivElement | null>; onMoved: (rect: DOMRect) => void; onGone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    const below = anchor.bottom + 8;
    setTop(below + h > window.innerHeight - 8 && anchor.top - 8 - h > 8 ? anchor.top - 8 - h : below);
  }, [anchor]);
  useEffect(() => {
    const onScroll = !tapped ? onGone : () => {
      const rect = lineRef.current?.getBoundingClientRect();
      const view = lineRef.current?.closest('.app-chat')?.getBoundingClientRect();
      if (!rect || rect.bottom < (view?.top ?? 0) || rect.top > (view?.bottom ?? window.innerHeight)) onGone();
      else onMoved(rect);
    };
    const onPress = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!lineRef.current?.contains(t) && !ref.current?.contains(t)) onGone();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onGone);
    if (tapped) document.addEventListener('pointerdown', onPress, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onGone);
      document.removeEventListener('pointerdown', onPress, true);
    };
  }, [tapped, lineRef, onMoved, onGone]);
  const input = ledgerInput(ledger);
  const pct = ledgerCachedPct(ledger) ?? 0;
  const rel = ledgerRelativeCost(ledger);
  const warm = ledgerWarmCost(ledger);
  const misses = ledger.misses ?? 0;
  const cold = misses > 0;
  const ctx = ledger.promptTokens != null && ctxWindow ? ledger.promptTokens / ctxWindow : null;
  const toolsMs = ledger.apiMs != null && ledger.durMs != null ? Math.max(0, ledger.durMs - ledger.apiMs) : null;
  // Under the pointer (its arrow-side quarter), clamped to the viewport.
  const width = Math.min(POP_W, window.innerWidth - 16);
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, pointerX - width / 4));
  const tile = (ring: React.ReactNode, value: React.ReactNode, lines: (React.ReactNode | null)[], valueColor?: string) => (
    <div className="ledger-tile">
      {ring}
      <div>
        <div className="ledger-tile-v" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
        {lines.filter(Boolean).map((l, i) => <div key={i} className="ledger-tile-l">{l}</div>)}
      </div>
    </div>
  );
  return createPortal(
    <div ref={ref} id={id} role="tooltip" className={`ledger-pop${tapped ? ' tapped' : ''}`}
      style={{ left, top: top ?? anchor.bottom + 8, width, visibility: top == null ? 'hidden' : undefined }}>
      <div className="ledger-pop-head">
        <span>{cold ? 'Turn input · the cache was cold' : `Turn input · ${pct}% from the cache`}</span>
        {ledger.requests != null && <span className="ledger-pop-req">{ledger.requests} req</span>}
      </div>
      <div className="ledger-tiles">
        {tile(
          <Donut parts={[[ledger.read / input, 'var(--attention)'], [ledger.write / input, 'var(--info)'], [ledger.uncached / input, 'var(--text-muted)']]} />,
          `${pct}%`,
          ['from the cache', ledger.requests != null ? `${ledger.hits ?? 0}/${ledger.requests} requests hit` : null],
          cold ? 'var(--info)' : 'var(--attention)',
        )}
        {tile(
          <Ring frac={rel ?? 0} color="var(--warning)" />,
          rel != null ? pctText(rel) : '—',
          [rel != null ? 'of full price' : 'price unknown',
            rel != null && cold && warm ? <span className="ledger-cold">≈ {(rel / warm).toFixed(1)}× a warm turn</span>
              : rel != null ? `saved ${Math.max(0, 100 - Math.round(rel * 100))}%` : null],
        )}
        {tile(
          <Ring frac={ctx ?? 0} color="var(--info)" />,
          ctx != null ? `${Math.round(ctx * 100)}%` : ledger.promptTokens != null ? fmtTokens(ledger.promptTokens) : '—',
          [ctx != null ? 'context used' : 'context at the end',
            ctx != null ? `${fmtTokens(ledger.promptTokens!)} / ${fmtTokens(ctxWindow!)}` : null],
        )}
        {tile(
          ledger.apiMs != null && ledger.durMs ? <Donut parts={[[ledger.apiMs / ledger.durMs, 'var(--accent)'], [(toolsMs ?? 0) / ledger.durMs, 'var(--violet)']]} />
            : <Ring frac={ledger.durMs ? 1 : 0} color="var(--accent)" />,
          ledger.durMs != null ? fmtDuration(ledger.durMs) : '—',
          [ledger.tools != null ? `⚒ ${ledger.tools} tool${ledger.tools === 1 ? '' : 's'}` : null,
            ledger.apiMs != null ? `model ${fmtDuration(ledger.apiMs)}` : null],
        )}
      </div>
      <div className="ledger-legend">
        <span><i style={{ background: 'var(--attention)' }} />read <b>{fmtTokens(ledger.read)}</b></span>
        <span><i style={{ background: 'var(--info)' }} />written <b>{fmtTokens(ledger.write)}</b></span>
        {ledger.uncached >= 1000 && <span><i style={{ background: 'var(--text-muted)' }} />uncached <b>{fmtTokens(ledger.uncached)}</b></span>}
        <span><i style={{ background: 'var(--success)' }} />out <b>{fmtTokens(ledger.out)}</b></span>
      </div>
    </div>,
    document.body,
  );
}
