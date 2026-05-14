'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, Project } from '@/lib/db/schema';
import type { VpsProjectLink } from './page';

type Props = {
  vpsList: Vps[];
  projects: Project[];
  vpsLinks: Record<string, VpsProjectLink[]>;
  initial?: { vpsId?: string; cwd?: string; projectId?: string | null };
  onClose: () => void;
  onCreated: (id: string) => void;
};

export default function NewSessionDialog({
  vpsList, projects, vpsLinks, initial, onClose, onCreated,
}: Props) {
  const [vpsId, setVpsId] = useState(initial?.vpsId ?? vpsList[0]?.id ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  // Toujours créé en "normal" — l'utilisateur change via le switch dans le chat
  // si besoin.
  const permissionMode = 'normal' as const;
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Suggestions de chemins : tous les paths uniques pour ce VPS
  const cwdSuggestions = useMemo(() => {
    const links = vpsLinks[vpsId] ?? [];
    const set = new Set<string>();
    for (const l of links) if (l.path) set.add(l.path);
    return Array.from(set).sort();
  }, [vpsId, vpsLinks]);

  useEffect(() => {
    if (!vpsId) return;
    setCheck(null);
    api.checkVpsClaude(vpsId)
      .then((r) => setCheck(r))
      .catch((e) => setCheck({ ok: false, error: String(e?.message ?? e) }));
  }, [vpsId]);

  async function setup() {
    setBusy(true);
    try {
      const r: any = await api.setupVpsClaude(vpsId);
      const tail = (r.stdout + '\n' + r.stderr).slice(-1500);
      alert((r.ok ? 'OK installé' : 'échec') + '\n\n' + tail);
      const c: any = await api.checkVpsClaude(vpsId);
      setCheck(c);
    } finally { setBusy(false); }
  }

  async function create() {
    if (!vpsId || !cwd.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r: any = await api.createClaudeSession({
        vpsId, cwd: cwd.trim(),
        name: name.trim() || null,
        projectId: projectId || null,
        permissionMode,
      });
      onCreated(r.id);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>nouvelle session</h2>

        <label>VPS
          <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
            {vpsList.map((v) => (
              <option key={v.id} value={v.id}>{v.name} ({v.sshUser}@{v.ip})</option>
            ))}
          </select>
        </label>

        <div className="check-info">
          {check === null && <em>vérification du VPS…</em>}
          {check && check.ok && (
            <span className="ok">
              ✓ sdk {check.sdk}, python {check.python}
              {check.authOk === false && ' — (claude login manquant)'}
            </span>
          )}
          {check && !check.ok && (
            <>
              <span className="warn">
                {check.sdkInstalled ? 'sdk ok' : '⚠ sdk manquant'} ·
                {check.cliInstalled ? ' cli ok' : ' ⚠ cli manquant'}
                {check.authOk === false && ' · ⚠ pas de claude login'}
              </span>
              {!check.sdkInstalled && (
                <button onClick={setup} disabled={busy}>installer le SDK</button>
              )}
            </>
          )}
        </div>

        <label>cwd (chemin sur le VPS)
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/srv/hub"
            list={`cwd-suggest-${vpsId}`}
          />
          <datalist id={`cwd-suggest-${vpsId}`}>
            {cwdSuggestions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>

        <label>nom (optionnel)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex : refacto auth" />
        </label>

        <label>projet du hub (optionnel)
          <select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">— aucun</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.glyph} {p.name}</option>)}
          </select>
        </label>

        {err && <div className="modal-err">{err}</div>}

        <div className="modal-actions">
          <button className="primary" onClick={create} disabled={busy || !cwd.trim() || !vpsId}>démarrer</button>
          <button onClick={onClose}>annuler</button>
        </div>
      </div>
    </div>
  );
}
