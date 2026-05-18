'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import BootstrapBanner from './BootstrapBanner';
import LoginConsole from './LoginConsole';

type Props = {
  onClose: () => void;
  initialVps: Vps[];
  initialPaths: VpsPath[];
  onChange?: (next: { vps: Vps[]; paths: VpsPath[] }) => void;
};

export default function DataModal({ onClose, initialVps, initialPaths, onChange }: Props) {
  const [tab, setTab] = useState<'vps' | 'paths'>('vps');
  const [vpsList, setVpsList] = useState<Vps[]>(initialVps);
  const [paths, setPaths] = useState<VpsPath[]>(initialPaths);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapVps, setBootstrapVps] = useState<Vps | null>(null);
  const [loginVps, setLoginVps] = useState<Vps | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loginVps && !bootstrapVps) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, loginVps, bootstrapVps]);

  function notify(nextVps?: Vps[], nextPaths?: VpsPath[]) {
    onChange?.({
      vps: nextVps ?? vpsList,
      paths: nextPaths ?? paths,
    });
  }

  // ─── VPS ─────────────────────────────────────────────
  const [vpsForm, setVpsForm] = useState({ name: '', ip: '', sshUser: 'root', sshPort: '22', defaultPath: '' });
  async function addVps() {
    setErr(null);
    if (!vpsForm.name.trim() || !vpsForm.ip.trim() || !vpsForm.sshUser.trim()) {
      setErr('nom, ip et user requis');
      return;
    }
    try {
      const row: any = await api.createVps({
        name: vpsForm.name.trim(),
        ip: vpsForm.ip.trim(),
        sshUser: vpsForm.sshUser.trim(),
        sshPort: Number(vpsForm.sshPort) || 22,
        defaultPath: vpsForm.defaultPath.trim() || null,
      });
      const next = [...vpsList, row];
      setVpsList(next);
      notify(next);
      setVpsForm({ name: '', ip: '', sshUser: 'root', sshPort: '22', defaultPath: '' });
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deleteVps(id: string) {
    if (!confirm('supprimer ce VPS ? Ses paths et ses sessions seront aussi supprimés.')) return;
    try {
      await api.deleteVps(id);
      const nextVps = vpsList.filter((v) => v.id !== id);
      const nextPaths = paths.filter((p) => p.vpsId !== id);
      setVpsList(nextVps);
      setPaths(nextPaths);
      notify(nextVps, nextPaths);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  // ─── Paths ────────────────────────────────────────────
  const [pathForm, setPathForm] = useState({ vpsId: '', path: '', label: '' });
  async function addPath() {
    setErr(null);
    if (!pathForm.vpsId || !pathForm.path.trim()) {
      setErr('vps et path requis');
      return;
    }
    try {
      const row: any = await api.createVpsPath({
        vpsId: pathForm.vpsId,
        path: pathForm.path.trim(),
        label: pathForm.label.trim() || null,
      });
      // Dedup par id (POST est idempotent → peut retourner une row existante)
      const next = paths.some((p) => p.id === row.id)
        ? paths.map((p) => (p.id === row.id ? row : p))
        : [...paths, row];
      setPaths(next);
      notify(undefined, next);
      setPathForm({ vpsId: pathForm.vpsId, path: '', label: '' });
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deletePath(id: number) {
    try {
      await api.deleteVpsPath(id);
      const next = paths.filter((p) => p.id !== id);
      setPaths(next);
      notify(undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function updatePathLabel(id: number, label: string) {
    try {
      const updated: any = await api.updateVpsPath(id, { label: label.trim() || null });
      const next = paths.map((p) => (p.id === id ? updated : p));
      setPaths(next);
      notify(undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  const vpsById = new Map(vpsList.map((v) => [v.id, v] as const));

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal data-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>données</h2>
        <div className="data-tabs">
          <button className={tab === 'vps' ? 'on' : ''} onClick={() => setTab('vps')}>VPS ({vpsList.length})</button>
          <button className={tab === 'paths' ? 'on' : ''} onClick={() => setTab('paths')}>paths ({paths.length})</button>
        </div>
        {err && <div className="data-err">{err}</div>}

        {tab === 'vps' && (
          <div className="data-tab">
            <div className="data-add">
              <input placeholder="nom" value={vpsForm.name} onChange={(e) => setVpsForm({ ...vpsForm, name: e.target.value })} />
              <input placeholder="ip" value={vpsForm.ip} onChange={(e) => setVpsForm({ ...vpsForm, ip: e.target.value })} />
              <input placeholder="ssh user" value={vpsForm.sshUser} onChange={(e) => setVpsForm({ ...vpsForm, sshUser: e.target.value })} style={{ maxWidth: 90 }} />
              <input placeholder="port" value={vpsForm.sshPort} onChange={(e) => setVpsForm({ ...vpsForm, sshPort: e.target.value })} style={{ maxWidth: 60 }} inputMode="numeric" />
              <input placeholder="default path (opt.)" value={vpsForm.defaultPath} onChange={(e) => setVpsForm({ ...vpsForm, defaultPath: e.target.value })} />
              <button className="primary" onClick={addVps}>ajouter</button>
            </div>
            {vpsList.length === 0 ? (
              <ul className="data-list"><li className="empty">aucun VPS</li></ul>
            ) : (
              <div className="path-groups">
                {[...vpsList].sort((a, b) => a.name.localeCompare(b.name)).map((v) => {
                  const vpsPathsRows = paths.filter((p) => p.vpsId === v.id)
                    .sort((a, b) => (a.label ?? a.path).localeCompare(b.label ?? b.path));
                  return (
                    <section key={v.id} className="path-group">
                      <header className="path-group-head">
                        <span className="pg-name">{v.name}</span>
                        <span className="pg-meta">{v.sshUser}@{v.ip}:{v.sshPort}{v.defaultPath ? ` · ${v.defaultPath}` : ''}</span>
                        <span className={`pg-agent agent-${(v as any).agentStatus ?? 'unknown'}`} title={`agent: ${(v as any).agentStatus ?? 'unknown'}${(v as any).agentVersion ? ` v${(v as any).agentVersion}` : ''}`}>
                          {(v as any).agentStatus === 'ok' ? '●' : (v as any).agentStatus === 'missing' ? '○' : (v as any).agentStatus === 'error' ? '◐' : '?'}
                        </span>
                        <span className="pg-count">{vpsPathsRows.length}</span>
                        <button className="pg-action" onClick={() => setBootstrapVps(v)} title="installer/réparer l'agent">install</button>
                        <button className="pg-action" onClick={() => setLoginVps(v)} title="claude login interactif">login</button>
                        <button className="row-del pg-del" onClick={() => deleteVps(v.id)} title="supprimer ce VPS">✕</button>
                      </header>
                      {vpsPathsRows.length > 0 && (
                        <ul className="path-group-list">
                          {vpsPathsRows.map((p) => (
                            <li key={p.id}>
                              <span className="pg-glyph">▤</span>
                              <input
                                className="pg-label-input"
                                defaultValue={p.label ?? ''}
                                placeholder={p.path.split('/').filter(Boolean).pop() || '(root)'}
                                onBlur={(e) => {
                                  if ((e.target.value.trim() || null) !== (p.label ?? null)) {
                                    updatePathLabel(p.id, e.target.value);
                                  }
                                }}
                                title="label personnalisé (vide = basename du path)"
                              />
                              <span className="pg-path">{p.path}</span>
                              <button className="row-del" onClick={() => deletePath(p.id)} title="supprimer ce path">✕</button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {vpsPathsRows.length === 0 && (
                        <div className="pg-empty">aucun path enregistré</div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'paths' && (
          <div className="data-tab">
            <div className="data-add">
              <select value={pathForm.vpsId} onChange={(e) => setPathForm({ ...pathForm, vpsId: e.target.value })}>
                <option value="">— vps —</option>
                {vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <input placeholder="path (ex: /srv/foo)" value={pathForm.path} onChange={(e) => setPathForm({ ...pathForm, path: e.target.value })} />
              <input placeholder="label (optionnel)" value={pathForm.label} onChange={(e) => setPathForm({ ...pathForm, label: e.target.value })} />
              <button className="primary" onClick={addPath}>ajouter</button>
            </div>
            {paths.length === 0 ? (
              <ul className="data-list"><li className="empty">aucun path</li></ul>
            ) : (
              <div className="path-groups">
                {(() => {
                  // Groupe par VPS, ordre alphabétique
                  const groups = new Map<string, VpsPath[]>();
                  for (const r of paths) {
                    const arr = groups.get(r.vpsId) ?? [];
                    arr.push(r);
                    groups.set(r.vpsId, arr);
                  }
                  const ordered = [...groups.entries()].sort((a, b) => {
                    const an = vpsById.get(a[0])?.name ?? 'zzz';
                    const bn = vpsById.get(b[0])?.name ?? 'zzz';
                    return an.localeCompare(bn);
                  });
                  return ordered.map(([vpsId, rows]) => {
                    const v = vpsById.get(vpsId);
                    rows.sort((a, b) => (a.label ?? a.path).localeCompare(b.label ?? b.path));
                    return (
                      <section key={vpsId} className="path-group">
                        <header className="path-group-head">
                          <span className="pg-name">{v?.name ?? '(VPS introuvable)'}</span>
                          {v && <span className="pg-meta">{v.sshUser}@{v.ip}</span>}
                          <span className="pg-count">{rows.length}</span>
                        </header>
                        <ul className="path-group-list">
                          {rows.map((p) => (
                            <li key={p.id}>
                              <span className="pg-glyph">▤</span>
                              <input
                                className="pg-label-input"
                                defaultValue={p.label ?? ''}
                                placeholder={p.path.split('/').filter(Boolean).pop() || '(root)'}
                                onBlur={(e) => {
                                  if ((e.target.value.trim() || null) !== (p.label ?? null)) {
                                    updatePathLabel(p.id, e.target.value);
                                  }
                                }}
                              />
                              <span className="pg-path">{p.path}</span>
                              <button className="row-del" onClick={() => deletePath(p.id)} title="supprimer">✕</button>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        )}
      </div>
      {bootstrapVps && (
        <BootstrapBanner
          vps={bootstrapVps}
          onDone={() => setBootstrapVps(null)}
          onCancel={() => setBootstrapVps(null)}
        />
      )}
      {loginVps && (
        <LoginConsole vps={loginVps} onClose={() => setLoginVps(null)} />
      )}
    </div>
  );
}
