'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps, VpsPath } from '@/lib/db/schema';
import ModelPicker from './ModelPicker';

type Props = {
  vpsList: Vps[];
  vpsPaths: VpsPath[];
  initial?: { vpsId?: string; cwd?: string };
  onClose: () => void;
  onCreated: (id: string) => void;
};

const EFFORT_OPTIONS: { value: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; label: string }[] = [
  { value: '', label: 'inherit (global default)' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

export default function NewSessionDialog({
  vpsList, vpsPaths, initial, onClose, onCreated,
}: Props) {
  const [vpsId, setVpsId] = useState(initial?.vpsId ?? vpsList[0]?.id ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [name, setName] = useState('');
  // Always created in "auto" (Claude's native classifier) — the user changes it via the switch in the chat
  const permissionMode = 'auto' as const;
  // Per-session Claude config (empty string = inherit the global default
  // set in SettingsModal § Claude defaults). We don't pre-fill from the
  // global default — leaving the field blank is the explicit way to say
  // "follow whatever the global default is, even if it changes later".
  const [model, setModel] = useState('');
  const [fallbackModel, setFallbackModel] = useState('');
  const [effort, setEffort] = useState<'' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>('');
  // Fetched on open to display the inherited values as placeholders.
  // Failure is non-fatal — placeholders just stay generic.
  const [globalDefaults, setGlobalDefaults] = useState<{
    model: string; fallbackModel: string; effort: string;
  } | null>(null);
  const [check, setCheck] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline feedback for the "install SDK" click (instead of an intrusive alert)
  const [setupLog, setSetupLog] = useState<null | { ok: boolean; tail: string; version: string | null }>(null);
  const [setupLogOpen, setSetupLogOpen] = useState(false);

  // Path suggestions: known paths for this VPS
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

  // Load global defaults to display them as input placeholders. Best-effort.
  useEffect(() => {
    api.getClaudeSettings()
      .then((s) => setGlobalDefaults({
        model: s['claude.default_model'] ?? '',
        fallbackModel: s['claude.default_fallback_model'] ?? '',
        effort: s['claude.default_effort'] ?? '',
      }))
      .catch(() => { /* placeholders stay generic — no UI noise */ });
  }, []);

  useEffect(() => {
    if (!vpsId) return;
    setCheck(null);
    api.checkVpsClaude(vpsId)
      .then((r) => setCheck(r))
      .catch((e) => setCheck({ ok: false, error: String(e?.message ?? e) }));
  }, [vpsId]);

  async function setup() {
    setBusy(true);
    setSetupLog(null);
    setSetupLogOpen(false);
    try {
      const r = await api.setupVpsClaude(vpsId);
      const out = (r.stdout || '') + '\n' + (r.stderr || '');
      // pip says "Requirement already satisfied" if the SDK is already there —
      // we treat that as a silent success (idempotence is expected).
      const alreadyOk = /Requirement already satisfied/i.test(out);
      const versionMatch = out.match(/version:\s*([\d.]+\S*)/i);
      setSetupLog({
        ok: r.ok,
        tail: out.slice(-1500).trim(),
        version: versionMatch ? versionMatch[1] : null,
      });
      // We expand the detail ONLY if it failed — otherwise just an OK toast
      setSetupLogOpen(!r.ok && !alreadyOk);
      const c = await api.checkVpsClaude(vpsId);
      setCheck(c);
    } catch (e: any) {
      setSetupLog({ ok: false, tail: String(e?.message ?? e), version: null });
      setSetupLogOpen(true);
    } finally { setBusy(false); }
  }

  async function create() {
    if (!vpsId || !cwd.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.createClaudeSession({
        vpsId, cwd: cwd.trim(),
        name: name.trim() || null,
        permissionMode,
        // Empty → null (= inherit global default at the server side, which
        // resolves to the SDK default if no global is set).
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
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>new session</h2>

        <label>VPS
          <select value={vpsId} onChange={(e) => setVpsId(e.target.value)}>
            {vpsList.map((v) => (
              <option key={v.id} value={v.id}>{v.name} ({v.sshUser}@{v.ip})</option>
            ))}
          </select>
        </label>

        <div className="check-info">
          {check === null && <em>checking VPS…</em>}
          {check && check.ok && (
            <span className="ok">
              ✓ sdk {check.sdk}, python {check.python}
              {/* cli/auth as a discreet hint only if not detected — the
                 session works anyway (claude is probably installed via
                 nvm/bun/volta, invisible to non-interactive SSH PATH). */}
              {(!check.cliInstalled || check.authOk === false) && (
                <span className="hint">
                  {' — '}
                  {!check.cliInstalled && 'cli not detected'}
                  {!check.cliInstalled && check.authOk === false && ', '}
                  {check.authOk === false && 'login not detected'}
                  {' (ok if the session works)'}
                </span>
              )}
            </span>
          )}
          {check && !check.ok && (
            <>
              <span className="warn">⚠ sdk missing</span>
              <button onClick={setup} disabled={busy}>
                {busy ? 'installing…' : 'install SDK'}
              </button>
            </>
          )}
          {setupLog && (
            <div className={`setup-log ${setupLog.ok ? 'ok' : 'err'}`} style={{ marginTop: 6, fontSize: 12 }}>
              <span>
                {setupLog.ok
                  ? `✓ install OK${setupLog.version ? ` · sdk ${setupLog.version}` : ''}`
                  : '✗ install failed'}
              </span>
              {' '}
              <button
                type="button"
                onClick={() => setSetupLogOpen((v) => !v)}
                style={{ background: 'transparent', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
              >
                {setupLogOpen ? 'hide details' : 'view details'}
              </button>
              {setupLogOpen && (
                <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 11, fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', background: 'rgba(0,0,0,0.25)', padding: 8, marginTop: 4, borderRadius: 4 }}>
                  {setupLog.tail || '(empty output)'}
                </pre>
              )}
            </div>
          )}
        </div>

        <label>cwd (path on the VPS)
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/srv/my-project"
            list={`cwd-suggest-${vpsId}`}
          />
          <datalist id={`cwd-suggest-${vpsId}`}>
            {cwdSuggestions.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>

        <label>name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: auth refactor" />
        </label>

        {/*
          Claude config (optional). Leaving fields blank inherits the global
          default (SettingsModal § Claude defaults), which itself can be
          blank → SDK default. Both model selects show the curated list
          from /api/claude/models (single source of truth in
          lib/server/claude/knownModels.ts). Free-text was the original UX
          but produced silent SDK fallback when users typed an outdated
          ID — closed list is more honest.
        */}
        <label>model (optional)
          <ModelPicker
            value={model}
            onChange={setModel}
            inheritPlaceholder={globalDefaults?.model || undefined}
          />
        </label>
        <label>fallback model (optional, used if rate-limited)
          <ModelPicker
            value={fallbackModel}
            onChange={setFallbackModel}
            inheritPlaceholder={globalDefaults?.fallbackModel || 'none'}
          />
        </label>
        <label>effort (optional)
          <select value={effort} onChange={(e) => setEffort(e.target.value as typeof effort)}>
            {EFFORT_OPTIONS.map((o) => {
              const inherited = !o.value && globalDefaults?.effort
                ? ` — inherits: ${globalDefaults.effort}` : '';
              return <option key={o.value} value={o.value}>{o.label}{inherited}</option>;
            })}
          </select>
        </label>

        {err && <div className="modal-err">{err}</div>}

        <div className="modal-actions">
          <button className="primary" onClick={create} disabled={busy || !cwd.trim() || !vpsId}>start</button>
          <button onClick={onClose}>cancel</button>
        </div>
      </div>
    </div>
  );
}
