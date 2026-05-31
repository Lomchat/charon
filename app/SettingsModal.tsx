'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Props = {
  onClose: () => void;
};

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

export default function SettingsModal({ onClose }: Props) {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function testTelegram() {
    if (!s) return;
    // We save the settings first, then test
    setTesting(true);
    setTestResult(null);
    try {
      await api.updateClaudeSettings(s);
      await api.testTelegram();
      setTestResult({ ok: true, msg: 'test message sent ✓ — check Telegram' });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message ?? String(e) });
    } finally { setTesting(false); }
  }

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

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>settings</h2>
        {s == null && <div className="empty">loading…</div>}
        {s && (
          <>
            <label>SSH key (path on the hub server)
              <input value={s['ssh.private_key_path'] ?? ''} onChange={(e) => set('ssh.private_key_path', e.target.value)} placeholder="/root/.ssh/id_rsa" />
            </label>
            <label>max concurrent active sessions (soft warning)
              <input value={s['session.max_active'] ?? ''} onChange={(e) => set('session.max_active', e.target.value)} inputMode="numeric" />
            </label>
            <label>killed session retention (days, 0 = never purge)
              <input value={s['retention.killed_days'] ?? ''} onChange={(e) => set('retention.killed_days', e.target.value)} inputMode="numeric" />
            </label>
            <div className="switch-row">
              <span>global push notifications</span>
              <Toggle
                checked={(s['notif.global_enabled'] ?? 'true') === 'true'}
                onChange={(v) => set('notif.global_enabled', v ? 'true' : 'false')}
                label="global push notifications"
              />
            </div>
            <label>VAPID subject (mailto for push)
              <input value={s['vapid.subject'] ?? ''} onChange={(e) => set('vapid.subject', e.target.value)} placeholder="mailto:you@example.com" />
            </label>

            <fieldset className="tg-block">
              <legend>Claude defaults (apply to NEW sessions)</legend>
              <p className="tg-help">
                These defaults are used when creating a new Claude session, unless
                overridden in the new-session dialog. Existing sessions are
                unaffected (they carry their own model/effort, set at creation
                time). Leave a field blank to use the SDK default.
                <br />
                Model is a free string (e.g. <code>claude-opus-4-7</code>,
                <code> claude-opus-4-8</code>). The SDK on the VPS validates it
                at session start. Effort is one of <code>low</code> · <code>medium</code> ·
                <code> high</code> · <code>xhigh</code> · <code>max</code>.
              </p>
              <label>default model
                <input
                  value={s['claude.default_model'] ?? ''}
                  onChange={(e) => set('claude.default_model', e.target.value)}
                  placeholder="(empty = SDK default)"
                  list="claude-default-model-suggestions"
                  autoComplete="off"
                />
              </label>
              <label>default fallback model (used when primary is rate-limited)
                <input
                  value={s['claude.default_fallback_model'] ?? ''}
                  onChange={(e) => set('claude.default_fallback_model', e.target.value)}
                  placeholder="(empty = no fallback)"
                  list="claude-default-model-suggestions"
                  autoComplete="off"
                />
              </label>
              <datalist id="claude-default-model-suggestions">
                <option value="claude-opus-4-7" />
                <option value="claude-opus-4-8" />
                <option value="claude-sonnet-4-5" />
                <option value="claude-sonnet-4-7" />
                <option value="claude-haiku-4-5" />
              </datalist>
              <label>default effort
                <select
                  value={s['claude.default_effort'] ?? ''}
                  onChange={(e) => set('claude.default_effort', e.target.value)}
                >
                  <option value="">(empty = SDK default)</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
              </label>
            </fieldset>

            <fieldset className="tg-block">
              <legend>Telegram (interactive notifications)</legend>
              <p className="tg-help">
                Lets you respond to permissions and questions from Telegram (inline buttons + free text).
                Create a bot via <code>@BotFather</code>, get the token, message it once, and find your chat_id via <code>@userinfobot</code>.
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
                <input value={s['telegram.bot_token'] ?? ''} onChange={(e) => set('telegram.bot_token', e.target.value)} placeholder="123456:ABC-…" type="password" />
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
            </fieldset>

            <div className="modal-actions">
              <button className="primary" onClick={save} disabled={busy}>save</button>
              <button onClick={onClose}>cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
