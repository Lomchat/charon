'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, ClaudeSession } from '@/lib/db/schema';

type ScannedSession = {
  sessionId: string;
  cwd: string;
  mtime: number;
  size: number;
  summary?: string;
};

type Props = {
  vpsList: Vps[];
  dbSessions: ClaudeSession[];
  initialVpsId?: string;
  onClose: () => void;
  onImported: (id: string) => void;
  onResumed: (id: string) => void;
};

export default function ResumeModal({
  vpsList, dbSessions, initialVpsId, onClose, onImported, onResumed,
}: Props) {
  const [vpsId, setVpsId] = useState(initialVpsId ?? vpsList[0]?.id ?? '');
  const [scanLoading, setScanLoading] = useState(false);
  const [scanned, setScanned] = useState<ScannedSession[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const dbForVps = dbSessions.filter((s) => s.vpsId === vpsId);
  const dbClaudeIds = useMemo(() => new Set(dbForVps.map((s) => s.claudeSessionId).filter(Boolean) as string[]), [dbForVps]);
  const resumable = dbForVps.filter((s) => s.status === 'sleeping' || s.status === 'error');

  async function doScan() {
    setScanLoading(true); setScanError(null); setScanned(null);
    try {
      const r: any = await api.scanVpsClaude(vpsId);
      setScanned(r.sessions ?? []);
    } catch (e: any) {
      setScanError(String(e?.message ?? e));
    } finally { setScanLoading(false); }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { if (vpsId) doScan(); }, [vpsId]); // eslint-disable-line

  async function importScanned(s: ScannedSession) {
    setBusy(s.sessionId);
    try {
      const r: any = await api.importClaudeSession({
        vpsId, claudeSessionId: s.sessionId, cwd: s.cwd,
        name: s.summary ? s.summary.slice(0, 60) : null,
      });
      onImported(r.id);
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
    return Math.floor(d / 86400) + 'j';
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal resume">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>sessions resume-ables</h2>

        <label>VPS
          <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
            {vpsList.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>

        <h3>en DB ({resumable.length})</h3>
        {resumable.length === 0 && <p className="empty">aucune session endormie ou en erreur</p>}
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

        <h3>sur le VPS, non importées ({scanned ? scanned.filter((s) => !dbClaudeIds.has(s.sessionId)).length : '?'})
          <button className="reload" onClick={doScan} disabled={scanLoading}>{scanLoading ? '…' : '⟳'}</button>
        </h3>
        {scanError && <p className="err">{scanError}</p>}
        {scanned && (
          <ul className="resume-list">
            {scanned.filter((s) => !dbClaudeIds.has(s.sessionId)).map((s) => (
              <li key={s.sessionId}>
                <span className="tag tag-scan">scan</span>
                <span className="name">{s.summary || s.sessionId.slice(0, 8)}</span>
                <span className="cwd">{s.cwd}</span>
                <span className="ago">{fmtAgo(s.mtime)}</span>
                <button onClick={() => importScanned(s)} disabled={busy === s.sessionId}>importer</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
