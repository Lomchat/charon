'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/db/schema';
import ModelPicker from './ModelPicker';
import EffortPicker from './EffortPicker';
import CodexModelPicker from './CodexModelPicker';
import CodexEffortPicker from './CodexEffortPicker';
import AgentLogo from './AgentLogo';
import { invalidateModels } from './modelsCache';

type Props = {
  onClose: () => void;
  /** Passed by ClaudePanel — used to source the per-VPS Codex catalog for the
   *  codex-defaults pickers (first codex-capable VPS wins). */
  vpsList?: Vps[];
};

type Cat = 'general' | 'claude' | 'codex' | 'notifications' | 'updates';

const CATS: { id: Cat; label: string }[] = [
  { id: 'general', label: 'general' },
  { id: 'claude', label: 'claude' },
  { id: 'codex', label: 'codex' },
  { id: 'notifications', label: 'notifications' },
  { id: 'updates', label: 'updates' },
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

export default function SettingsModal({ onClose, vpsList }: Props) {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [cat, setCat] = useState<Cat>('general');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  // The Codex catalog is per-VPS (account-driven). Use the first connected
  // codex-capable VPS; fall back to any codex-capable one.
  const codexVps = useMemo(() => {
    const list = vpsList ?? [];
    return (
      list.find((v) => v.codexAvailable === 1 && v.agentStatus === 'ok') ??
      list.find((v) => v.codexAvailable === 1) ??
      null
    );
  }, [vpsList]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    api.getClaudeSettings().then((r) => setS(r)).catch(() => setS({}));
  }, []);

  function set(k: string, v: string) {
    setS((prev) => ({ ...(prev ?? {}), [k]: v }));
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const r = await api.updateClaudeSettings(s);
      setS(r);
      onClose();
    } catch (e: any) {
      alert('save: ' + (e?.message ?? e));
    } finally { setBusy(false); }
  }

  async function refreshModelList() {
    if (!s) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      await api.updateClaudeSettings(s); // persist the key first
      const r = await api.refreshClaudeModels();
      if (r.ok) {
        invalidateModels();
        setSyncMsg({ ok: true, msg: `synced ✓ — ${r.count ?? 0} models` });
      } else {
        setSyncMsg({ ok: false, msg: r.error || 'sync failed' });
      }
    } catch (e: any) {
      setSyncMsg({ ok: false, msg: e?.message ?? String(e) });
    } finally { setSyncing(false); }
  }

  async function testTelegram() {
    if (!s) return;
    setTesting(true);
    setTestResult(null);
    try {
      await api.updateClaudeSettings(s); // persist first, then test
      await api.testTelegram();
      setTestResult({ ok: true, msg: 'test message sent ✓ — check Telegram' });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message ?? String(e) });
    } finally { setTesting(false); }
  }

  const navIcon = (id: Cat) => {
    if (id === 'claude') return <AgentLogo kind="claude" size={14} />;
    if (id === 'codex') return <AgentLogo kind="codex" size={14} />;
    if (id === 'general') return <span className="nav-ico">⚙</span>;
    if (id === 'notifications') return <span className="nav-ico">✉</span>;
    return <span className="nav-ico">↻</span>;
  };

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal settings-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>settings</h2>
        {s == null && <div className="empty">loading…</div>}
        {s && (
          <>
            <div className="settings-body">
              <nav className="settings-nav" aria-label="settings sections">
                {CATS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cat === c.id ? 'on' : ''}
                    onClick={() => setCat(c.id)}
                  >
                    {navIcon(c.id)}
                    <span>{c.label}</span>
                  </button>
                ))}
              </nav>

              <div className="settings-pane">
                {cat === 'general' && (
                  <>
                    <label>SSH key (path on the hub server)
                      <input value={s['ssh.private_key_path'] ?? ''} onChange={(e) => set('ssh.private_key_path', e.target.value)} placeholder="/root/.ssh/id_rsa" />
                    </label>
                    <label>public URL of this hub (deep links in Telegram / push)
                      <input value={s['app.public_url'] ?? ''} onChange={(e) => set('app.public_url', e.target.value)} placeholder="https://charon.example.com" type="url" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                    </label>
                    <label>VAPID subject (mailto for push)
                      <input value={s['vapid.subject'] ?? ''} onChange={(e) => set('vapid.subject', e.target.value)} placeholder="mailto:you@example.com" />
                    </label>
                  </>
                )}

                {cat === 'claude' && (
                  <>
                    <p className="set-hint">defaults for new Claude sessions — blank = SDK default.</p>
                    <label>default model
                      <ModelPicker
                        value={s['claude.default_model'] ?? ''}
                        onChange={(v) => set('claude.default_model', v)}
                        inheritPlaceholder="SDK default"
                      />
                    </label>
                    <label>default fallback model (when the primary is rate-limited)
                      <ModelPicker
                        value={s['claude.default_fallback_model'] ?? ''}
                        onChange={(v) => set('claude.default_fallback_model', v)}
                        inheritPlaceholder="none"
                      />
                    </label>
                    <label>default effort
                      <EffortPicker
                        value={s['claude.default_effort'] ?? ''}
                        onChange={(v) => set('claude.default_effort', v)}
                        inheritPlaceholder="SDK default"
                      />
                    </label>

                    <div className="settings-sub">model catalog</div>
                    <label>Anthropic API key (catalog sync only — never inference)
                      <input
                        value={s['claude.api_key'] ?? ''}
                        onChange={(e) => set('claude.api_key', e.target.value)}
                        placeholder="sk-ant-…"
                        type="password"
                        autoComplete="off"
                      />
                    </label>
                    <div className="tg-test-row">
                      <button type="button" onClick={refreshModelList} disabled={syncing || !s['claude.api_key']}>
                        {syncing ? 'syncing…' : '↻ refresh model list'}
                      </button>
                      {s['claude.models_cache_at'] && (
                        <span className="set-meta" style={{ marginLeft: 8 }}>
                          last sync: {new Date(Number(s['claude.models_cache_at'])).toLocaleString()}
                        </span>
                      )}
                      {syncMsg && (
                        <span className={`tg-result ${syncMsg.ok ? 'ok' : 'err'}`}>{syncMsg.msg}</span>
                      )}
                    </div>
                  </>
                )}

                {cat === 'codex' && (
                  <>
                    <p className="set-hint">
                      defaults for new Codex sessions — blank = Codex default.
                      {codexVps
                        ? <> catalog via <b>{codexVps.name}</b>.</>
                        : <> no codex-capable VPS connected yet — enter ids manually.</>}
                    </p>
                    {codexVps ? (
                      <>
                        <label>default model
                          <CodexModelPicker
                            vpsId={codexVps.id}
                            value={s['codex.default_model'] ?? ''}
                            onChange={(v) => set('codex.default_model', v)}
                            inheritPlaceholder="Codex default"
                          />
                        </label>
                        <label>default effort
                          <CodexEffortPicker
                            vpsId={codexVps.id}
                            modelId={s['codex.default_model'] || undefined}
                            value={s['codex.default_effort'] ?? ''}
                            onChange={(v) => set('codex.default_effort', v)}
                            inheritPlaceholder="Codex default"
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>default model
                          <input value={s['codex.default_model'] ?? ''} onChange={(e) => set('codex.default_model', e.target.value)} placeholder="gpt-5.6-sol" autoComplete="off" spellCheck={false} />
                        </label>
                        <label>default effort
                          <input value={s['codex.default_effort'] ?? ''} onChange={(e) => set('codex.default_effort', e.target.value)} placeholder="medium" autoComplete="off" spellCheck={false} />
                        </label>
                      </>
                    )}
                    <p className="set-meta">
                      permission model: Codex has no interactive approvals — each
                      session picks a sandbox level instead (cf. migration-codex.md).
                    </p>
                  </>
                )}

                {cat === 'notifications' && (
                  <>
                    <div className="switch-row">
                      <span>browser push notifications</span>
                      <Toggle
                        checked={(s['notif.global_enabled'] ?? 'true') === 'true'}
                        onChange={(v) => set('notif.global_enabled', v ? 'true' : 'false')}
                        label="browser push notifications"
                      />
                    </div>
                    <div className="switch-row">
                      <span>notify when a shell goes idle</span>
                      <Toggle
                        checked={(s['shell.notify_idle'] ?? 'true') === 'true'}
                        onChange={(v) => set('shell.notify_idle', v ? 'true' : 'false')}
                        label="notify when a shell goes idle"
                      />
                    </div>

                    <div className="settings-sub">telegram</div>
                    <p className="set-hint">
                      respond to permissions and questions from Telegram (inline
                      buttons + free text). Bot via <code>@BotFather</code>, chat_id
                      via <code>@userinfobot</code>.
                    </p>
                    <div className="switch-row">
                      <span>enable</span>
                      <Toggle
                        checked={s['telegram.enabled'] === 'true'}
                        onChange={(v) => set('telegram.enabled', v ? 'true' : 'false')}
                        label="enable Telegram"
                      />
                    </div>
                    <label>bot token
                      <input value={s['telegram.bot_token'] ?? ''} onChange={(e) => set('telegram.bot_token', e.target.value)} placeholder="123456:ABC-…" type="text" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
                    </label>
                    <label>chat_id
                      <input value={s['telegram.chat_id'] ?? ''} onChange={(e) => set('telegram.chat_id', e.target.value)} placeholder="123456789" inputMode="numeric" />
                    </label>
                    <div className="tg-test-row">
                      <button type="button" onClick={testTelegram} disabled={testing || s['telegram.enabled'] !== 'true' || !s['telegram.bot_token'] || !s['telegram.chat_id']}>
                        {testing ? 'sending…' : 'test connection'}
                      </button>
                      {testResult && (
                        <span className={`tg-result ${testResult.ok ? 'ok' : 'err'}`}>{testResult.msg}</span>
                      )}
                    </div>
                  </>
                )}

                {cat === 'updates' && (
                  <>
                    <div className="switch-row">
                      <span>auto-update Claude (SDK + agent) when a VPS is idle</span>
                      <Toggle
                        checked={(s['sdk.auto_update'] ?? 'true') === 'true'}
                        onChange={(v) => set('sdk.auto_update', v ? 'true' : 'false')}
                        label="auto-update claude SDK when a VPS is idle"
                      />
                    </div>
                    <div className="switch-row">
                      <span>auto-update Codex (openai-codex) when a VPS is idle</span>
                      <Toggle
                        checked={(s['codex.auto_update'] ?? 'true') === 'true'}
                        onChange={(v) => set('codex.auto_update', v ? 'true' : 'false')}
                        label="auto-update codex when a VPS is idle"
                      />
                    </div>
                    {(s['sdk.latest_version'] || s['codex.latest_version']) && (
                      <p className="set-meta">
                        latest on PyPI:
                        {s['sdk.latest_version'] && <> claude-agent-sdk <b>{s['sdk.latest_version']}</b></>}
                        {s['sdk.latest_version'] && s['codex.latest_version'] && ' · '}
                        {s['codex.latest_version'] && <> openai-codex <b>{s['codex.latest_version']}</b></>}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="settings-foot modal-actions">
              <button className="primary" onClick={save} disabled={busy}>save</button>
              <button onClick={onClose}>cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
