'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, Project, VpsProjectPath } from '@/lib/db/schema';
import BootstrapBanner from './BootstrapBanner';
import LoginConsole from './LoginConsole';

type Props = {
  onClose: () => void;
  initialVps: Vps[];
  initialProjects: Project[];
  onChange?: (next: { vps: Vps[]; projects: Project[] }) => void;
};

const COLOR_TOKENS = ['gold', 'crimson', 'teal', 'lavender', 'parchment-soft'] as const;

export default function DataModal({ onClose, initialVps, initialProjects, onChange }: Props) {
  const [tab, setTab] = useState<'vps' | 'projects' | 'paths'>('vps');
  const [vpsList, setVpsList] = useState<Vps[]>(initialVps);
  const [projects, setProjects] = useState<Project[]>(initialProjects);
  const [paths, setPaths] = useState<VpsProjectPath[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapVps, setBootstrapVps] = useState<Vps | null>(null);
  const [loginVps, setLoginVps] = useState<Vps | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Si un sous-modal est ouvert, lui laisser gérer Échap.
      if (e.key === 'Escape' && !loginVps && !bootstrapVps) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, loginVps, bootstrapVps]);

  useEffect(() => {
    api.listVpsProjectPaths().then((r: any) => setPaths(r ?? [])).catch(() => setPaths([]));
  }, []);

  function notify(nextVps?: Vps[], nextProjects?: Project[]) {
    onChange?.({
      vps: nextVps ?? vpsList,
      projects: nextProjects ?? projects
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
        defaultPath: vpsForm.defaultPath.trim() || null
      });
      const next = [...vpsList, row];
      setVpsList(next);
      notify(next);
      setVpsForm({ name: '', ip: '', sshUser: 'root', sshPort: '22', defaultPath: '' });
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deleteVps(id: string) {
    if (!confirm('supprimer ce VPS ?')) return;
    try {
      await api.deleteVps(id);
      const next = vpsList.filter((v) => v.id !== id);
      setVpsList(next);
      notify(next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  // ─── Projects ─────────────────────────────────────────
  const [projForm, setProjForm] = useState({ name: '', glyph: '◆', colorToken: 'gold', url: '' });
  async function addProject() {
    setErr(null);
    if (!projForm.name.trim()) { setErr('nom requis'); return; }
    try {
      const row: any = await api.createProject({
        name: projForm.name.trim(),
        glyph: projForm.glyph || '◆',
        colorToken: projForm.colorToken || 'gold',
        url: projForm.url.trim() || null
      });
      const next = [...projects, row];
      setProjects(next);
      notify(undefined, next);
      setProjForm({ name: '', glyph: '◆', colorToken: 'gold', url: '' });
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deleteProject(id: string) {
    if (!confirm('supprimer ce projet ?')) return;
    try {
      await api.deleteProject(id);
      const next = projects.filter((p) => p.id !== id);
      setProjects(next);
      notify(undefined, next);
      setPaths((prev) => prev.filter((r) => r.projectId !== id));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  // ─── Paths ────────────────────────────────────────────
  const [pathForm, setPathForm] = useState({ vpsId: '', projectId: '', path: '' });
  async function addPath() {
    setErr(null);
    if (!pathForm.vpsId || !pathForm.projectId || !pathForm.path.trim()) {
      setErr('vps, projet et chemin requis');
      return;
    }
    try {
      const row: any = await api.createVpsProjectPath({
        vpsId: pathForm.vpsId, projectId: pathForm.projectId, path: pathForm.path.trim()
      });
      setPaths((prev) => prev.some((p) => p.id === row.id) ? prev : [...prev, row]);
      setPathForm({ vpsId: pathForm.vpsId, projectId: '', path: '' });
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deletePath(id: number) {
    try {
      await api.deleteVpsProjectPath(id);
      setPaths((prev) => prev.filter((r) => r.id !== id));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  const vpsById = new Map(vpsList.map((v) => [v.id, v] as const));

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal data-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>données</h2>
        <div className="data-tabs">
          <button className={tab === 'vps' ? 'on' : ''} onClick={() => setTab('vps')}>VPS ({vpsList.length})</button>
          <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>projets ({projects.length})</button>
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
                  // Paths qui pointent vers ce VPS
                  const vpsPaths = paths.filter((r) => r.vpsId === v.id);
                  vpsPaths.sort((a, b) => {
                    const an = projectById.get(a.projectId)?.name ?? '';
                    const bn = projectById.get(b.projectId)?.name ?? '';
                    return an.localeCompare(bn);
                  });
                  return (
                    <section key={v.id} className="path-group">
                      <header className="path-group-head">
                        <span className="pg-name">{v.name}</span>
                        <span className="pg-meta">{v.sshUser}@{v.ip}:{v.sshPort}{v.defaultPath ? ` · ${v.defaultPath}` : ''}</span>
                        <span className={`pg-agent agent-${v.agentStatus ?? 'unknown'}`} title={`agent: ${v.agentStatus ?? 'unknown'}${v.agentVersion ? ` v${v.agentVersion}` : ''}`}>
                          {v.agentStatus === 'ok' ? '●' : v.agentStatus === 'missing' ? '○' : v.agentStatus === 'error' ? '◐' : '?'}
                        </span>
                        <span className="pg-count">{vpsPaths.length}</span>
                        <button className="pg-action" onClick={() => setBootstrapVps(v)} title="installer/réparer l'agent">install</button>
                        <button className="pg-action" onClick={() => setLoginVps(v)} title="claude login interactif">login</button>
                        <button className="row-del pg-del" onClick={() => deleteVps(v.id)} title="supprimer ce VPS">✕</button>
                      </header>
                      {vpsPaths.length > 0 && (
                        <ul className="path-group-list">
                          {vpsPaths.map((r) => {
                            const p = projectById.get(r.projectId);
                            return (
                              <li key={r.id}>
                                <span className="pg-glyph">{p?.glyph ?? '?'}</span>
                                <span className="pg-proj">{p?.name ?? r.projectId}</span>
                                <span className="pg-path">{r.path}</span>
                                <button className="row-del" onClick={() => deletePath(r.id)} title="supprimer ce path">✕</button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {vpsPaths.length === 0 && (
                        <div className="pg-empty">aucun projet rattaché</div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === 'projects' && (
          <div className="data-tab">
            <div className="data-add">
              <input placeholder="nom" value={projForm.name} onChange={(e) => setProjForm({ ...projForm, name: e.target.value })} />
              <input placeholder="glyph" value={projForm.glyph} onChange={(e) => setProjForm({ ...projForm, glyph: e.target.value })} style={{ maxWidth: 60 }} />
              <select value={projForm.colorToken} onChange={(e) => setProjForm({ ...projForm, colorToken: e.target.value })}>
                {COLOR_TOKENS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input placeholder="url (opt.)" value={projForm.url} onChange={(e) => setProjForm({ ...projForm, url: e.target.value })} />
              <button className="primary" onClick={addProject}>ajouter</button>
            </div>
            <ul className="data-list">
              {projects.map((p) => (
                <li key={p.id}>
                  <span className="row-glyph">{p.glyph}</span>
                  <span className="row-main">{p.name}</span>
                  <span className="row-sub">{p.colorToken}{p.url ? ` · ${p.url}` : ''}</span>
                  <button className="row-del" onClick={() => deleteProject(p.id)}>✕</button>
                </li>
              ))}
              {projects.length === 0 && <li className="empty">aucun projet</li>}
            </ul>
          </div>
        )}

        {tab === 'paths' && (
          <div className="data-tab">
            <div className="data-add">
              <select value={pathForm.vpsId} onChange={(e) => setPathForm({ ...pathForm, vpsId: e.target.value })}>
                <option value="">— vps —</option>
                {vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <select value={pathForm.projectId} onChange={(e) => setPathForm({ ...pathForm, projectId: e.target.value })}>
                <option value="">— projet —</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.glyph} {p.name}</option>)}
              </select>
              <input placeholder="path (ex: /srv/foo)" value={pathForm.path} onChange={(e) => setPathForm({ ...pathForm, path: e.target.value })} />
              <button className="primary" onClick={addPath}>ajouter</button>
            </div>
            {paths.length === 0 ? (
              <ul className="data-list"><li className="empty">aucun path</li></ul>
            ) : (
              <div className="path-groups">
                {(() => {
                  // Groupe par VPS, ordre alphabétique. Paths sans VPS connu
                  // (id orphelin) atterrissent dans un groupe "(VPS introuvable)".
                  const groups = new Map<string, VpsProjectPath[]>();
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
                    rows.sort((a, b) => {
                      const an = projectById.get(a.projectId)?.name ?? '';
                      const bn = projectById.get(b.projectId)?.name ?? '';
                      return an.localeCompare(bn);
                    });
                    return (
                      <section key={vpsId} className="path-group">
                        <header className="path-group-head">
                          <span className="pg-name">{v?.name ?? '(VPS introuvable)'}</span>
                          {v && <span className="pg-meta">{v.sshUser}@{v.ip}</span>}
                          <span className="pg-count">{rows.length}</span>
                        </header>
                        <ul className="path-group-list">
                          {rows.map((r) => {
                            const p = projectById.get(r.projectId);
                            return (
                              <li key={r.id}>
                                <span className="pg-glyph">{p?.glyph ?? '?'}</span>
                                <span className="pg-proj">{p?.name ?? r.projectId}</span>
                                <span className="pg-path">{r.path}</span>
                                <button className="row-del" onClick={() => deletePath(r.id)} title="supprimer">✕</button>
                              </li>
                            );
                          })}
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
