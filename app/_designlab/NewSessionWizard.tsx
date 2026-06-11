'use client';
import { useState } from 'react';
import { MOCK_VPS, MOCK_FOLDERS, bucketByFolder, type MockVps } from './mock';
import { IconRobot, IconTerminal } from '../icons';

// 3-step "new session" wizard (mock). Kind (agent vs shell) is fixed by the
// button that opened it — no toggle inside.
//   1. pick a VPS   (grouped by folder; click = advance; skipped if a VPS
//      was passed in from a per-VPS button)
//   2. pick a path  (click a known path = advance; a typed path is validated
//      — here we SIMULATE that any non-empty path exists)
//   3. name it + launch
type Step = 'vps' | 'path' | 'name';

export default function NewSessionWizard({
  kind, initialVpsId, onClose,
}: {
  kind: 'agent' | 'shell';
  initialVpsId?: string;
  onClose: () => void;
}) {
  const [vpsId, setVpsId] = useState<string | null>(initialVpsId ?? null);
  const [path, setPath] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [custom, setCustom] = useState('');
  const [pathError, setPathError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(initialVpsId ? 'path' : 'vps');

  const vps = vpsId ? MOCK_VPS.find((v) => v.id === vpsId)! : null;
  const kindLabel = kind === 'agent' ? 'Claude agent' : 'SSH shell';
  const KindIcon = kind === 'agent' ? IconRobot : IconTerminal;

  function pickVps(v: MockVps) {
    if (v.agentStatus === 'missing') return;
    setVpsId(v.id);
    setPath(null);
    setStep('path');
  }
  function pickPath(p: string) {
    // Real impl would check the path exists on the VPS; here we simulate yes.
    setPath(p);
    setPathError(null);
    setStep('name');
  }
  function submitCustom() {
    const p = custom.trim();
    if (!p) { setPathError('enter a path'); return; }
    pickPath(p); // simulated as existing
  }

  const vpsBuckets = bucketByFolder(MOCK_VPS.map((v) => ({ vps: v })));
  const paths = vps
    ? [{ label: 'home', path: '~' }, ...vps.paths]
    : [];

  return (
    <div className="lab-modal-backdrop" onClick={onClose}>
      <div className={`lab-modal wiz kind-${kind}`} onClick={(e) => e.stopPropagation()}>
        <div className="lab-modal-head">
          <span className="wiz-kind"><KindIcon /> New {kindLabel}</span>
          <button className="lab-modal-x" onClick={onClose}>✕</button>
        </div>

        {/* breadcrumb / step indicator — completed steps are clickable */}
        <div className="wiz-crumbs">
          <Crumb n={1} label={vps ? vps.name : 'VPS'} active={step === 'vps'}
            done={!!vps && step !== 'vps'} onClick={() => setStep('vps')} />
          <span className="wiz-crumb-sep">▸</span>
          <Crumb n={2} label={path ?? 'Path'} active={step === 'path'}
            done={!!path && step !== 'path'} disabled={!vps}
            onClick={() => vps && setStep('path')} />
          <span className="wiz-crumb-sep">▸</span>
          <Crumb n={3} label="Name" active={step === 'name'} done={false}
            disabled={!path} onClick={() => path && setStep('name')} />
        </div>

        {/* ── Step 1: VPS ── */}
        {step === 'vps' && (
          <div className="wiz-body">
            <div className="lab-modal-label">Choose a VPS</div>
            {vpsBuckets.map(({ folder, groups }) => (
              <div key={folder.id} className="wiz-folder">
                <div className="wiz-folder-name">▤ {folder.name}</div>
                <div className="wiz-pick-list">
                  {groups.map(({ vps: v }) => (
                    <button key={v.id}
                      className={`wiz-pick agent-${v.agentStatus}`}
                      onClick={() => pickVps(v)}
                      disabled={v.agentStatus === 'missing'}
                    >
                      <span className={`wiz-pick-dot agent-${v.agentStatus}`} />
                      <span className="wiz-pick-main">
                        <span className="wiz-pick-name">{v.name}</span>
                        <span className="wiz-pick-sub">{v.ip}</span>
                      </span>
                      <span className="wiz-pick-go">›</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Step 2: Path ── */}
        {step === 'path' && vps && (
          <div className="wiz-body">
            <div className="lab-modal-label">Path on <b>{vps.name}</b></div>
            <div className="wiz-pick-list">
              {paths.map((p) => (
                <button key={p.path} className="wiz-pick" onClick={() => pickPath(p.path)}>
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
              />
              <button className="lab-btn primary" onClick={submitCustom}>Use ›</button>
            </div>
            {pathError && <div className="wiz-error">⚠ {pathError}</div>}
          </div>
        )}

        {/* ── Step 3: Name + launch ── */}
        {step === 'name' && vps && (
          <div className="wiz-body">
            <div className="lab-modal-label">Name <span className="wiz-opt">(optional)</span></div>
            <input
              className="wiz-name-input"
              autoFocus
              placeholder={kind === 'agent' ? 'e.g. sidebar redesign' : 'e.g. logs tail'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="wiz-summary">
              <KindIcon />
              <span>{kindLabel} · <b>{vps.name}</b> · <span className="mono">{path}</span></span>
            </div>
            <div className="lab-modal-actions">
              <button className="lab-btn ghost" onClick={() => setStep('path')}>Back</button>
              <button className="lab-btn primary big" onClick={onClose}>
                ▸ Launch {kind === 'agent' ? 'agent' : 'shell'}
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
