'use client';
// Account-usage widget — the `/usage` gauges (Claude Pro/Max quota) for the
// current session's VPS account. Data comes from the `account_usage` SSE event
// (usagePoll.ts → get_usage RPC → api.anthropic.com/api/oauth/usage). Two forms:
//   - compact: a header chip (5h / 7d mini-bars) that opens a detail popover.
//   - panel (compact=false): the full detail inline, for the mobile drawer.
// cf. CLAUDE.md §14.58.
import { Fragment, useEffect, useRef, useState } from 'react';
import type { AccountUsage, AccountUsageLimit } from '@/lib/server/claude/types';

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
  return `updated ${m}m ago`;
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

/** The full detail body — reused in the header popover and the mobile drawer. */
function UsageDetail({ usage, vpsName, onRefresh }: {
  usage: AccountUsage; vpsName?: string | null; onRefresh?: () => void;
}) {
  if (!usage.ok) {
    const reason =
      usage.error === 'no_credentials' ? 'Not signed in on this VPS.'
      : usage.error === 'http_error' && usage.statusCode === 401 ? 'Token expired — will refresh on next turn.'
      : usage.error === 'http_error' && usage.statusCode === 429 ? 'Rate-limited by the usage API — retrying shortly.'
      : 'Usage temporarily unavailable.';
    return (
      <div className="um-detail">
        <div className="um-head">
          <span className="um-title">Usage{vpsName ? ` · ${vpsName}` : ''}</span>
          {onRefresh ? <button className="um-refresh" onClick={onRefresh} title="Refresh">↻</button> : null}
        </div>
        <div className="um-empty">{reason}</div>
      </div>
    );
  }
  // Prefer the endpoint's rich limits[]; fall back to the plain 5h/7d windows.
  const limits: AccountUsageLimit[] = usage.limits && usage.limits.length
    ? usage.limits
    : [
        ...(usage.fiveHour ? [{ kind: 'session', percent: usage.fiveHour.utilization ?? 0, severity: 'normal', resetsAt: usage.fiveHour.resetsAt } as AccountUsageLimit] : []),
        ...(usage.sevenDay ? [{ kind: 'weekly_all', percent: usage.sevenDay.utilization ?? 0, severity: 'normal', resetsAt: usage.sevenDay.resetsAt } as AccountUsageLimit] : []),
      ];
  const kindLabel = (l: AccountUsageLimit): string =>
    l.kind === 'session' || l.group === 'session' ? '5-hour session'
    : l.kind === 'weekly_all' ? 'Weekly (all)'
    : l.kind === 'weekly_scoped' ? 'Weekly'
    : l.kind || 'Limit';
  return (
    <div className="um-detail">
      <div className="um-head">
        <span className="um-title">
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
        <Bar label="Extra usage" pct={usage.extraUsage.utilization ?? 0} severity="normal" />
      ) : null}
      <div className="um-foot">{fmtAgo(usage.fetchedAt)}</div>
    </div>
  );
}

export default function UsageMeter({ usage, vpsName, compact = true, onRefresh }: {
  usage: AccountUsage | null;
  vpsName?: string | null;
  compact?: boolean;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // ── Panel form (mobile drawer): full detail, no popover ──
  if (!compact) {
    if (!usage) return <div className="um-panel um-empty">No usage data yet.</div>;
    return <div className="um-panel"><UsageDetail usage={usage} vpsName={vpsName} onRefresh={onRefresh} /></div>;
  }

  // ── Compact form (header chip) ──
  if (!usage || !usage.ok) {
    // Nothing to show inline; keep the header clean. (The drawer shows the
    // "unavailable" reason.)
    if (!usage) return null;
  }
  // Two headline windows for the chip: prefer the two most-constrained limits.
  const fh = usage.fiveHour?.utilization ?? null;
  const sd = usage.sevenDay?.utilization ?? null;
  // Worst severity across all limits → chip accent.
  let worst = 'ok';
  for (const l of usage.limits ?? []) {
    const c = sevClass(l.severity, l.percent);
    if (c === 'crit') { worst = 'crit'; break; }
    if (c === 'warn') worst = 'warn';
  }

  // Per-model weekly caps the endpoint currently reports (e.g. Fable) become
  // extra chip cells beside 5h / 7d, colored by their own severity so a
  // near-limit model (Fable 97%) pops. The endpoint only returns the relevant
  // scoped limits, so a truthy scopeModel is enough — no extra filtering.
  const scoped = (usage.limits ?? []).filter((l) => l.scopeModel);
  const cells: Array<{ k: string; pct: number | null; sev?: string }> = [
    { k: '5h', pct: fh },
    { k: '7d', pct: sd },
    ...scoped.map((l) => ({ k: l.scopeModel as string, pct: l.percent, sev: l.severity })),
  ];

  return (
    <div className="usage-meter" ref={ref}>
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
      </button>
      {open ? (
        <div className="usage-pop">
          <UsageDetail usage={usage} vpsName={vpsName} onRefresh={onRefresh} />
        </div>
      ) : null}
    </div>
  );
}
