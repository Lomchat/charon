'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsFolder, VpsPath } from '@/lib/db/schema';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import ModelPicker from '../ModelPicker';
import EffortPicker from '../EffortPicker';
import { IconRobot, IconTerminal } from '../icons';

// Mobile 3-step "new session" wizard (bottom sheet). Mirror of the desktop
// NewSessionWizard: VPS → path → name, `kind` fixed by the button.
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

export default function NewWizardSheet({
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

  const [showAdv, setShowAdv] = useState(false);
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState('');
  const [globalDefaults, setGlobalDefaults] = useState<{ model: string; fallbackModel: string; effort: string } | null>(null);

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
          cwd: path ? path.trim() : null,
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
    <>
      <div className="m-sheet-bg" onClick={onClose} />
      <div className={`m-sheet m-wiz kind-${kind}`} role="dialog" aria-modal="true">
        <header className="m-sheet-head">
          <h2 className="m-wiz-kind"><KindIcon /> New {kindLabel}</h2>
          <button className="m-sheet-close" onClick={onClose} aria-label="close">✕</button>
        </header>

        <div className="m-wiz-steps">
          <Crumb n={1} label={vps ? vps.name : 'VPS'} active={step === 'vps'} done={!!vps && step !== 'vps'} onClick={() => setStep('vps')} />
          <span className="m-wiz-sep">›</span>
          <Crumb n={2} label={pathLabel} active={step === 'path'} done={pathChosen && step !== 'path'} disabled={!vps} onClick={() => vps && setStep('path')} />
          <span className="m-wiz-sep">›</span>
          <Crumb n={3} label="Name" active={step === 'name'} done={false} disabled={!pathChosen} onClick={() => pathChosen && setStep('name')} />
        </div>

        <div className="m-sheet-body m-wiz-body">
          {step === 'vps' && (
            <>
              <div className="m-wiz-label">Choose a VPS</div>
              {buckets.length === 0 && <div className="m-sheet-err">no VPS — add one on desktop</div>}
              {buckets.map(({ folder, vps: list }) => (
                <div key={folder.id} className="m-wiz-folder">
                  <div className="m-wiz-folder-name">▤ {folder.name}</div>
                  {list.map((v) => {
                    const status = (v as any).agentStatus ?? 'unknown';
                    const disabled = kind === 'agent' && status !== 'ok';
                    return (
                      <button key={v.id} className="m-wiz-pick" disabled={disabled} onClick={() => pickVps(v)}>
                        <span className={`m-wiz-dot agent-${status}`} />
                        <span className="m-wiz-pick-main">
                          <span className="m-wiz-pick-name">{v.name}</span>
                          <span className="m-wiz-pick-sub">{v.sshUser}@{v.ip}{disabled ? ' · agent not ready' : ''}</span>
                        </span>
                        <span className="m-wiz-go">›</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </>
          )}

          {step === 'path' && vps && (
            <>
              <div className="m-wiz-label">Path on {vps.name}</div>
              {kind === 'shell' && (
                <button className="m-wiz-pick" onClick={() => choosePath(null)}>
                  <span className="m-wiz-glyph">~</span>
                  <span className="m-wiz-pick-main">
                    <span className="m-wiz-pick-name">home</span>
                    <span className="m-wiz-pick-sub">the SSH user's home directory</span>
                  </span>
                  <span className="m-wiz-go">›</span>
                </button>
              )}
              {pickList.map((p) => (
                <button key={p.path} className="m-wiz-pick" onClick={() => choosePath(p.path)}>
                  <span className="m-wiz-glyph">▤</span>
                  <span className="m-wiz-pick-main">
                    <span className="m-wiz-pick-name">{p.label}</span>
                    <span className="m-wiz-pick-sub mono">{p.path}</span>
                  </span>
                  <span className="m-wiz-go">›</span>
                </button>
              ))}
              <div className="m-wiz-custom">
                <input
                  placeholder="/custom/path…" value={custom}
                  onChange={(e) => { setCustom(e.target.value); setPathError(null); }}
                  onKeyDown={(e) => e.key === 'Enter' && submitCustom()}
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                />
                <button className="m-wiz-use" onClick={submitCustom}>Use ›</button>
              </div>
              {pathError && <div className="m-sheet-err">⚠ {pathError}</div>}
            </>
          )}

          {step === 'name' && vps && (
            <>
              <label>
                <span>name (optional)</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                  placeholder={kind === 'agent' ? 'e.g. sidebar redesign' : 'e.g. tail logs'}
                  onKeyDown={(e) => { if (e.key === 'Enter') launch(); }} />
              </label>

              {kind === 'agent' && (
                <div className="m-wiz-adv">
                  <button className="m-wiz-adv-toggle" onClick={() => setShowAdv((v) => !v)}>
                    {showAdv ? '▾' : '▸'} advanced · model & effort
                  </button>
                  {showAdv && (
                    <>
                      <label><span>model</span>
                        <ModelPicker value={model} onChange={setModel} inheritPlaceholder={globalDefaults?.model || undefined} />
                      </label>
                      <label><span>fallback model</span>
                        <ModelPicker value={fallbackModel} onChange={setFallbackModel} inheritPlaceholder={globalDefaults?.fallbackModel || 'none'} />
                      </label>
                      <label><span>effort</span>
                        <EffortPicker value={effort} onChange={setEffort} modelId={model} inheritPlaceholder={globalDefaults?.effort || undefined} />
                      </label>
                    </>
                  )}
                </div>
              )}

              <div className="m-wiz-summary">
                <KindIcon />
                <span>{kindLabel} · {vps.name} · {path == null ? '~ (home)' : path}</span>
              </div>
              {err && <div className="m-sheet-err">⚠ {err}</div>}
              <div className="m-sheet-actions">
                <button type="button" onClick={() => setStep('path')} disabled={busy}>back</button>
                <button type="button" className="primary" onClick={launch} disabled={busy}>
                  {busy ? '…' : `Launch ${kind === 'agent' ? 'agent' : 'shell'}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Crumb({ n, label, active, done, disabled, onClick }: {
  n: number; label: string; active: boolean; done: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button className={`m-wiz-crumb${active ? ' active' : ''}${done ? ' done' : ''}`} disabled={disabled} onClick={onClick}>
      <span className="m-wiz-crumb-n">{done ? '✓' : n}</span>
      <span className="m-wiz-crumb-label">{label}</span>
    </button>
  );
}
