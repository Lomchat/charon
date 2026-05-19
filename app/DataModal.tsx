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

const AGENT_BADGE: Record<string, { glyph: string; label: string }> = {
  ok:      { glyph: '●', label: 'agent ok' },
  missing: { glyph: '○', label: 'agent non installé' },
  error:   { glyph: '◐', label: 'agent en erreur' },
  unknown: { glyph: '?', label: 'agent non testé' },
};

export default function DataModal({ onClose, initialVps, initialPaths, onChange }: Props) {
  const [vpsList, setVpsList] = useState<Vps[]>(initialVps);
  const [paths, setPaths] = useState<VpsPath[]>(initialPaths);
  const [err, setErr] = useState<string | null>(null);
  const [bootstrapVps, setBootstrapVps] = useState<Vps | null>(null);
  const [loginVps, setLoginVps] = useState<Vps | null>(null);
  const [addVpsOpen, setAddVpsOpen] = useState(false);
  // État du formulaire d'ajout de path par VPS (inline)
  const [pathInputs, setPathInputs] = useState<Record<string, { path: string; label: string }>>({});

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

  // ─── VPS CRUD ────────────────────────────────────────
  const [vpsForm, setVpsForm] = useState({ name: '', ip: '', sshUser: 'root', sshPort: '22', defaultPath: '' });
  async function addVps() {
    setErr(null);
    if (!vpsForm.name.trim() || !vpsForm.ip.trim() || !vpsForm.sshUser.trim()) {
      setErr('nom, ip et user requis');
      return;
    }
    try {
      const row = await api.createVps({
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
      setAddVpsOpen(false);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deleteVps(id: string, name: string) {
    if (!confirm(`Supprimer ${name} ?\nSes paths et sessions seront aussi supprimés.`)) return;
    try {
      await api.deleteVps(id);
      const nextVps = vpsList.filter((v) => v.id !== id);
      const nextPaths = paths.filter((p) => p.vpsId !== id);
      setVpsList(nextVps); setPaths(nextPaths);
      notify(nextVps, nextPaths);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  // ─── Paths CRUD ──────────────────────────────────────
  async function addPath(vpsId: string) {
    setErr(null);
    const form = pathInputs[vpsId] ?? { path: '', label: '' };
    if (!form.path.trim()) { setErr('path requis'); return; }
    try {
      const row = await api.createVpsPath({
        vpsId, path: form.path.trim(), label: form.label.trim() || null,
      });
      const next = paths.some((p) => p.id === row.id)
        ? paths.map((p) => (p.id === row.id ? row : p))
        : [...paths, row];
      setPaths(next);
      notify(undefined, next);
      setPathInputs((prev) => ({ ...prev, [vpsId]: { path: '', label: '' } }));
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function deletePath(id: number) {
    try {
      await api.deleteVpsPath(id);
      const next = paths.filter((p) => p.id !== id);
      setPaths(next); notify(undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function updatePathLabel(id: number, label: string) {
    try {
      const updated = await api.updateVpsPath(id, { label: label.trim() || null });
      const next = paths.map((p) => (p.id === id ? updated : p));
      setPaths(next); notify(undefined, next);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  function setPathInput(vpsId: string, field: 'path' | 'label', value: string) {
    setPathInputs((prev) => ({
      ...prev,
      [vpsId]: { path: prev[vpsId]?.path ?? '', label: prev[vpsId]?.label ?? '', [field]: value },
    }));
  }

  // ─── Render ──────────────────────────────────────────
  const sortedVps = [...vpsList].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal data-modal data-modal-v2">
        <button className="modal-close" onClick={onClose}>✕</button>
        <header className="data-head">
          <h2>VPS & paths</h2>
          <button
            className="data-add-vps-btn"
            onClick={() => setAddVpsOpen(!addVpsOpen)}
          >{addVpsOpen ? '− annuler' : '+ ajouter un VPS'}</button>
        </header>

        {err && <div className="data-err">{err}</div>}

        {addVpsOpen && (
          <div className="data-add data-add-vps">
            <input placeholder="nom" value={vpsForm.name} onChange={(e) => setVpsForm({ ...vpsForm, name: e.target.value })} autoFocus />
            <input placeholder="ip ou hostname" value={vpsForm.ip} onChange={(e) => setVpsForm({ ...vpsForm, ip: e.target.value })} />
            <input placeholder="ssh user" value={vpsForm.sshUser} onChange={(e) => setVpsForm({ ...vpsForm, sshUser: e.target.value })} style={{ maxWidth: 100 }} />
            <input placeholder="port" value={vpsForm.sshPort} onChange={(e) => setVpsForm({ ...vpsForm, sshPort: e.target.value })} style={{ maxWidth: 60 }} inputMode="numeric" />
            <input placeholder="default path (opt.)" value={vpsForm.defaultPath} onChange={(e) => setVpsForm({ ...vpsForm, defaultPath: e.target.value })} />
            <button className="primary" onClick={addVps}>créer</button>
          </div>
        )}

        <div className="data-vps-list">
          {sortedVps.length === 0 && (
            <div className="data-empty">aucun VPS — clique sur « ajouter un VPS » pour commencer</div>
          )}
          {sortedVps.map((v) => {
            const vpsPathsRows = paths.filter((p) => p.vpsId === v.id)
              .sort((a, b) => (a.label ?? a.path).localeCompare(b.label ?? b.path));
            const status = (v as any).agentStatus ?? 'unknown';
            const version = (v as any).agentVersion as string | undefined;
            const meta = AGENT_BADGE[status] ?? AGENT_BADGE.unknown;
            const form = pathInputs[v.id] ?? { path: '', label: '' };
            return (
              <section key={v.id} className={`data-vps-card agent-${status}`}>
                <header className="data-vps-head">
                  <span className="dv-glyph">▣</span>
                  <span className="dv-name">{v.name}</span>
                  <span className="dv-host">{v.sshUser}@{v.ip}{v.sshPort !== 22 ? `:${v.sshPort}` : ''}</span>
                  <span className={`dv-agent agent-${status}`} title={meta.label + (version ? ` (v${version})` : '')}>
                    {meta.glyph}<span className="dv-agent-text">{meta.label}</span>
                  </span>
                  <div className="dv-actions">
                    {status !== 'ok' && (
                      <button className="dv-btn primary" onClick={() => setBootstrapVps(v)}>install</button>
                    )}
                    <button className="dv-btn" onClick={() => setLoginVps(v)}>login</button>
                    <button className="dv-btn danger" onClick={() => deleteVps(v.id, v.name)} title="supprimer ce VPS">✕</button>
                  </div>
                </header>

                <div className="data-vps-paths">
                  {vpsPathsRows.length === 0 && (
                    <div className="dv-empty">aucun path enregistré pour ce VPS</div>
                  )}
                  {vpsPathsRows.map((p) => (
                    <div key={p.id} className="dv-path-row">
                      <span className="dv-path-glyph">▤</span>
                      <input
                        className="dv-path-label"
                        defaultValue={p.label ?? ''}
                        placeholder={p.path.split('/').filter(Boolean).pop() || '(root)'}
                        onBlur={(e) => {
                          if ((e.target.value.trim() || null) !== (p.label ?? null)) {
                            updatePathLabel(p.id, e.target.value);
                          }
                        }}
                        title="label personnalisé (vide = basename du path)"
                      />
                      <span className="dv-path-path">{p.path}</span>
                      <button className="dv-path-del" onClick={() => deletePath(p.id)} title="supprimer ce path">✕</button>
                    </div>
                  ))}
                  <div className="dv-add-path">
                    <span className="dv-add-glyph">+</span>
                    <input
                      placeholder="label (optionnel)"
                      value={form.label}
                      onChange={(e) => setPathInput(v.id, 'label', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addPath(v.id); }}
                    />
                    <input
                      className="dv-add-path-input"
                      placeholder="/srv/foo"
                      value={form.path}
                      onChange={(e) => setPathInput(v.id, 'path', e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addPath(v.id); }}
                    />
                    <button
                      className="dv-add-btn"
                      onClick={() => addPath(v.id)}
                      disabled={!form.path.trim()}
                    >ajouter</button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
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
