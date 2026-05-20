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
  aiTitle?: string;
  lastPrompt?: string;
  firstUserText?: string;
  messageCount?: number;
  model?: string;
  gitBranch?: string;
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
      const r = await api.scanVpsClaude(vpsId);
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
      const title = s.aiTitle || s.summary || s.firstUserText;
      const r = await api.importClaudeSession({
        vpsId, claudeSessionId: s.sessionId, cwd: s.cwd,
        name: title ? title.slice(0, 60) : null,
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
    return Math.floor(d / 86400) + 'd';
  }

  function fmtSize(b: number) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KB';
    return (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function fmtModel(m?: string) {
    if (!m) return '';
    // claude-opus-4-7 → opus-4.7, claude-sonnet-4-6 → sonnet-4.6
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

        <h3>in DB ({resumable.length})</h3>
        {resumable.length === 0 && <p className="empty">no sleeping or errored sessions</p>}
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

        <h3>on the VPS, not imported ({scanned ? scanned.filter((s) => !dbClaudeIds.has(s.sessionId)).length : '?'})
          <button className="reload" onClick={doScan} disabled={scanLoading}>{scanLoading ? '…' : '⟳'}</button>
        </h3>
        {scanError && <p className="err">{scanError}</p>}
        {scanned && (
          <ul className="resume-list">
            {scanned.filter((s) => !dbClaudeIds.has(s.sessionId)).map((s) => {
              const title = s.aiTitle || s.summary || s.firstUserText || s.sessionId.slice(0, 8);
              const preview = s.lastPrompt || (s.firstUserText && s.firstUserText !== title ? s.firstUserText : '');
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
