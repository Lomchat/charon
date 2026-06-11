'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import ModelPicker from './ModelPicker';
import EffortPicker from './EffortPicker';
import { IconRobot, IconTerminal } from './icons';

// 3-step "new session" wizard (prod). Kind (agent vs shell) is fixed by the
// button that opened it — no toggle inside.
//   1. pick a VPS   (grouped by folder; click = advance; skipped when a VPS
//      is passed in from a per-VPS ＋ button)
//   2. pick a path  (known paths + a custom one; "home" for shells)
//   3. name it (+ optional model/effort for agents) and launch
type Step = 'vps' | 'path' | 'name';
const DEFAULT_FOLDER_ID = 'default';

type Props = {
  kind: 'agent' | 'shell';
  vpsList: Vps[];
  vpsFolders: VpsFolder[];
  vpsPaths: VpsPath[];
  initialVpsId?: string;
  initialCwd?: string | null;
  onClose: () => void;
  onCreatedSession?: (id: string) => void;
  onCreatedShell?: (shell: ShellInfo) => void;
};

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || '(root)';
}

export default function NewSessionWizard({
  kind, vpsList, vpsFolders, vpsPaths, initialVpsId, initialCwd, onClose,
  onCreatedSession, onCreatedShell,
}: Props) {
  const hasInitialCwd = typeof initialCwd === 'string' && initialCwd.trim() !== '';
  const [vpsId, setVpsId] = useState<string | null>(initialVpsId ?? null);
  const [path, setPath] = useState<string | null>(hasInitialCwd ? initialCwd! : null);
  const [pathChosen, setPathChosen] = useState<boolean>(hasInitialCwd);
  const [name, setName] = useState('');
  const [custom, setCustom] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(initialVpsId ? (hasInitialCwd ? 'name' : 'path') : 'vps');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Optional per-session Claude config (agent only). Blank = inherit the
  // global default (SettingsModal § Claude defaults).
  const [showAdv, setShowAdv] = useState(false);
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState('');
  const [globalDefaults, setGlobalDefaults] = useState<{ model: string; fallbackModel: string; effort: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (kind !== 'agent') return;
    api.getClaudeSettings()
      .then((s) => setGlobalDefaults({
        model: s['claude.default_model'] ?? '',
        fallbackModel: s['claude.default_fallback_model'] ?? '',
        effort: s['claude.default_effort'] ?? '',
      }))
      .catch(() => {});
  }, [kind]);

  const vps = vpsId ? vpsList.find((v) => v.id === vpsId) ?? null : null;
  const kindLabel = kind === 'agent' ? 'Claude agent' : 'SSH shell';
  const KindIcon = kind === 'agent' ? IconRobot : IconTerminal;

  // VPSes grouped by folder ("default" folder last), only non-empty folders.
  const buckets = useMemo(() => {
    const sortedFolders = [...vpsFolders].sort((a, b) => {
      if (a.id === DEFAULT_FOLDER_ID) return 1;
      if (b.id === DEFAULT_FOLDER_ID) return -1;
      return a.position - b.position;
    });
    const byFolder = new Map<string, Vps[]>();
    for (const v of vpsList) {
      const arr = byFolder.get(v.folderId) ?? [];
      arr.push(v);
      byFolder.set(v.folderId, arr);
    }
    for (const arr of byFolder.values()) arr.sort((a, b) => a.position - b.position);
    const known = new Set(sortedFolders.map((f) => f.id));
    const out = sortedFolders
      .map((folder) => ({ folder, vps: byFolder.get(folder.id) ?? [] }))
      .filter((b) => b.vps.length > 0);
    const orphans = vpsList.filter((v) => !known.has(v.folderId));
    if (orphans.length > 0) out.push({ folder: { id: '__o', name: '(other)' } as VpsFolder, vps: orphans });
    return out;
  }, [vpsList, vpsFolders]);

  const pickList = useMemo(() => {
    if (!vps) return [] as { label: string; path: string }[];
    const rows = vpsPaths
      .filter((p) => p.vpsId === vps.id)
      .map((p) => ({ label: p.label || basename(p.path), path: p.path }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const dp = (vps as any).defaultPath as string | null | undefined;
    if (dp && !rows.some((r) => r.path === dp)) rows.unshift({ label: 'default', path: dp });
    return rows;
  }, [vps, vpsPaths]);

  function pickVps(v: Vps) {
    if (kind === 'agent' && ((v as any).agentStatus ?? 'unknown') !== 'ok') return;
    setVpsId(v.id);
    setPath(null); setPathChosen(false);
    setStep('path');
  }
  function choosePath(p: string | null) {
    setPath(p); setPathChosen(true); setPathError(null);
    setStep('name');
  }
  function submitCustom() {
    const p = custom.trim();
    if (!p) { setPathError('enter a path'); return; }
    choosePath(p);
  }

  async function launch() {
    if (!vps || busy) return;
    if (kind === 'agent' && (path == null || !path.trim())) { setStep('path'); setPathError('a path is required'); return; }
    setBusy(true); setErr(null);
    try {
      if (kind === 'agent') {
        const r = await api.createClaudeSession({
          vpsId: vps.id, cwd: path!.trim(),
          name: name.trim() || null,
          permissionMode: 'auto',
          model: model.trim() || null,
          fallbackModel: fallbackModel.trim() || null,
          effort: effort || null,
        });
        onCreatedSession?.(r.id);
      } else {
        const shell = await api.startShell(vps.id, {
          cwd: path ? path.trim() : null,   // null = user home
          name: name.trim() || null,
        });
        onCreatedShell?.(shell);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setBusy(false);
    }
  }

  const pathLabel = pathChosen ? (path == null ? '~ (home)' : path) : 'Path';

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`claude-modal wizard kind-${kind}`}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="wiz-head">
          <span className="wiz-kind"><KindIcon /> New {kindLabel}</span>
        </div>

        <div className="wiz-crumbs">
          <Crumb n={1} label={vps ? vps.name : 'VPS'} active={step === 'vps'}
            done={!!vps && step !== 'vps'} onClick={() => setStep('vps')} />
          <span className="wiz-crumb-sep">▸</span>
          <Crumb n={2} label={pathLabel} active={step === 'path'}
            done={pathChosen && step !== 'path'} disabled={!vps}
            onClick={() => vps && setStep('path')} />
          <span className="wiz-crumb-sep">▸</span>
          <Crumb n={3} label="Name" active={step === 'name'} done={false}
            disabled={!pathChosen} onClick={() => pathChosen && setStep('name')} />
        </div>

        {/* ── Step 1: VPS ── */}
        {step === 'vps' && (
          <div className="wiz-body">
            <div className="wiz-label">Choose a VPS</div>
            {buckets.length === 0 && <div className="wiz-error">no VPS — add one in « manage VPS »</div>}
            {buckets.map(({ folder, vps: list }) => (
              <div key={folder.id} className="wiz-folder">
                <div className="wiz-folder-name">▤ {folder.name}</div>
                <div className="wiz-pick-list">
                  {list.map((v) => {
                    const status = (v as any).agentStatus ?? 'unknown';
                    const disabled = kind === 'agent' && status !== 'ok';
                    return (
                      <button key={v.id}
                        className="wiz-pick"
                        onClick={() => pickVps(v)}
                        disabled={disabled}
                        title={disabled ? 'agent not ready on this VPS' : undefined}
                      >
                        <span className={`wiz-pick-dot agent-${status}`} />
                        <span className="wiz-pick-main">
                          <span className="wiz-pick-name">{v.name}</span>
                          <span className="wiz-pick-sub">{v.sshUser}@{v.ip}{disabled ? ' · agent not ready' : ''}</span>
                        </span>
                        <span className="wiz-pick-go">›</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Step 2: Path ── */}
        {step === 'path' && vps && (
          <div className="wiz-body">
            <div className="wiz-label">Path on <b>{vps.name}</b></div>
            <div className="wiz-pick-list">
              {kind === 'shell' && (
                <button className="wiz-pick" onClick={() => choosePath(null)}>
                  <span className="wiz-pick-glyph">~</span>
                  <span className="wiz-pick-main">
                    <span className="wiz-pick-name">home</span>
                    <span className="wiz-pick-sub">the SSH user's home directory</span>
                  </span>
                  <span className="wiz-pick-go">›</span>
                </button>
              )}
              {pickList.map((p) => (
                <button key={p.path} className="wiz-pick" onClick={() => choosePath(p.path)}>
                  <span className="wiz-pick-glyph">▤</span>
                  <span className="wiz-pick-main">
                    <span className="wiz-pick-name">{p.label}</span>
                    <span className="wiz-pick-sub mono">{p.path}</span>
                  </span>
                  <span className="wiz-pick-go">›</span>
                </button>
              ))}
            </div>
            <div className="wiz-custom">
              <input
                placeholder="/custom/path…"
                value={custom}
                onChange={(e) => { setCustom(e.target.value); setPathError(null); }}
                onKeyDown={(e) => e.key === 'Enter' && submitCustom()}
                autoCapitalize="off" autoCorrect="off" spellCheck={false}
              />
              <button className="wiz-btn primary" onClick={submitCustom}>Use ›</button>
            </div>
            {pathError && <div className="wiz-error">⚠ {pathError}</div>}
          </div>
        )}

        {/* ── Step 3: Name + launch ── */}
        {step === 'name' && vps && (
          <div className="wiz-body">
            <div className="wiz-label">Name <span className="wiz-opt">(optional)</span></div>
            <input
              className="wiz-name-input"
              autoFocus
              placeholder={kind === 'agent' ? 'e.g. sidebar redesign' : 'e.g. tail logs'}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') launch(); }}
            />

            {kind === 'agent' && (
              <div className="wiz-adv">
                <button className="wiz-adv-toggle" onClick={() => setShowAdv((v) => !v)}>
                  {showAdv ? '▾' : '▸'} advanced · model & effort
                </button>
                {showAdv && (
                  <div className="wiz-adv-body">
                    <label className="wiz-adv-field">model
                      <ModelPicker value={model} onChange={setModel} inheritPlaceholder={globalDefaults?.model || undefined} />
                    </label>
                    <label className="wiz-adv-field">fallback model
                      <ModelPicker value={fallbackModel} onChange={setFallbackModel} inheritPlaceholder={globalDefaults?.fallbackModel || 'none'} />
                    </label>
                    <label className="wiz-adv-field">effort
                      <EffortPicker value={effort} onChange={setEffort} modelId={model} inheritPlaceholder={globalDefaults?.effort || undefined} />
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="wiz-summary">
              <KindIcon />
              <span>{kindLabel} · <b>{vps.name}</b> · <span className="mono">{path == null ? '~ (home)' : path}</span></span>
            </div>
            {err && <div className="wiz-error">⚠ {err}</div>}
            <div className="wiz-actions">
              <button className="wiz-btn ghost" onClick={() => setStep('path')} disabled={busy}>Back</button>
              <button className="wiz-btn primary big" onClick={launch} disabled={busy}>
                {busy ? 'launching…' : `▸ Launch ${kind === 'agent' ? 'agent' : 'shell'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Crumb({ n, label, active, done, disabled, onClick }: {
  n: number; label: string; active: boolean; done: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`wiz-crumb${active ? ' active' : ''}${done ? ' done' : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="wiz-crumb-n">{done ? '✓' : n}</span>
      <span className="wiz-crumb-label">{label}</span>
    </button>
  );
}
