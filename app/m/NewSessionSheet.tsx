'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  initial?: { vpsId?: string; cwd?: string };
  onClose: () => void;
  onCreated: (id: string) => void;
};

// Mobile bottom-sheet to create a new Claude session.
// Mirrors the logic of NewSessionDialog in a simpler/mobile-friendly form.
// Mirror MODEL_SUGGESTIONS / EFFORT_OPTIONS from NewSessionDialog. Kept
// duplicated (not imported) to keep mobile chunk independent of the desktop
// dialog, which mobile pages don't otherwise load.
const MODEL_SUGGESTIONS = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-5',
  'claude-sonnet-4-7',
  'claude-haiku-4-5',
];

const EFFORT_OPTIONS: { value: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; label: string }[] = [
  { value: '', label: 'inherit (global default)' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

export default function NewSessionSheet({
  vpsList, vpsPaths, initial, onClose, onCreated,
}: Props) {
  const [vpsId, setVpsId] = useState(initial?.vpsId ?? vpsList[0]?.id ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [name, setName] = useState('');
  // Per-session Claude config — empty = inherit global default. Cf.
  // NewSessionDialog for the same UI rationale (don't pre-fill so changing
  // the global default later still takes effect).
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState<'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('');
  const [globalDefaults, setGlobalDefaults] = useState<{
    model: string; fallbackModel: string; effort: string;
  } | null>(null);
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cwdSuggestions = useMemo(() => {
    return vpsPaths
      .filter((p) => p.vpsId === vpsId)
      .map((p) => p.path)
      .sort();
  }, [vpsId, vpsPaths]);

  // Claude SDK check on mount / VPS change
  useEffect(() => {
    if (!vpsId) return;
    setCheck(null);
    api.checkVpsClaude(vpsId)
      .then((r) => setCheck(r))
      .catch((e) => setCheck({ ok: false, error: String(e?.message ?? e) }));
  }, [vpsId]);

  // Best-effort: fetch global defaults to display them as input placeholders.
  useEffect(() => {
    api.getClaudeSettings()
      .then((s) => setGlobalDefaults({
        model: s['claude.default_model'] ?? '',
        fallbackModel: s['claude.default_fallback_model'] ?? '',
        effort: s['claude.default_effort'] ?? '',
      }))
      .catch(() => { /* no UI noise */ });
  }, []);

  async function create() {
    if (!vpsId || !cwd.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.createClaudeSession({
        vpsId, cwd: cwd.trim(),
        name: name.trim() || null,
        permissionMode: 'auto',
        model: model.trim() || null,
        fallbackModel: fallbackModel.trim() || null,
        effort: effort || null,
      });
      onCreated(r.id);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="m-sheet-bg" onClick={onClose} />
      <div className="m-sheet" role="dialog" aria-modal="true">
        <header className="m-sheet-head">
          <h2>new session</h2>
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

          {check !== null && (
            <div style={{ fontSize: 12, color: 'var(--parchment-soft)', fontFamily: 'var(--mono)', marginBottom: 14 }}>
              {check.ok
                ? (
                    <span style={{ color: '#a0c87b' }}>
                      ✓ sdk {check.sdk}, python {check.python}
                      {(!check.cliInstalled || check.authOk === false) && (
                        <span style={{ color: 'var(--parchment-soft)', opacity: 0.7 }}>
                          {' — '}
                          {!check.cliInstalled && 'cli not detected'}
                          {!check.cliInstalled && check.authOk === false && ', '}
                          {check.authOk === false && 'login not detected'}
                          {' (ok if the session works)'}
                        </span>
                      )}
                    </span>
                  )
                : <span style={{ color: 'var(--crimson)' }}>⚠ sdk missing</span>
              }
            </div>
          )}

          <label>
            <span>cwd (path on the VPS)</span>
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/srv/my-project"
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
              placeholder="e.g. auth refactor"
            />
          </label>

          {/* Per-session Claude config — cf. NewSessionDialog for rationale. */}
          <label>
            <span>model (optional)</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={globalDefaults?.model ? `inherit: ${globalDefaults.model}` : 'inherit'}
              list="claude-model-suggestions-m"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
          </label>
          <label>
            <span>fallback model (optional)</span>
            <input
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
              placeholder={globalDefaults?.fallbackModel ? `inherit: ${globalDefaults.fallbackModel}` : 'none'}
              list="claude-model-suggestions-m"
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
          </label>
          <datalist id="claude-model-suggestions-m">
            {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
          </datalist>
          <label>
            <span>effort (optional)</span>
            <select value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}>
              {EFFORT_OPTIONS.map((o) => {
                const inherited = !o.value && globalDefaults?.effort
                  ? ` — inherits: ${globalDefaults.effort}` : '';
                return <option key={o.value} value={o.value}>{o.label}{inherited}</option>;
              })}
            </select>
          </label>

          {err && <div className="m-sheet-err">{err}</div>}

          <div className="m-sheet-actions">
            <button type="button" onClick={onClose}>cancel</button>
            <button
              type="button"
              className="primary"
              onClick={create}
              disabled={busy || !cwd.trim() || !vpsId}
            >{busy ? '…' : 'start'}</button>
          </div>
        </div>
      </div>
    </>
  );
}
