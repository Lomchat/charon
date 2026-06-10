'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import type { ShellInfo } from '@/lib/server/shell/shellSession';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  // Pre-fill from the click context (the path button, the active tab's cwd…).
  initial?: { vpsId?: string; cwd?: string | null };
  onClose: () => void;
  onCreated: (shell: ShellInfo) => void;
};

/**
 * "New SSH shell" modal — the shell counterpart of <NewSessionDialog>.
 * Deliberately MINIMAL vs. the Claude-session dialog: a shell only needs a
 * VPS + an optional cwd + an optional name. No model/effort/SDK check — a
 * shell is a plain PTY hosted by the agent (cf. agent/charon_agent/holder.py),
 * it never touches the Claude SDK, so the Claude-readiness checks would be
 * noise here. `cwd` is OPTIONAL (blank → the SSH user's home), unlike a
 * session where it is required.
 */
export default function NewShellDialog({
  vpsList, vpsPaths, initial, onClose, onCreated,
}: Props) {
  const [vpsId, setVpsId] = useState(initial?.vpsId ?? vpsList[0]?.id ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cwdRef = useRef<HTMLInputElement>(null);

  // Path suggestions: the known cwds for the selected VPS (same source the
  // session dialog uses).
  const cwdSuggestions = useMemo(() => {
    return vpsPaths
      .filter((p) => p.vpsId === vpsId)
      .map((p) => p.path)
      .sort();
  }, [vpsId, vpsPaths]);

  // Esc closes; focus the cwd field on open (name is optional, path is the
  // thing a user most often tweaks).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => cwdRef.current?.focus(), 30);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [onClose]);

  async function create() {
    if (!vpsId || busy) return;
    setBusy(true); setErr(null);
    try {
      const shell = await api.startShell(vpsId, {
        cwd: cwd.trim() || null,    // blank → user home
        name: name.trim() || null,
      });
      onCreated(shell);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  // Enter in a text field submits (mirrors the implicit-submit feel of the
  // session dialog's primary button).
  function onFieldKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); create(); }
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>new shell</h2>

        <label>VPS
          <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
            {vpsList.map((v) => (
              <option key={v.id} value={v.id}>{v.name} ({v.sshUser}@{v.ip})</option>
            ))}
          </select>
        </label>

        <label>cwd (path on the VPS — optional)
          <input
            ref={cwdRef}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={onFieldKeyDown}
            placeholder="~ (user home)"
            list={`shell-cwd-suggest-${vpsId}`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <datalist id={`shell-cwd-suggest-${vpsId}`}>
            {cwdSuggestions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>

        <label>name (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onFieldKeyDown}
            placeholder="ex: tail logs"
          />
        </label>

        {err && <div className="modal-err">{err}</div>}

        <div className="modal-actions">
          <button className="primary" onClick={create} disabled={busy || !vpsId}>
            {busy ? 'opening…' : 'open shell'}
          </button>
          <button onClick={onClose}>cancel</button>
        </div>
      </div>
    </div>
  );
}
