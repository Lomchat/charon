'use client';
// Account-usage widgets — the `/usage` gauges (Claude Pro/Max quota, Codex
// rate-limit windows) for the current session's VPS account. Data comes from
// the `account_usage` SSE event (usagePoll.ts → get_usage RPC). Two surfaces,
// one set of windows (`usageCells`) and one detail popover:
//   - UsageMeter: the session header's runtime cell (5h / 7d mini-bars).
//   - UsageRings: one ring per window under the repo controls, ≤820px, where
//     the runtime cell is hidden.
// cf. CLAUDE.md §14.58.
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { AgentKind } from '@/lib/types/api';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';
import { providerText } from '@/lib/providerText';
import type { AccountUsage, AccountUsageLimit } from '@/lib/server/hub/types';
import AgentLogo from './AgentLogo';
import { accountUsageReadAt } from './accountUsageState';
import UsageAccountSwitch, { type AccountSwitchTarget } from './UsageAccountSwitch';

function sevClass(severity: string | undefined, percent: number | null): string {
  if (severity === 'critical') return 'crit';
  if (severity === 'warning' || severity === 'warn') return 'warn';
  const p = percent ?? 0;
  if (p >= 90) return 'crit';
  if (p >= 70) return 'warn';
  return 'ok';
}

function fmtReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return '';
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return '';
  let s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'resets now';
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function fmtPct(p: number | null | undefined): string {
  if (p == null) return '—';
  return `${Math.round(p)}%`;
}

function fmtAgo(fetchedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `updated ${m}m ago`;
  return `updated ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')} ago`;
}

/** "in 4m" / "shortly" for a retry timestamp. */
function fmtIn(at: number | null | undefined): string {
  if (!at) return 'shortly';
  const s = Math.round((at - Date.now()) / 1000);
  if (s <= 30) return 'shortly';
  if (s < 90) return 'in a minute';
  return `in ${Math.round(s / 60)}m`;
}

/** Why the numbers on screen are older than the poll cadence. The gauges
 *  themselves stay visible — see CLAUDE.md §14.72: blanking a good reading over
 *  a transient 429 is what read as "usage is broken". */
function degradedNote(d: NonNullable<AccountUsage['degraded']>): string {
  if (d.statusCode === 429) return `throttled by the usage API — retrying ${fmtIn(d.retryAt)}`;
  if (d.statusCode === 401) return 'token expired — refreshes on the next turn';
  if (d.reason === 'no_credentials') return 'not signed in on this VPS';
  return `refresh failed — retrying ${fmtIn(d.retryAt)}`;
}

const HOUR_MS = 3_600_000;

/** A limit's window length. The payload does not carry it; the kind says it. */
function windowMsOf(kind: string | null | undefined, group?: string | null): number | null {
  if (kind === 'session' || group === 'session') return 5 * HOUR_MS;
  if (group === 'weekly' || kind?.startsWith('weekly')) return 168 * HOUR_MS;
  return null;
}

/** THE PACE MARK: how far through its window the clock stands (0–1), or null
 *  when that is unknown (no reset time: an idle window). A gauge filled past
 *  it is spending faster than a pace that lasts until the reset. */
function paceFraction(resetsAt: string | null | undefined, windowMs: number | null, now: number): number | null {
  if (!now || !resetsAt || !windowMs) return null;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return null;
  const left = t - now;
  if (left <= 0 || left > windowMs) return null;
  return 1 - left / windowMs;
}

/** Wall clock for the pace marks that stay on screen, ticking each minute. 0
 *  until mounted, so the server render and the first client one agree. */
function useMinuteClock(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** One headline gauge: a rate-limit window. */
type UsageCell = {
  k: string;
  /** What the window is, in a sentence. */
  name: string;
  pct: number | null;
  /** The endpoint's own verdict; absent on the plain 5h/7d windows. */
  sev?: string;
  resetsAt: string | null;
  windowMs: number | null;
  /** A model-specific cap. It only ever comes from the POLL, never from a
   *  turn's live `rate_limit`, so it goes stale on its own (§14.72). */
  scoped: boolean;
};

/** Both headline windows and every model-specific cap the endpoint currently
 *  reports (e.g. Fable) — it only returns the relevant scoped limits, so a
 *  truthy scopeModel is enough, no extra filtering. */
function usageCells(usage: AccountUsage | null): UsageCell[] {
  const scoped = (usage?.limits ?? []).filter((l) => l.scopeModel);
  // A window a COMPLETE reading leaves out does not exist for this account
  // (Codex has no 5-hour window today): no gauge, until a reading carries it
  // again — the next poll or push redraws. A windows-only snapshot (live
  // `rate_limit` events before any poll: fetchedAt 0) is partial and hides
  // nothing; no reading at all keeps both placeholders. An ok reading always
  // has at least one window (usagePoll.ts turns an empty one into an error).
  const complete = !!usage?.ok && usage.fetchedAt > 0;
  return [
    ...(!complete || usage?.fiveHour ? [{ k: '5h', name: '5-hour window', pct: usage?.fiveHour?.utilization ?? null,
      resetsAt: usage?.fiveHour?.resetsAt ?? null, windowMs: 5 * HOUR_MS, scoped: false }] : []),
    ...(!complete || usage?.sevenDay ? [{ k: '7d', name: 'Weekly window (all models)', pct: usage?.sevenDay?.utilization ?? null,
      resetsAt: usage?.sevenDay?.resetsAt ?? null, windowMs: 168 * HOUR_MS, scoped: false }] : []),
    ...scoped.map((l) => ({
      k: l.scopeModel as string, name: `${l.scopeModel} weekly cap`, pct: l.percent, sev: l.severity,
      resetsAt: l.resetsAt ?? null, windowMs: windowMsOf(l.kind, l.group), scoped: true,
    })),
  ];
}

/** The desktop gauge's hover text: the window, then the numbers, one per line. */
function cellTitle(c: UsageCell, pace: number | null): string {
  const facts = [c.name, `${fmtPct(c.pct)} used`];
  if (pace != null) facts.push(`${Math.round(pace * 100)}% of the time elapsed`);
  const reset = fmtReset(c.resetsAt);
  if (reset) facts.push(reset);
  return facts.join('\n');
}

/** The pace mark on a pill: a notch the colour of the surface behind the
 *  gauge (`--um-surface`), cut up from the bottom edge, with a solid point
 *  inside it. Vector shapes, not boxes: at a fractional zoom a box snaps to
 *  device pixels differently at each offset, and the marks of one column read
 *  as different sizes. `h` is the pill's height (app.css § .um-pill); the
 *  shape grows with it more gently than the pill does. */
function PaceMark({ pace, h }: { pace: number | null; h: number }) {
  if (pace == null) return null;
  const k = 1 + (h / 10 - 1) * 0.6;
  const w = 4.05 * k, depth = Math.min(5.94 * k, h * 0.64), tip = depth - 1.15 * k, half = 0.54 * w;
  const pts = (xy: number[]) => xy.map((n) => n.toFixed(2)).join(' ');
  return (
    <svg className="um-pace" aria-hidden="true">
      <svg x={`${pace * 100}%`} overflow="visible">
        <polygon className="um-pace-notch" points={pts([-w, h + 0.6, w, h + 0.6, 0, h - depth])} />
        <polygon className="um-pace-point" points={pts([-half, h, half, h, 0, h - tip])} />
      </svg>
    </svg>
  );
}

/** One window as a filled pill: the used share tints the track in the
 *  severity colour, the label sits inside, the pace mark is notched into the
 *  bottom edge, and the percentage stands OUTSIDE, right of the pill — inside,
 *  the mark covered it whenever the window neared its reset. `h` must match
 *  the pill's CSS height: 18 in the popover, 10 in the session header. */
function UsagePill({ label, pct, cls, pace, h, className = '', title }: {
  label: ReactNode; pct: number | null; cls: string; pace: number | null; h: number;
  className?: string; title?: string;
}) {
  return (
    <span className={`um-gauge${className ? ` ${className}` : ''}`} title={title}>
      <span className="um-pill">
        <span className="um-pill-track" aria-hidden="true">
          <span className={`um-pill-fill um-${cls}`} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
        </span>
        <span className="um-pill-label">{label}</span>
        <PaceMark pace={pace} h={h} />
      </span>
      <b className="um-pill-pct">{fmtPct(pct)}</b>
    </span>
  );
}

/** Close a popover on a press outside `ref` or on Escape. */
function useDismiss(open: boolean, setOpen: (open: boolean) => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); window.removeEventListener('keydown', onKey); };
  }, [open, setOpen, ref]);
}

function Bar({ label, sub, pct, severity, reset, pace = null }: {
  label: string; sub?: string | null; pct: number | null; severity?: string; reset?: string | null;
  pace?: number | null;
}) {
  return (
    <div className="um-row">
      <UsagePill h={18} label={<>{label}{sub ? <em className="um-scope"> {sub}</em> : null}</>}
                 pct={pct} cls={sevClass(severity, pct)} pace={pace} />
      {reset ? <div className="um-reset">{fmtReset(reset)}</div> : null}
    </div>
  );
}

/** The full detail body of the popover both surfaces open. */
/** Whose usage this is (`usageAccountLabel`: provider + official identity, as in the
 *  header account buttons). Two accounts on one VPS can read near-identical numbers. */
function UsageAccount({ accountLabel }: { accountLabel: string | null }) {
  if (!accountLabel) return null;
  return <div className="um-account" title={accountLabel}>{accountLabel}</div>;
}

function UsageDetail({ usage, vpsName, onRefresh, provider, accountLabel }: {
  usage: AccountUsage; vpsName?: string | null; onRefresh?: () => void;
  provider: AgentKind; accountLabel: string | null;
}) {
  // Only reached when we have NO good reading at all — a degraded snapshot
  // still renders its (real, just older) gauges below. §14.72.
  if (!usage.ok) {
    const reason =
      usage.error === 'no_credentials' ? 'Not signed in on this VPS.'
      : usage.error === 'http_error' && usage.statusCode === 401 ? 'Token expired — will refresh on next turn.'
      : usage.error === 'http_error' && usage.statusCode === 429 ? 'Rate-limited by the usage API — retrying shortly.'
      : 'Usage temporarily unavailable.';
    return (
      <div className="um-detail">
        <div className="um-head">
          <span className="um-title">
            {usage.provider ? <AgentLogo kind={usage.provider} size={13} /> : null}
            Usage{vpsName ? ` · ${vpsName}` : ''}
          </span>
          {onRefresh ? <button className="um-refresh" onClick={onRefresh} title="Refresh">↻</button> : null}
        </div>
        <UsageAccount accountLabel={accountLabel} />
        <div className="um-empty">{reason}</div>
      </div>
    );
  }
  const live = (usage.windowsAt ?? 0) > usage.fetchedAt;
  return (
    <div className="um-detail">
      <div className="um-head">
        <span className="um-title">
          {usage.provider ? <AgentLogo kind={usage.provider} size={13} /> : null}
          Usage{vpsName ? ` · ${vpsName}` : ''}
          {usage.subscriptionType ? <span className="um-plan">{usage.subscriptionType}</span> : null}
        </span>
        {onRefresh ? <button className="um-refresh" onClick={onRefresh} title="Refresh">↻</button> : null}
      </div>
      <UsageAccount accountLabel={accountLabel} />
      <UsageBars usage={usage} />
      {/* Live 5h/7d windows outdate the poll; a failing poll then only
          stales the per-model caps. §14.72 */}
      <div className={`um-foot${usage.degraded && !live ? ' um-foot-stale' : ''}`}>
        {fmtAgo(accountUsageReadAt(usage))}
        {usage.degraded ? <> · {live ? 'model caps: ' : ''}{degradedNote(usage.degraded)}</> : null}
      </div>
    </div>
  );
}

/** An account's windows as full bars: the endpoint's rich limits[], else the
 *  plain 5h/7d. ONE renderer for the session's account and the others listed
 *  under it, so their gauges compare at the same size. */
function UsageBars({ usage }: { usage: AccountUsage }) {
  const limits: Array<Omit<AccountUsageLimit, 'percent'> & { percent: number | null }> = usage.limits && usage.limits.length
    ? usage.limits
    : [
        ...(usage.fiveHour ? [{ kind: 'session', percent: usage.fiveHour.utilization, severity: 'normal', resetsAt: usage.fiveHour.resetsAt }] : []),
        ...(usage.sevenDay ? [{ kind: 'weekly_all', percent: usage.sevenDay.utilization, severity: 'normal', resetsAt: usage.sevenDay.resetsAt }] : []),
      ];
  // Read at render, like the reset countdowns beside them: the popover is
  // short-lived, and every reopen is a fresh render.
  const now = Date.now();
  const kindLabel = (l: Omit<AccountUsageLimit, 'percent'>): string =>
    l.kind === 'session' || l.group === 'session' ? '5-hour session'
    : l.kind === 'weekly_all' ? 'Weekly (all)'
    : l.kind === 'weekly_scoped' ? 'Weekly'
    : l.kind || 'Limit';
  return <>
    {limits.map((l, i) => (
      <Bar key={i} label={kindLabel(l)} sub={l.scopeModel} pct={l.percent} severity={l.severity} reset={l.resetsAt}
           pace={paceFraction(l.resetsAt, windowMsOf(l.kind, l.group), now)} />
    ))}
    {usage.extraUsage?.isEnabled ? (
      <Bar label="Extra usage" pct={usage.extraUsage.utilization ?? null} severity="normal" />
    ) : null}
  </>;
}

/** Another account's gauges in the switch list: the session's own bars. */
function SwitchGauges({ usage }: { usage: AccountUsage | null }) {
  if (!usage?.ok) return <div className="um-empty">No usage reading yet.</div>;
  return <div className="um-switch-bars"><UsageBars usage={usage} /></div>;
}

export function UsagePopover({ usage, vpsName, onRefresh, provider, accountLabel, switchTarget, onClose }: {
  usage: AccountUsage | null; vpsName?: string | null; onRefresh?: () => void;
  provider: AgentKind; accountLabel: string | null;
  /** A SESSION's gauges: also offer its provider's other accounts (§14.115). */
  switchTarget?: AccountSwitchTarget | null;
  onClose?: () => void;
}) {
  const label = accountLabel;
  return (
    <div className="usage-pop" role="dialog" aria-label={label ? `Account usage: ${label}` : 'Account usage'}>
      {usage ? <UsageDetail usage={usage} vpsName={vpsName} onRefresh={onRefresh} provider={usage.provider ?? provider} accountLabel={accountLabel} /> : <>
        <UsageAccount accountLabel={accountLabel} />
        <div className="um-empty">No usage data yet.{onRefresh && <button type="button" className="um-refresh" onClick={onRefresh} aria-label="Refresh usage">↻</button>}</div>
      </>}
      {switchTarget ? <UsageAccountSwitch target={switchTarget} provider={provider}
        renderGauges={(u) => <SwitchGauges usage={u} />} onDone={() => onClose?.()} /> : null}
    </div>
  );
}

export default function UsageMeter({ usage, vpsName, runtime = false, onRefresh, kind, accountLabel, switchTarget }: {
  usage: AccountUsage | null;
  /** A session's meter: its popover offers the other accounts. */
  switchTarget?: AccountSwitchTarget | null;
  vpsName?: string | null;
  /** The account these gauges belong to (`usageAccountLabel`); required so a
   *  surface cannot silently drop it. */
  accountLabel: string | null;
  /** Three-cell session header; keeps an explicit placeholder when usage is absent. */
  runtime?: boolean;
  onRefresh?: () => void;
  /** Whose usage this is. A provider that publishes no usage API gets a LINK to
   *  the page that does show it (registry `usageDashboardUrl`) instead of a
   *  meter it can never fill. */
  kind?: AgentKind | null;
}) {
  const provider = asSessionProvider(kind);
  const dashboard = PROVIDERS[provider].usageDashboardUrl;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, setOpen, ref);
  const now = useMinuteClock();

  // ── No usage API, and none coming: a LINK, not an empty gauge ──
  //
  // Below every hook on purpose. As an early return it was a latent "rendered
  // fewer hooks than expected" crash: the condition reads `usage`, which flips
  // from null to a snapshot on any provider that later grows an endpoint.
  //
  // It keeps the meter's own wrapper classes rather than inventing a parallel
  // one, so every rule already written for the cell applies to it — including
  // the ≤820px `.app-bar .runtime-usage { display:none }` that hands usage
  // to the rings on a phone. A new element that must obey the same rules
  // carries the same hooks; a private class means remembering to update each
  // rule, which is how this once shipped visible in the mobile header while
  // the real gauges were hidden.
  if (!usage && dashboard && runtime) {
    return (
      <div className="usage-meter runtime-usage">
        <a
          className="runtime-cell runtime-usage-link"
          href={dashboard}
          target="_blank"
          rel="noopener noreferrer"
          title={providerText.usageOpenDashboard(provider)}
        >
          <span className="um-link-note">{providerText.usageOnWebOnly(provider)}</span>
          <span className="um-link-cta">{providerText.usageOpenDashboard(provider)} ↗</span>
        </a>
      </div>
    );
  }

  // The runtime panel keeps its third cell even before a first reading.
  if (!usage && !runtime) return null;
  const cells = usageCells(usage);
  // Worst severity across all limits → chip accent.
  let worst = 'ok';
  for (const l of usage?.limits ?? []) {
    const c = sevClass(l.severity, l.percent);
    if (c === 'crit') { worst = 'crit'; break; }
    if (c === 'warn') worst = 'warn';
  }

  return (
    <div className={`usage-meter${runtime ? ' runtime-usage' : ''}`} ref={ref}>
      {runtime ? <button type="button" className={`runtime-cell runtime-usage-button um-${worst}`} onClick={() => setOpen((o) => !o)} title={accountLabel ? `Account usage — ${accountLabel}` : 'Account usage'} aria-label={accountLabel ? `Show account usage: ${accountLabel}` : 'Show account usage'} aria-expanded={open}>
        {usage?.ok ? <span className="runtime-usage-gauges">{cells.map((c) => {
          const pace = paceFraction(c.resetsAt, c.windowMs, now);
          return <UsagePill key={c.k} className="runtime-usage-row" h={10} title={cellTitle(c, pace)}
                            label={c.k} pct={c.pct} cls={sevClass(c.sev, c.pct)} pace={pace} />;
        })}</span> : <span className="runtime-usage-empty">Unavailable</span>}
      </button> : (
      <button className={`usage-chip um-${worst}`} onClick={() => setOpen((o) => !o)}
              title={accountLabel ? `Account usage — ${accountLabel}` : 'Account usage'} aria-expanded={open}>
        {cells.map((c, i) => (
          <Fragment key={c.k + i}>
            {i > 0 ? <span className="usage-chip-sep" /> : null}
            <span className="usage-chip-cell">
              <span className="usage-chip-k">{c.k}</span>
              <span className={`usage-chip-v${c.sev ? ` um-${sevClass(c.sev, c.pct)}` : ''}`}>{fmtPct(c.pct)}</span>
            </span>
          </Fragment>
        ))}
      </button>)}
      {open ? <UsagePopover usage={usage} vpsName={vpsName} onRefresh={onRefresh} provider={provider} accountLabel={accountLabel}
        switchTarget={switchTarget} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

// ── Rings (≤820px) ───────────────────────────────────────────────────────────

const RING_R = 9.5;
const RING_C = 2 * Math.PI * RING_R;

/** What fits inside a ring: the window, or the model's initial — two
 *  letters when another model cap shares it. */
function ringLabels(cells: UsageCell[]): string[] {
  const initial = (c: UsageCell, n: number) => c.k.slice(0, n).toUpperCase();
  return cells.map((c) => {
    if (!c.scoped) return c.k;
    const clash = cells.some((o) => o !== c && o.scoped && initial(o, 1) === initial(c, 1));
    return clash ? c.k.slice(0, 1).toUpperCase() + c.k.slice(1, 2).toLowerCase() : initial(c, 1);
  });
}

function Ring({ cell, label, now }: { cell: UsageCell; label: string; now: number }) {
  const known = cell.pct != null;
  const used = Math.min(100, Math.max(0, cell.pct ?? 0)) / 100;
  const pace = known ? paceFraction(cell.resetsAt, cell.windowMs, now) : null;
  return (
    <svg className={`ur-ring um-${known ? sevClass(cell.sev, cell.pct) : 'none'}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="ur-track" cx="12" cy="12" r={RING_R} />
      {used > 0 && <circle className="ur-arc" cx="12" cy="12" r={RING_R}
        strokeDasharray={`${RING_C * used} ${RING_C}`} transform="rotate(-90 12 12)" />}
      {/* The pace mark: a solid bead on the stroke, ringed by the surface
          behind the gauge so it cuts the arc cleanly. */}
      {pace != null && <g className="ur-pace" transform={`rotate(${pace * 360} 12 12)`}>
        <circle className="ur-pace-halo" cx="12" cy={12 - RING_R} r="3.7" />
        <circle className="ur-pace-dot" cx="12" cy={12 - RING_R} r="2.6" />
      </g>}
      <text className="ur-label" x="12" y="12" textAnchor="middle" dominantBaseline="central">{label}</text>
    </svg>
  );
}

/** One ring per usage window, FILLING with what has been used (the desktop
 *  cell's reading, drawn round) and coloured by the same thresholds, with the
 *  same pace mark. A tap opens the same detail as the desktop cell. A provider
 *  with no usage API gets its dashboard link. */
export function UsageRings({ usage, vpsName, onRefresh, kind, accountLabel, lead, className, title, open: openProp, onOpenChange, onTriggerClick, onTriggerEnter, onTriggerLeave, switchTarget }: {
  usage: AccountUsage | null;
  /** A session's rings: the popover offers the other accounts (§14.115). */
  switchTarget?: AccountSwitchTarget | null;
  vpsName?: string | null;
  accountLabel: string | null;
  onRefresh?: () => void;
  kind?: AgentKind | null;
  /** Rendered first inside the button (or the dashboard link): the header
   *  account buttons put their logo + label there (app/AccountNav.tsx). */
  lead?: ReactNode;
  /** Extra class on the root, for surfaces that restyle the rings. */
  className?: string;
  /** Who the account is, in full (name + email + machines): replaces
   *  `accountLabel` in the button's / link's tooltip and aria-label. */
  title?: string;
  /** Controlled popover state (the header account buttons keep it exclusive
   *  with their sessions menu); uncontrolled when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Replaces the button's plain toggle (the header account buttons pin a
   *  hover-opened popover instead of closing it, app/AccountNav.tsx). */
  onTriggerClick?: () => void;
  /** Pointer entering the button (hover-to-open on the account buttons). */
  onTriggerEnter?: () => void;
  /** Pointer leaving the button (cancels a pending hover switch). */
  onTriggerLeave?: () => void;
}) {
  const root = `usage-rings${className ? ` ${className}` : ''}`;
  const provider = asSessionProvider(kind);
  const dashboard = PROVIDERS[provider].usageDashboardUrl;
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = useCallback((next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }, [openProp, onOpenChange]);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, setOpen, ref);
  const who = title ?? accountLabel;
  const now = useMinuteClock();

  if (!usage && dashboard) {
    return (
      <a className={`${root} usage-rings-link`} href={dashboard} target="_blank" rel="noopener noreferrer"
         title={`${who && lead ? `${who} — ` : ''}${providerText.usageOpenDashboard(provider)}`}
         aria-label={`${who && lead ? `${who} — ` : ''}${providerText.usageOpenDashboard(provider)}`}>
        {lead}usage ↗
      </a>
    );
  }

  // No good reading yet (or none at all): the two headline windows, dashed.
  const cells = usageCells(usage?.ok ? usage : null);
  const labels = ringLabels(cells);
  const summary = cells.map((c) => `${c.k} ${fmtPct(c.pct)}`).join(', ');
  return (
    <div className={root} ref={ref}>
      <button type="button" className="usage-rings-button" onClick={onTriggerClick ?? (() => setOpen(!open))}
              onMouseEnter={onTriggerEnter} onMouseLeave={onTriggerLeave}
              /* Hover opens the popover itself: a native tooltip repeating
                 it would land on top of it. */
              title={onTriggerEnter ? undefined : `Account usage — ${who ? `${who} — ` : ''}${summary}`} aria-label={`Account usage: ${who ? `${who}, ` : ''}${summary}`} aria-expanded={open}>
        {lead}
        {cells.map((c, i) => (
          <Ring key={c.k} cell={c} label={labels[i]} now={now} />
        ))}
      </button>
      {open ? <UsagePopover usage={usage} vpsName={vpsName} onRefresh={onRefresh} provider={provider} accountLabel={accountLabel}
        switchTarget={switchTarget} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
