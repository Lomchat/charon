'use client';
// Account-usage widgets — the `/usage` gauges (Claude Pro/Max quota, Codex
// rate-limit windows) for the current session's VPS account. Data comes from
// the `account_usage` SSE event (usagePoll.ts → get_usage RPC). Two surfaces,
// one set of windows (`usageCells`) and one detail popover:
//   - UsageMeter: the session header's runtime cell (5h / 7d mini-bars).
//   - UsageRings: one ring per window under the repo controls, ≤820px, where
//     the runtime cell is hidden.
// cf. CLAUDE.md §14.58.
import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import type { AgentKind } from '@/lib/types/api';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';
import { providerText } from '@/lib/providerText';
import type { AccountUsage, AccountUsageLimit } from '@/lib/server/claude/types';
import AgentLogo from './AgentLogo';
import { accountUsageReadAt } from './accountUsageState';

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

/** One headline gauge: a rate-limit window. */
type UsageCell = {
  k: string;
  pct: number | null;
  /** The endpoint's own verdict; absent on the plain 5h/7d windows. */
  sev?: string;
  /** A model-specific cap. It only ever comes from the POLL, never from a
   *  turn's live `rate_limit`, so it goes stale on its own (§14.72). */
  scoped: boolean;
};

/** Both headline windows and every model-specific cap the endpoint currently
 *  reports (e.g. Fable) — it only returns the relevant scoped limits, so a
 *  truthy scopeModel is enough, no extra filtering. */
function usageCells(usage: AccountUsage | null): UsageCell[] {
  const scoped = (usage?.limits ?? []).filter((l) => l.scopeModel);
  return [
    { k: '5h', pct: usage?.fiveHour?.utilization ?? null, scoped: false },
    { k: '7d', pct: usage?.sevenDay?.utilization ?? null, scoped: false },
    ...scoped.map((l) => ({ k: l.scopeModel as string, pct: l.percent, sev: l.severity, scoped: true })),
  ];
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

function Bar({ label, sub, pct, severity, reset }: {
  label: string; sub?: string | null; pct: number | null; severity?: string; reset?: string | null;
}) {
  const cls = sevClass(severity, pct);
  return (
    <div className="um-row">
      <div className="um-row-top">
        <span className="um-label">{label}{sub ? <em className="um-scope"> {sub}</em> : null}</span>
        <span className={`um-pct um-${cls}`}>{fmtPct(pct)}</span>
      </div>
      <div className="um-track"><div className={`um-fill um-${cls}`} style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} /></div>
      {reset ? <div className="um-reset">{fmtReset(reset)}</div> : null}
    </div>
  );
}

/** The full detail body of the popover both surfaces open. */
function UsageDetail({ usage, vpsName, onRefresh }: {
  usage: AccountUsage; vpsName?: string | null; onRefresh?: () => void;
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
        <div className="um-empty">{reason}</div>
      </div>
    );
  }
  // Prefer the endpoint's rich limits[]; fall back to the plain 5h/7d windows.
  const limits: Array<Omit<AccountUsageLimit, 'percent'> & { percent: number | null }> = usage.limits && usage.limits.length
    ? usage.limits
    : [
        ...(usage.fiveHour ? [{ kind: 'session', percent: usage.fiveHour.utilization, severity: 'normal', resetsAt: usage.fiveHour.resetsAt }] : []),
        ...(usage.sevenDay ? [{ kind: 'weekly_all', percent: usage.sevenDay.utilization, severity: 'normal', resetsAt: usage.sevenDay.resetsAt }] : []),
      ];
  const live = (usage.windowsAt ?? 0) > usage.fetchedAt;
  const kindLabel = (l: Omit<AccountUsageLimit, 'percent'>): string =>
    l.kind === 'session' || l.group === 'session' ? '5-hour session'
    : l.kind === 'weekly_all' ? 'Weekly (all)'
    : l.kind === 'weekly_scoped' ? 'Weekly'
    : l.kind || 'Limit';
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
      {limits.map((l, i) => (
        <Bar key={i} label={kindLabel(l)} sub={l.scopeModel} pct={l.percent}
             severity={l.severity} reset={l.resetsAt} />
      ))}
      {usage.extraUsage?.isEnabled ? (
        <Bar label="Extra usage" pct={usage.extraUsage.utilization ?? null} severity="normal" />
      ) : null}
      {/* Live 5h/7d windows outdate the poll; a failing poll then only
          stales the per-model caps. §14.72 */}
      <div className={`um-foot${usage.degraded && !live ? ' um-foot-stale' : ''}`}>
        {fmtAgo(accountUsageReadAt(usage))}
        {usage.degraded ? <> · {live ? 'model caps: ' : ''}{degradedNote(usage.degraded)}</> : null}
      </div>
    </div>
  );
}

function UsagePopover({ usage, vpsName, onRefresh }: {
  usage: AccountUsage | null; vpsName?: string | null; onRefresh?: () => void;
}) {
  return (
    <div className="usage-pop" role="dialog" aria-label="Account usage">
      {usage ? <UsageDetail usage={usage} vpsName={vpsName} onRefresh={onRefresh} /> : <div className="um-empty">No usage data yet.{onRefresh && <button type="button" className="um-refresh" onClick={onRefresh} aria-label="Refresh usage">↻</button>}</div>}
    </div>
  );
}

export default function UsageMeter({ usage, vpsName, runtime = false, onRefresh, kind }: {
  usage: AccountUsage | null;
  vpsName?: string | null;
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

  // ── No usage API, and none coming: a LINK, not an empty gauge ──
  //
  // Below every hook on purpose. As an early return it was a latent "rendered
  // fewer hooks than expected" crash: the condition reads `usage`, which flips
  // from null to a snapshot on any provider that later grows an endpoint.
  //
  // It keeps the meter's own wrapper classes rather than inventing a parallel
  // one, so every rule already written for the cell applies to it — including
  // the ≤820px `.claude-bar .runtime-usage { display:none }` that hands usage
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
      {runtime ? <button type="button" className={`runtime-cell runtime-usage-button um-${worst}`} onClick={() => setOpen((o) => !o)} title="Account usage" aria-label="Show account usage" aria-expanded={open}>
        {usage?.ok ? <span className="runtime-usage-gauges">{cells.map((c) => <span className="runtime-usage-row" key={c.k}>
          <span title={c.k}>{c.k}</span><span className="runtime-usage-track" aria-hidden="true"><span className={`um-fill um-${sevClass(c.sev, c.pct)}`} style={{ width: `${Math.min(100, Math.max(0, c.pct ?? 0))}%` }} /></span><b>{fmtPct(c.pct)}</b>
        </span>)}</span> : <span className="runtime-usage-empty">Unavailable</span>}
      </button> : (
      <button className={`usage-chip um-${worst}`} onClick={() => setOpen((o) => !o)}
              title="Account usage" aria-expanded={open}>
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
      {open ? <UsagePopover usage={usage} vpsName={vpsName} onRefresh={onRefresh} /> : null}
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

function Ring({ cell, label, stale }: { cell: UsageCell; label: string; stale: boolean }) {
  const known = cell.pct != null;
  const used = Math.min(100, Math.max(0, cell.pct ?? 0)) / 100;
  return (
    <svg className={`ur-ring um-${known ? sevClass(cell.sev, cell.pct) : 'none'}${stale ? ' is-stale' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle className="ur-track" cx="12" cy="12" r={RING_R} />
      {used > 0 && <circle className="ur-arc" cx="12" cy="12" r={RING_R}
        strokeDasharray={`${RING_C * used} ${RING_C}`} transform="rotate(-90 12 12)" />}
      <text className="ur-label" x="12" y="12" textAnchor="middle" dominantBaseline="central">{label}</text>
    </svg>
  );
}

/** One ring per usage window, FILLING with what has been used (the desktop
 *  cell's reading, drawn round) and coloured by the same thresholds. A tap
 *  opens the same detail as the desktop cell. A provider with no usage API
 *  gets its dashboard link. */
export function UsageRings({ usage, vpsName, onRefresh, kind }: {
  usage: AccountUsage | null;
  vpsName?: string | null;
  onRefresh?: () => void;
  kind?: AgentKind | null;
}) {
  const provider = asSessionProvider(kind);
  const dashboard = PROVIDERS[provider].usageDashboardUrl;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(open, setOpen, ref);

  if (!usage && dashboard) {
    return (
      <a className="usage-rings usage-rings-link" href={dashboard} target="_blank" rel="noopener noreferrer"
         title={providerText.usageOpenDashboard(provider)} aria-label={providerText.usageOpenDashboard(provider)}>
        usage ↗
      </a>
    );
  }

  // No good reading yet (or none at all): the two headline windows, dashed.
  const cells = usageCells(usage?.ok ? usage : null);
  const labels = ringLabels(cells);
  // Live 5h/7d windows outdate a failing poll; the model caps ride the poll
  // alone, so they are what a degraded snapshot leaves stale. §14.72
  const live = (usage?.windowsAt ?? 0) > (usage?.fetchedAt ?? 0);
  const summary = cells.map((c) => `${c.k} ${fmtPct(c.pct)}`).join(', ');
  return (
    <div className="usage-rings" ref={ref}>
      <button type="button" className="usage-rings-button" onClick={() => setOpen((o) => !o)}
              title={`Account usage — ${summary}`} aria-label={`Account usage: ${summary}`} aria-expanded={open}>
        {cells.map((c, i) => (
          <Ring key={c.k} cell={c} label={labels[i]}
                stale={!!usage?.degraded && (c.scoped || !live)} />
        ))}
      </button>
      {open ? <UsagePopover usage={usage} vpsName={vpsName} onRefresh={onRefresh} /> : null}
    </div>
  );
}
