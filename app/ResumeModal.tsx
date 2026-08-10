'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, ClaudeSession } from '@/lib/db/schema';
import type { AgentKind, ScannedSession } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { backendAvailability } from './vpsHealth';

// "Scan existing sessions" — one modal, TWO backends behind a tab bar.
//
// Both halves are symmetric on purpose (§14.59): the Codex scan route answers
// the same row shape as the Claude one, `claudeSessionId` carries the Codex
// THREAD id, and the import route dispatches the history fetch on `kind`. So
// the whole list/card rendering below is shared and only three things branch:
// the scan endpoint, the DB-list filter, and the codex-availability gate.
type Props = {
  vpsList: Vps[];
  dbSessions: ClaudeSession[];
  initialVpsId?: string;
  onClose: () => void;
  // vpsId + cwd travel with the id: the caller opens its tab immediately and
  // the session list it would look them up in is a beat behind.
  onImported: (created: { id: string; vpsId: string; cwd: string }) => void;
  onResumed: (id: string) => void;
};

const KINDS: AgentKind[] = ['claude', 'codex'];

export default function ResumeModal({
  vpsList, dbSessions, initialVpsId, onClose, onImported, onResumed,
}: Props) {
  const [vpsId, setVpsId] = useState(initialVpsId ?? vpsList[0]?.id ?? '');
  // Claude is the default tab (the historical behaviour of this button).
  const [kind, setKind] = useState<AgentKind>('claude');
  const [scanLoading, setScanLoading] = useState(false);
  // Scans are cached per (vps, kind) so flipping tabs back and forth doesn't
  // re-run an ssh round-trip that takes seconds on a big ~/.codex/sessions.
  const [scans, setScans] = useState<Record<string, ScannedSession[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const reqSeq = useRef(0);

  const cacheKey = `${vpsId}:${kind}`;
  const scanned = scans[cacheKey] ?? null;
  const scanError = errors[cacheKey] ?? null;

  const vps = vpsList.find((v) => v.id === vpsId);
  // ADVISORY only — never a gate. Scanning reads transcript files over ssh and
  // needs neither a signed-in account nor an installed backend, so a VPS whose
  // Codex is signed out must still list its threads: importing them is exactly
  // how you keep the history before fixing the login. What the reason DOES
  // predict is that the follow-up resume will fail, so we say so up front.
  const availability = vps ? backendAvailability(vps, kind) : null;
  const unusable = availability && !availability.ok ? availability.reason : null;

  const dbForVps = dbSessions.filter(
    (s) => s.vpsId === vpsId && ((s.kind ?? 'claude') === kind),
  );
  const dbKnownIds = useMemo(
    () => new Set(dbForVps.map((s) => s.claudeSessionId).filter(Boolean) as string[]),
    [dbForVps],
  );
  const resumable = dbForVps.filter((s) => s.status === 'sleeping' || s.status === 'error');
  const notImported = scanned ? scanned.filter((s) => !dbKnownIds.has(s.sessionId)) : null;

  async function doScan(force = false) {
    if (!vpsId) return;
    const key = `${vpsId}:${kind}`;
    if (!force && scans[key]) return;    // cached
    const seq = ++reqSeq.current;
    setScanLoading(true);
    setErrors((e) => { const n = { ...e }; delete n[key]; return n; });
    try {
      const r = kind === 'codex' ? await api.scanVpsCodex(vpsId) : await api.scanVpsClaude(vpsId);
      if (seq !== reqSeq.current) return;  // a newer tab/VPS switch won
      setScans((s) => ({ ...s, [key]: (r.sessions ?? []) as ScannedSession[] }));
    } catch (e: any) {
      if (seq !== reqSeq.current) return;
      setErrors((x) => ({ ...x, [key]: String(e?.message ?? e) }));
    } finally {
      if (seq === reqSeq.current) setScanLoading(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Scan on mount and on every (vps, kind) switch — cached, so a tab flip back
  // is instant.
  useEffect(() => { doScan(); }, [vpsId, kind]); // eslint-disable-line

  async function importScanned(s: ScannedSession) {
    setBusy(s.sessionId);
    try {
      const title = s.aiTitle || s.summary || s.firstUserText;
      const r = await api.importClaudeSession({
        vpsId, kind, claudeSessionId: s.sessionId, cwd: s.cwd,
        name: title ? title.slice(0, 60) : null,
      });
      onImported({ id: r.id, vpsId, cwd: s.cwd });
    } catch (e: any) {
      alert('import: ' + (e?.message ?? e));
    } finally { setBusy(null); }
  }

  async function resumeOne(id: string) {
    setBusy(id);
    try {
      await api.resumeClaudeSession(id);
      onResumed(id);
    } catch (e: any) {
      alert('resume: ' + (e?.message ?? e));
    } finally { setBusy(null); }
  }

  function fmtAgo(mtime: number) {
    const d = Date.now() / 1000 - mtime;
    if (d < 60) return Math.floor(d) + 's';
    if (d < 3600) return Math.floor(d / 60) + 'm';
    if (d < 86400) return Math.floor(d / 3600) + 'h';
    return Math.floor(d / 86400) + 'd';
  }

  function fmtSize(b: number) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KB';
    return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function fmtModel(m?: string) {
    if (!m) return '';
    // claude-opus-4-7 → opus-4.7, claude-sonnet-4-6 → sonnet-4.6.
    // Codex ids (gpt-5.6-sol) already read fine and are left untouched.
    const x = m.replace(/^claude-/, '');
    return x.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal resume">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>resumable sessions</h2>

        <label>VPS
          <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
            {vpsList.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>

        <div className="resume-tabs" role="tablist">
          {KINDS.map((k) => {
            const avail = vps ? backendAvailability(vps, k) : null;
            const off = avail && !avail.ok ? avail.reason : null;
            return (
              <button
                key={k}
                role="tab"
                aria-selected={kind === k}
                className={`resume-tab${kind === k ? ' active' : ''}${off ? ' unavailable' : ''}`}
                // NOT disabled on purpose: the tab stays clickable so the user
                // can read WHY the backend is unusable instead of facing a
                // dead control with no explanation.
                title={off ? `${k}: ${off}` : `${k} sessions on this VPS`}
                onClick={() => setKind(k)}
              >
                <AgentLogo kind={k} size={14} />
                <span>{k}</span>
              </button>
            );
          })}
        </div>

        {unusable && (
          <p className="resume-warn">
            {kind === 'codex' ? 'Codex' : 'Claude'} is {unusable} on this VPS — you can still
            import (the transcript is read over ssh), but resuming will fail until it is fixed.
          </p>
        )}

        <h3>in DB ({resumable.length})</h3>
        {resumable.length === 0 && <p className="empty">no sleeping or errored {kind} sessions</p>}
        <ul className="resume-list">
          {resumable.map((s) => (
            <li key={s.id}>
              <span className={`tag tag-${s.status}`}>{s.status}</span>
              <span className="name">{s.name || s.cwd.split('/').slice(-2).join('/')}</span>
              <span className="cwd">{s.cwd}</span>
              <button onClick={() => resumeOne(s.id)} disabled={busy === s.id}>resume</button>
            </li>
          ))}
        </ul>

        <h3>on the VPS, not imported ({notImported ? notImported.length : '?'})
          <button className="reload" onClick={() => doScan(true)} disabled={scanLoading}>
            {scanLoading ? '…' : '⟳'}
          </button>
        </h3>
        {scanError && <p className="err">{scanError}</p>}
        {scanned && notImported?.length === 0 && (
          <p className="empty">nothing left to import</p>
        )}
        {notImported && (
          <ul className="resume-list">
            {notImported.map((s) => {
              const title = s.aiTitle || s.summary || s.firstUserText || s.sessionId.slice(0, 8);
              const preview = s.lastPrompt || (s.firstUserText && s.firstUserText !== title ? s.firstUserText : '');
              const effort = 'effort' in s ? s.effort : undefined;   // Codex-only
              return (
                <li key={s.sessionId} className="scan-row">
                  <div className="scan-row-main">
                    <div className="scan-line-1">
                      <span className="tag tag-scan">scan</span>
                      <span className="name" title={title}>{title}</span>
                      <span className="ago">{fmtAgo(s.mtime)}</span>
                    </div>
                    <div className="scan-line-2">
                      <span className="cwd" title={s.cwd}>{s.cwd}</span>
                      {s.gitBranch && <span className="meta-pill branch" title="git branch">⎇ {s.gitBranch}</span>}
                      {typeof s.messageCount === 'number' && s.messageCount > 0 && (
                        <span className="meta-pill" title="messages">{s.messageCount} msg</span>
                      )}
                      {s.model && <span className="meta-pill" title="model">{fmtModel(s.model)}</span>}
                      {effort && <span className="meta-pill" title="reasoning effort">{effort}</span>}
                      <span className="meta-pill" title="file size">{fmtSize(s.size)}</span>
                    </div>
                    {preview && (
                      <div className="scan-preview" title={preview}>“{preview.length > 140 ? preview.slice(0, 140) + '…' : preview}”</div>
                    )}
                  </div>
                  <button onClick={() => importScanned(s)} disabled={busy === s.sessionId}>import</button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
