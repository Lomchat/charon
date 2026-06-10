'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import type { ShellInfo } from '@/lib/server/shell/shellSession';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  initial?: { vpsId?: string; cwd?: string | null };
  onClose: () => void;
  onCreated: (shell: ShellInfo) => void;
};

// Mobile bottom-sheet to open a new SSH shell — the shell counterpart of
// <NewSessionSheet>. Same minimal field set as <NewShellDialog> (VPS + cwd +
// name): a shell is a plain PTY, no Claude SDK / model / effort. `cwd` is
// optional (blank → the SSH user's home).
export default function NewShellSheet({
  vpsList, vpsPaths, initial, onClose, onCreated,
}: Props) {
  const [vpsId, setVpsId] = useState(initial?.vpsId ?? vpsList[0]?.id ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cwdSuggestions = useMemo(() => {
    return vpsPaths
      .filter((p) => p.vpsId === vpsId)
      .map((p) => p.path)
      .sort();
  }, [vpsId, vpsPaths]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function create() {
    if (!vpsId || busy) return;
    setBusy(true); setErr(null);
    try {
      const shell = await api.startShell(vpsId, {
        cwd: cwd.trim() || null,
        name: name.trim() || null,
      });
      onCreated(shell);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="m-sheet-bg" onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-modal="true">
        <header className="m-sheet-head">
          <h2>new shell</h2>
          <button className="m-sheet-close" onClick={onClose} aria-label="close">✕</button>
        </header>
        <div className="m-sheet-body">
          <label>
            <span>VPS</span>
            <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
              {vpsList.map((v) => (
                <option key={v.id} value={v.id}>{v.name} ({v.sshUser}@{v.ip})</option>
              ))}
            </select>
          </label>

          <label>
            <span>cwd (path on the VPS — optional)</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="~ (user home)"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {cwdSuggestions.length > 0 && (
              <div className="m-sheet-suggestions">
                {cwdSuggestions.slice(0, 6).map((p) => (
                  <button key={p} type="button" onClick={() => setCwd(p)}>{p}</button>
                ))}
              </div>
            )}
          </label>

          <label>
            <span>name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. tail logs"
            />
          </label>

          {err && <div className="m-sheet-err">{err}</div>}

          <div className="m-sheet-actions">
            <button type="button" onClick={onClose}>cancel</button>
            <button
              type="button"
              className="primary"
              onClick={create}
              disabled={busy || !vpsId}
            >{busy ? '…' : 'open shell'}</button>
          </div>
        </div>
      </div>
    </>
  );
}
