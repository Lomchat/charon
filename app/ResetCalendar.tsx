'use client';
// The calendar (§14.126): a header button opening a month of every
// account's dated facts, one colour per account — a ring where a weekly
// limit refills, a filled dot where a banked reset expires unused — and the
// routines' runs (a neutral diamond, §14.120). Below: the picked day (none
// on open), then one row per account (next refill, banked resets → the
// resets modal). Only what the providers said and the routines' own
// schedules; nothing guessed.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';
import type { ProviderAccount } from '@/lib/providerAccounts';
import { api } from '@/lib/api';
import { describeSchedule } from '@/lib/routineSchedule';
import type { RoutineView } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { IconArrowCounterclockwise, IconArrowRepeat, IconCalendar3 } from './icons';
import { useAccounts } from './accountsStore';
import { openAccountResets } from './resetsStore';
import { claimHeaderPopover, releaseHeaderPopover } from './HeaderSessionNav';
import {
  accountEvents, accountShortName, accountTone, dayKey, fmtDay, fmtIn, fmtMonth, fmtShortDay, fmtTime, monthDays,
  resetExpiresSoon, routineRuns, type ResetEvent,
} from './accountResets';
import { fmtPct, sevClass } from './usageGauges';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

type Row = { account: ProviderAccount; tone: string; events: ResetEvent[] };
/** One thing on a day: an account's fact, or a routine's run. */
type Item = { at: number; e: ResetEvent; row: Row; routine?: undefined } | { at: number; routine: RoutineView; e?: undefined; row?: undefined };

const toneStyle = (tone: string) => ({ ['--tone' as string]: tone }) as CSSProperties;

function whoOf(a: ProviderAccount): string {
  const n = accountShortName(a);
  return `${providerName(a.provider)}${a.number > 1 ? ` ${a.number}` : ''}${n ? ` · ${n}` : ''}`;
}

function itemLine(it: Item): string {
  if (it.routine) return `${fmtTime(it.at)} ${it.routine.name} — routine`;
  const { e } = it; const who = whoOf(it.row.account);
  return e.kind === 'refill'
    ? `${fmtTime(e.at)} ${who} — ${e.what.join(' + ')} refill`
    : `${fmtTime(e.at)} ${who} — ${e.what.join(', ')}${e.count && e.count > 1 ? ` ×${e.count}` : ''} expires`;
}

export default function ResetCalendar({ enabled, onOpen, onOpenRoutine }: {
  /** Backends switched on (Settings): others stay off the calendar. */
  enabled: Readonly<Record<SessionProvider, boolean>>;
  /** A run's row opens its routine's settings (the routines modal). */
  onOpenRoutine?: (id: string) => void;
  /** Opening it (the phone closes nothing: it unfolds inside the drawer). */
  onOpen?: () => void;
}) {
  const { data } = useAccounts();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [picked, setPicked] = useState<string | null>(null);
  // null = never read; kept between openings (a stale list beats a blank).
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const id = useRef({}).current;

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    claimHeaderPopover(id, close);
    const t = setInterval(() => setNow(Date.now()), 60_000);
    let live = true;
    api.listRoutines()
      .then((r) => { if (live) setRoutines(r.routines); })
      .catch(() => { if (live) setRoutines((prev) => prev ?? []); });
    // A CLICK outside closes it, not a press: on a phone it unfolds inside
    // the scrolling drawer, and every swipe there starts with a press.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      // The resets modal opened from here is not "outside".
      if (wrapRef.current?.contains(target) || target?.closest?.('.app-modal-bg')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.rst-modal')) setOpen(false); };
    document.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
      releaseHeaderPopover(id);
    };
  }, [open, id, close]);

  // Accounts with a usage API (Cursor publishes none), in account order: the
  // colour follows the account, whatever month is shown.
  const rows: Row[] = useMemo(() => data.accounts
    .filter((a) => enabled[a.provider] && !PROVIDERS[a.provider].usageDashboardUrl)
    .map((account, i) => ({ account, tone: accountTone(i), events: accountEvents(account.id, data.usage[account.id] ?? null, now) })),
  [data, enabled, now]);
  // Routine runs from now to the end of the month shown (its 6 weeks).
  const runs: Item[] = useMemo(() => {
    const grid = monthDays(view.y, view.m);
    const end = new Date(grid[grid.length - 1]!); end.setHours(23, 59, 59, 999);
    return (routines ?? []).flatMap((routine) => routineRuns(routine, now, end.getTime()).map((at) => ({ at, routine })));
  }, [routines, view, now]);
  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    const add = (it: Item) => { const k = dayKey(it.at); const list = m.get(k) ?? []; list.push(it); m.set(k, list); };
    for (const row of rows) for (const e of row.events) add({ at: e.at, e, row });
    for (const it of runs) add(it);
    for (const list of m.values()) list.sort((a, b) => a.at - b.at);
    return m;
  }, [rows, runs]);
  const soon = rows.some((r) => resetExpiresSoon(data.usage[r.account.id] ?? null, now));

  function toggle() {
    if (open) { setOpen(false); return; }
    const d = new Date(); const t = Date.now();
    setNow(t);
    setView({ y: d.getFullYear(), m: d.getMonth() });
    // Opens with no day picked: the user picks one.
    setPicked(null);
    setOpen(true);
    onOpen?.();
  }
  function shift(by: number) {
    setView(({ y, m }) => { const d = new Date(y, m + by, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  }
  const todayKey = dayKey(now);
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const isThisMonth = (() => { const d = new Date(now); return d.getFullYear() === view.y && d.getMonth() === view.m; })();
  const pickedEvents = picked ? byDay.get(picked) ?? [] : [];

  return (
    <div className={`rcal-anchor${open ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={`head-btn model-notice-anchor rcal-trigger${open ? ' is-on' : ''}`}
        onClick={toggle}
        aria-expanded={open}
        title={soon ? 'calendar — a reset expires soon' : 'calendar'}
        aria-label={soon ? 'calendar, a reset expires soon' : 'calendar'}
        data-label="calendar"
      >
        <IconCalendar3 />
        {soon && <span className="model-notice-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="rcal-pop pop-kit" role="dialog" aria-label="Calendar">
          <div className="pop-head">
            <span className="pop-title">{fmtMonth(view.y, view.m)}</span>
            {!isThisMonth && (
              <button type="button" className="pop-icon-btn rcal-today-btn" onClick={() => { const d = new Date(now); setView({ y: d.getFullYear(), m: d.getMonth() }); setPicked(todayKey); }}
                title="today" aria-label="back to today">●</button>
            )}
            <button type="button" className="pop-icon-btn" onClick={() => shift(-1)} title="previous month" aria-label="previous month">‹</button>
            <button type="button" className="pop-icon-btn" onClick={() => shift(1)} title="next month" aria-label="next month">›</button>
          </div>

          <div className="pop-tile rcal-month">
            <div className="rcal-week" aria-hidden>{WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
            <div className="rcal-grid">
              {monthDays(view.y, view.m).map((d) => {
                const k = dayKey(d);
                const evs = byDay.get(k) ?? [];
                // One mark per (account, kind), one for all routines: a day
                // reads at a glance.
                const markKey = (x: Item) => x.routine ? 'routine' : `${x.row.account.id}-${x.e.kind}`;
                const marks = evs.filter((x, i) => evs.findIndex((y) => markKey(y) === markKey(x)) === i);
                const cls = [
                  'rcal-day',
                  d.getMonth() !== view.m && 'is-out',
                  k === todayKey && 'is-today',
                  d < todayStart && 'is-past',
                  k === picked && 'is-picked',
                  evs.length > 0 && 'has-events',
                ].filter(Boolean).join(' ');
                return (
                  <button type="button" key={k} className={cls} onClick={() => setPicked(k)}
                    title={evs.length ? evs.map(itemLine).join('\n') : undefined}
                    aria-label={`${fmtDay(d.getTime(), now)}${evs.length ? `, ${evs.length} event${evs.length > 1 ? 's' : ''}` : ''}`}
                    aria-pressed={k === picked}>
                    <span className="rcal-num">{d.getDate()}</span>
                    <span className="rcal-marks" aria-hidden>
                      {marks.slice(0, 4).map((x) => x.routine
                        ? <i key="routine" className="rcal-mark is-routine" />
                        : <i key={markKey(x)} className={`rcal-mark is-${x.e.kind}`} style={toneStyle(x.row.tone)} />)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {pickedEvents.length > 0 && (
            <div className="pop-tile rcal-day-tile">
              <div className="pop-tile-label">{picked === todayKey ? 'Today' : fmtDay(pickedEvents[0]!.at, now)}</div>
              {pickedEvents.map(({ e, row, routine, at }, i) => routine ? (
                <button key={i} type="button" className="rcal-ev is-routine" disabled={!onOpenRoutine}
                  onClick={() => { setOpen(false); onOpenRoutine?.(routine.id); }}
                  title={`${routine.name} · ${describeSchedule(routine)} · ${routine.vpsName ?? ''}:${routine.cwd}`}>
                  <i className="rcal-mark is-routine" aria-hidden />
                  <span className="rcal-ev-time">{fmtTime(at)}</span>
                  <AgentLogo kind={routine.kind} size={12} title="" />
                  <span className="rcal-ev-who">{routine.name}</span>
                  <span className="rcal-ev-what is-routine">
                    <IconArrowRepeat />{routine.vpsName ?? 'routine'}
                  </span>
                </button>
              ) : (
                <div key={i} className="rcal-ev" style={toneStyle(row.tone)}>
                  <i className={`rcal-mark is-${e.kind}`} aria-hidden />
                  <span className="rcal-ev-time">{fmtTime(e.at)}</span>
                  <AgentLogo kind={row.account.provider} profileNumber={row.account.number} size={12} title="" />
                  <span className="rcal-ev-who" title={whoOf(row.account)}>{accountShortName(row.account) || providerName(row.account.provider)}</span>
                  <span className={`rcal-ev-what is-${e.kind}`}>
                    {e.kind === 'expiry' && <IconArrowCounterclockwise />}
                    {e.what.join(' · ')}{e.count && e.count > 1 ? ` ×${e.count}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="pop-tile rcal-accounts">
            {rows.length ? rows.map((row) => {
              const usage = data.usage[row.account.id] ?? null;
              const next = row.events.find((e) => e.kind === 'refill') ?? null;
              const weekly = usage?.ok ? usage.sevenDay?.utilization ?? null : null;
              const resets = usage?.resets?.available ?? 0;
              // Facts, not controls: the only action in a row is its resets pill.
              return (
                <div key={row.account.id} className="rcal-acct" style={toneStyle(row.tone)}>
                  <span className="rcal-acct-who" title={whoOf(row.account)}>
                    <i className="rcal-swatch" aria-hidden />
                    <AgentLogo kind={row.account.provider} profileNumber={row.account.number} size={13} title="" />
                    <span className="rcal-acct-name">{accountShortName(row.account) || providerName(row.account.provider)}</span>
                  </span>
                  {weekly != null && <span className={`rcal-acct-pct um-${sevClass(undefined, weekly)}`} title="weekly limit used">{fmtPct(weekly)}</span>}
                  {next && (
                    <span className="rcal-acct-next" title={`${next.what.join(' + ')} refill · ${fmtDay(next.at, now)} ${fmtTime(next.at)}`}>
                      ↻ {next.at - now < 48 * 3_600_000 ? fmtIn(next.at, now) : fmtShortDay(next.at)}
                    </span>
                  )}
                  {resets > 0 && (
                    <button type="button" className="pop-action rcal-acct-resets" onClick={() => openAccountResets(row.account.id)}
                      title="banked limit resets" aria-label={`${resets} limit reset${resets > 1 ? 's' : ''}`}>
                      <IconArrowCounterclockwise />{resets}
                    </button>
                  )}
                </div>
              );
            }) : <div className="um-empty rcal-none">No account</div>}
          </div>

          <div className="rcal-key" aria-hidden>
            <span><i className="rcal-mark is-refill" /> limit refills</span>
            <span><i className="rcal-mark is-expiry" /> reset expires</span>
            {!!routines?.some((r) => r.enabled) && <span><i className="rcal-mark is-routine" /> routine</span>}
          </div>
        </div>
      )}
    </div>
  );
}
