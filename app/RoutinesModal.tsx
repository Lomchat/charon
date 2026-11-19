'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import PickerControl from './PickerControl';
import Switch from './Switch';
import { IconAlarm, IconClockHistory } from './icons';
import { PROVIDER_CATALOGS } from './modelPickers';
import { fmtCountdown, fmtMoment } from './taskTime';
import { api } from '@/lib/api';
import { MODE_LABELS, providerName } from '@/lib/providerText';
import { SESSION_PROVIDERS, hasEffortAxis, sessionModes, type SessionProvider } from '@/lib/sessionCapabilities';
import { describeSchedule, isValidSchedule, nextRunAt } from '@/lib/routineSchedule';
import type { RoutineInput, RoutineRun, RoutineView, SessionListItem } from '@/lib/types/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import PathChooser, { knownPathsFor, type KnownPath } from './PathChooser';

// ── RoutinesModal ────────────────────────────────────────────────────────────
// The routines (CLAUDE.md §14.120), in the Settings modal's shape: the left
// nav lists them (plus a new one and the run history), the pane edits the
// selected one. A run is a real session: "open" jumps to it.

type Draft = Required<Omit<RoutineInput, 'model' | 'effort' | 'permissionMode'>> & {
  model: string; effort: string; permissionMode: string;
};

/** Weekdays in display order, Monday first; values stay 0 = Sunday. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function blankDraft(vpsList: Vps[]): Draft {
  return {
    name: '', enabled: true, days: [0], time: '09:00', timezone: browserZone(),
    vpsId: vpsList[0]?.id ?? '', cwd: '', kind: 'claude',
    // The newest Opus, whatever it is the day the routine runs.
    model: 'opus', effort: '', permissionMode: '', prompt: '', keepRuns: 4,
  };
}

function draftOf(r: RoutineView): Draft {
  return {
    name: r.name, enabled: r.enabled, days: r.days, time: r.time, timezone: r.timezone,
    vpsId: r.vpsId, cwd: r.cwd, kind: r.kind, model: r.model ?? '', effort: r.effort ?? '',
    permissionMode: r.permissionMode ?? '', prompt: r.prompt, keepRuns: r.keepRuns,
  };
}

function inputOf(d: Draft): RoutineInput {
  return {
    ...d, name: d.name.trim(), cwd: d.cwd.trim(), prompt: d.prompt,
    model: d.model || null, effort: d.effort || null, permissionMode: d.permissionMode || null,
  };
}

/** The pill a run's status reads as (shared `.tm-pill` palette). */
function statusTone(status: string | null): string {
  if (!status) return 'paused';
  if (['thinking', 'starting', 'background'].includes(status)) return 'running';
  if (status === 'active' || status === 'sleeping') return 'completed';
  if (status === 'error' || status === 'failed') return 'failed';
  return 'paused';
}
function statusLabel(status: string | null): string {
  if (!status) return '—';
  if (status === 'active' || status === 'sleeping') return 'done';
  if (status === 'thinking' || status === 'background') return 'working';
  return status;
}

export default function RoutinesModal({ onClose, vpsList, vpsPaths, sessions, onOpenSession, initial, selectId }: {
  onClose: () => void;
  /** Open on a NEW routine prefilled with these (the composer's `/routine`). */
  initial?: Pick<RoutineInput, 'vpsId' | 'cwd' | 'kind' | 'prompt'> | null;
  /** Open on this routine (the calendar's run), else the first one. */
  selectId?: string | null;
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  /** For the folder suggestions: where sessions already run. */
  sessions: SessionListItem[];
  onOpenSession: (id: string) => void;
}) {
  const [routines, setRoutines] = useState<RoutineView[] | null>(null);
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [sel, setSel] = useState<string>('new');
  const [draft, setDraft] = useState<Draft>(() => ({ ...blankDraft(vpsList), ...(initial ?? {}) }));
  const [dirty, setDirty] = useState(!!initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pathOpen, setPathOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathChecking, setPathChecking] = useState(false);

  const loadRuns = useCallback(() => {
    api.listRoutineRuns().then((r) => setRuns(r.runs)).catch(() => setRuns([]));
  }, []);
  useEffect(() => {
    api.listRoutines().then((r) => {
      setRoutines(r.routines);
      const first = r.routines.find((x) => x.id === selectId) ?? r.routines[0];
      if (first && !initial) { setSel(first.id); setDraft(draftOf(first)); }
    }).catch((e) => { setRoutines([]); setError(e instanceof Error ? e.message : String(e)); });
    loadRuns();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [loadRuns]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = routines?.find((r) => r.id === sel) ?? null;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); };

  function pick(id: string) {
    setError(null); setNotice(null); setDirty(false); setSel(id);
    if (id === 'new') setDraft(blankDraft(vpsList));
    else if (id !== 'runs') {
      const r = routines?.find((x) => x.id === id);
      if (r) setDraft(draftOf(r));
    } else loadRuns();
  }

  async function act(label: string, run: () => Promise<void>) {
    setBusy(label); setError(null); setNotice(null);
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const save = () => act('save', async () => {
    if (sel === 'new') {
      const r = await api.createRoutine(inputOf(draft));
      setRoutines(r.routines); setSel(r.id);
      const created = r.routines.find((x) => x.id === r.id);
      if (created) setDraft(draftOf(created));
    } else {
      const r = await api.updateRoutine(sel, inputOf(draft));
      setRoutines(r.routines);
    }
    setDirty(false); setNotice('Saved.');
  });
  const remove = () => act('delete', async () => {
    const r = await api.deleteRoutine(sel);
    setRoutines(r.routines);
    pick(r.routines[0]?.id ?? 'new');
  });
  const runNow = () => act('run', async () => {
    const r = await api.runRoutine(sel);
    setRoutines(r.routines); loadRuns();
    setNotice('Started — the new session is in the sidebar.');
  });

  // The folder rows: the VPS's saved paths, then where its sessions run.
  const knownFolders = useMemo((): KnownPath[] => {
    const vps = vpsList.find((v) => v.id === draft.vpsId) ?? null;
    const rows = knownPathsFor(vps, vpsPaths);
    const seen = new Set(rows.map((r) => r.path));
    for (const cwd of [...new Set(sessions.filter((s) => s.vpsId === draft.vpsId).map((s) => s.cwd).filter(Boolean))].sort()) {
      if (!seen.has(cwd)) { seen.add(cwd); rows.push({ label: cwd.split('/').filter(Boolean).pop() || '/', path: cwd }); }
    }
    return rows;
  }, [vpsList, vpsPaths, sessions, draft.vpsId]);
  function openPath() { setPathDraft(draft.cwd); setPathError(null); setPathOpen(true); }
  async function submitPath() {
    const p = pathDraft.trim();
    if (!p) { setPathError('enter a path'); return; }
    if (!p.startsWith('/')) { setPathError('an absolute path, starting with /'); return; }
    setPathChecking(true);
    try {
      const r = await api.checkSessionPath(draft.vpsId, p);
      if (!r.ok) { setPathError(r.error); return; }
      set('cwd', r.resolved ?? p);
      setPathOpen(false);
    } catch {
      setPathError('The directory could not be verified on the VPS.');
    } finally { setPathChecking(false); }
  }
  const preview = isValidSchedule(draft) && draft.enabled ? nextRunAt(draft, now) : null;
  const kind = draft.kind as SessionProvider;
  const { Model, Effort } = PROVIDER_CATALOGS[kind];
  const valid = !!draft.name.trim() && !!draft.prompt.trim() && draft.cwd.trim().startsWith('/')
    && !!draft.vpsId && isValidSchedule(draft);

  return (
    <div className="app-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="app-modal settings-modal routines-modal" role="dialog" aria-modal="true" aria-label="Routines">
        <button className="modal-close" onClick={onClose} aria-label="Close routines" title="Close routines">✕</button>
        <h2>routines</h2>
        {routines == null ? <div className="empty">loading…</div> : (
          <>
            <div className="settings-body">
              <nav className="settings-nav" aria-label="routines">
                <div className="settings-nav-group">
                  <div className="settings-nav-group-label">Routines</div>
                  {routines.map((r) => (
                    <button key={r.id} type="button" className={`rt-nav${sel === r.id ? ' on' : ''}`} onClick={() => pick(r.id)}>
                      <IconAlarm />
                      <span className="rt-nav-text">
                        <span>{r.name}</span>
                        <small>{r.enabled ? describeSchedule(r) : 'paused'}</small>
                      </span>
                      <span className={`nav-state${r.enabled ? ' on' : ' off'}`} aria-hidden />
                    </button>
                  ))}
                  <button type="button" className={`rt-nav rt-new${sel === 'new' ? ' on' : ''}`} onClick={() => pick('new')}>
                    <span aria-hidden>＋</span><span>New routine</span>
                  </button>
                </div>
                <div className="settings-nav-group">
                  <div className="settings-nav-group-label">History</div>
                  <button type="button" className={`rt-nav${sel === 'runs' ? ' on' : ''}`} onClick={() => pick('runs')}>
                    <IconClockHistory /><span>Runs</span>
                    {!!runs?.length && <span className="rt-count">{runs.length}</span>}
                  </button>
                </div>
              </nav>

              <div className="settings-pane">
                {sel === 'runs' ? (
                  runs == null ? <div className="empty">loading…</div> : runs.length === 0
                    ? <p className="set-meta">No run yet. A routine&apos;s runs appear here, newest first.</p>
                    : <ul className="rt-runs">
                      {runs.map((run) => (
                        <li key={run.sessionId} className={run.archived ? 'archived' : ''}>
                          <span className={`tm-pill ${statusTone(run.status)}`}><i aria-hidden />{statusLabel(run.status)}</span>
                          <span className="rt-run-text">
                            <b>{run.name || run.routineName || 'run'}</b>
                            <small>{run.routineName ?? 'deleted routine'} · {fmtMoment(run.startedAt, now)} · {providerName(run.kind)}</small>
                          </span>
                          {run.unread && <span className="rt-unread" title="Finished, not read yet" aria-label="unread" />}
                          <button type="button" onClick={() => { onOpenSession(run.sessionId); onClose(); }}>open</button>
                        </li>
                      ))}
                    </ul>
                ) : (
                  <>
                    {current && (
                      <div className="rt-status">
                        <div>
                          <span className="rt-status-label">Next run</span>
                          {current.enabled && current.nextRunAt
                            ? <b>{fmtMoment(current.nextRunAt, now)} <small>({fmtCountdown(current.nextRunAt, now)})</small></b>
                            : <b>paused</b>}
                        </div>
                        <div>
                          <span className="rt-status-label">Last run</span>
                          {current.lastRunAt ? <>
                            <b>{fmtMoment(current.lastRunAt, now)}</b>
                            {current.lastStatus && <span className={`tm-pill ${statusTone(current.lastStatus)}`}><i aria-hidden />{statusLabel(current.lastStatus)}</span>}
                            {current.lastSessionId && current.lastStatus !== 'archived' && (
                              <button type="button" className="rt-link" onClick={() => { onOpenSession(current.lastSessionId!); onClose(); }}>open ↗</button>
                            )}
                          </> : <b>never</b>}
                        </div>
                        {current.lastError && <p className="rt-error">{current.lastError}</p>}
                      </div>
                    )}

                    <label>name
                      <input value={draft.name} maxLength={120} placeholder="SDK review" onChange={(e) => set('name', e.target.value)} />
                    </label>
                    <div className="switch-row">
                      <span>active</span>
                      <Switch checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Routine active" />
                    </div>

                    <div className="rt-field">
                      <span className="rt-field-label">when</span>
                      <div className="rt-days" role="group" aria-label="days">
                        {DAY_ORDER.map((d) => {
                          const on = draft.days.includes(d);
                          return <button key={d} type="button" className={`rt-day${on ? ' on' : ''}`} aria-pressed={on}
                            onClick={() => set('days', on ? draft.days.filter((x) => x !== d) : [...draft.days, d])}>{DAY_LABEL[d]}</button>;
                        })}
                        <input type="time" className="rt-time" value={draft.time} required
                          onChange={(e) => set('time', e.target.value)} aria-label="time" />
                      </div>
                      <p className="set-meta">
                        {isValidSchedule(draft) ? describeSchedule(draft) : 'pick at least one day'} · {draft.timezone}
                        {draft.timezone !== browserZone() && <> · <button type="button" className="rt-link" onClick={() => set('timezone', browserZone())}>use {browserZone()}</button></>}
                        {preview != null && <> · next: {fmtMoment(preview, now)}</>}
                      </p>
                    </div>

                    <label>VPS
                      <PickerControl value={draft.vpsId} onValueChange={(v) => { set('vpsId', v); setPathOpen(false); }}>
                        {vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </PickerControl>
                    </label>
                    {/* The folder: the same chooser as the new-session wizard
                        (known paths, then the server's real subdirectories). */}
                    <div className="rt-field">
                      <span className="rt-field-label">folder</span>
                      {!pathOpen ? (
                        <button type="button" className={`rt-folder${draft.cwd ? '' : ' empty'}`} onClick={openPath}>
                          <span className="rt-folder-glyph" aria-hidden>▤</span>
                          <span className="rt-folder-path">{draft.cwd || 'choose a folder…'}</span>
                          <span className="rt-folder-go">{draft.cwd ? 'change ›' : 'choose ›'}</span>
                        </button>
                      ) : (
                        <div className="rt-folder-chooser">
                          <PathChooser
                            vpsId={draft.vpsId}
                            label={<>Folder on <b>{vpsList.find((v) => v.id === draft.vpsId)?.name ?? 'the VPS'}</b></>}
                            known={knownFolders}
                            value={pathDraft}
                            onChange={(v) => { setPathDraft(v); setPathError(null); }}
                            onChoose={(p) => { set('cwd', p); setPathOpen(false); }}
                            onSubmit={() => void submitPath()}
                            busy={pathChecking}
                            status={pathError ? <>⚠ {pathError}</> : null}
                            statusError={!!pathError}
                            error={pathError}
                          />
                          <button type="button" className="rt-link rt-folder-cancel" onClick={() => setPathOpen(false)}>cancel</button>
                        </div>
                      )}
                    </div>

                    <div className="rt-grid">
                      <label>agent
                        <PickerControl value={draft.kind} onValueChange={(v) => {
                          setDraft((d) => ({ ...d, kind: v as SessionProvider, model: v === 'claude' ? 'opus' : '', effort: '', permissionMode: '' }));
                          setDirty(true);
                        }}>
                          {SESSION_PROVIDERS.map((p) => <option key={p} value={p}>{providerName(p)}</option>)}
                        </PickerControl>
                      </label>
                      <label>mode
                        <PickerControl value={draft.permissionMode} onValueChange={(v) => set('permissionMode', v)}>
                          <option value="">default for new sessions</option>
                          {sessionModes(kind).map((m) => <option key={m} value={m}>{MODE_LABELS[m] ?? m}</option>)}
                        </PickerControl>
                      </label>
                    </div>
                    <div className="rt-grid">
                      <label>model
                        <Model vpsId={draft.vpsId} value={draft.model} onChange={(v) => set('model', v)}
                          inheritPlaceholder="default for new sessions" />
                        {kind === 'claude' && draft.model === 'opus' && <span className="set-meta">opus = always the latest Opus, resolved at each run</span>}
                      </label>
                      {hasEffortAxis(kind) && <label>effort
                        <Effort vpsId={draft.vpsId} value={draft.effort} modelId={draft.model} onChange={(v) => set('effort', v)}
                          inheritPlaceholder="default for new sessions" />
                      </label>}
                    </div>

                    <label>prompt
                      <textarea className="mono rt-prompt" value={draft.prompt} rows={5} placeholder="/sdk-review"
                        onChange={(e) => set('prompt', e.target.value)} />
                      <span className="set-meta">The new session&apos;s first message. A skill works too: <code>/sdk-review</code>. It runs unattended: its permission requests and questions are refused, never waited on.</span>
                    </label>
                    <div className="rt-field">
                      <span className="rt-field-label">runs kept</span>
                      <div className="rt-stepper" role="group" aria-label="runs kept">
                        <button type="button" aria-label="keep fewer" disabled={draft.keepRuns <= 1}
                          onClick={() => set('keepRuns', Math.max(1, draft.keepRuns - 1))}>−</button>
                        <span className="rt-stepper-value" aria-live="polite">{draft.keepRuns}</span>
                        <button type="button" aria-label="keep more" disabled={draft.keepRuns >= 50}
                          onClick={() => set('keepRuns', Math.min(50, draft.keepRuns + 1))}>+</button>
                      </div>
                      <p className="set-meta">Older runs are archived (Resume a session… brings one back).</p>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="settings-foot modal-actions rt-foot">
              {error && <span className="rt-error" role="alert">{error}</span>}
              {!error && notice && <span className="set-meta">{notice}</span>}
              {sel !== 'runs' && sel !== 'new' && <>
                <button type="button" onClick={runNow} disabled={!!busy || dirty}
                  title={dirty ? 'Save first' : 'Start a run now'}>{busy === 'run' ? 'starting…' : 'run now'}</button>
                <button type="button" className="danger" onClick={remove} disabled={!!busy}>delete</button>
              </>}
              {sel !== 'runs' && <button type="button" className="primary" onClick={save} disabled={!!busy || !valid || (sel !== 'new' && !dirty)}>
                {busy === 'save' ? 'saving…' : sel === 'new' ? 'create' : 'save'}
              </button>}
              <button type="button" onClick={onClose}>close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
