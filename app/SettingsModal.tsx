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
    // On enregistre d'abord les settings, puis on teste
    setTesting(true);
    setTestResult(null);
    try {
      await api.updateClaudeSettings(s);
      await api.testTelegram();
      setTestResult({ ok: true, msg: 'message de test envoyé ✓ — regarde Telegram' });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message ?? String(e) });
    } finally { setTesting(false); }
  }

  useEffect(() => {
    api.getClaudeSettings().then((r: any) => setS(r)).catch(() => setS({}));
  }, []);

  function set(k: string, v: string) {
    setS((prev) => ({ ...(prev ?? {}), [k]: v }));
  }

  async function save() {
    if (!s) return;
    setBusy(true);
    try {
      const r: any = await api.updateClaudeSettings(s);
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
        {s == null && <div className="empty">chargement…</div>}
        {s && (
          <>
            <label>clé SSH (chemin sur le serveur du hub)
              <input value={s['ssh.private_key_path'] ?? ''} onChange={(e) => set('ssh.private_key_path', e.target.value)} placeholder="/root/.ssh/id_rsa" />
            </label>
            <label>max sessions actives en parallèle (warning soft)
              <input value={s['session.max_active'] ?? ''} onChange={(e) => set('session.max_active', e.target.value)} inputMode="numeric" />
            </label>
            <label>rétention des sessions killed (jours, 0 = jamais purger)
              <input value={s['retention.killed_days'] ?? ''} onChange={(e) => set('retention.killed_days', e.target.value)} inputMode="numeric" />
            </label>
            <div className="switch-row">
              <span>notifications push globales</span>
              <Toggle
                checked={(s['notif.global_enabled'] ?? 'true') === 'true'}
                onChange={(v) => set('notif.global_enabled', v ? 'true' : 'false')}
                label="notifications push globales"
              />
            </div>
            <label>VAPID subject (mailto pour push)
              <input value={s['vapid.subject'] ?? ''} onChange={(e) => set('vapid.subject', e.target.value)} placeholder="mailto:tu@example.com" />
            </label>

            <fieldset className="tg-block">
              <legend>Telegram (notifications interactives)</legend>
              <p className="tg-help">
                Permet de répondre aux permissions et questions depuis Telegram (boutons inline + texte libre).
                Crée un bot via <code>@BotFather</code>, récupère le token, parle-lui une fois et trouve ton chat_id via <code>@userinfobot</code>.
              </p>
              <div className="switch-row">
                <span>activer</span>
                <Toggle
                  checked={s['telegram.enabled'] === 'true'}
                  onChange={(v) => set('telegram.enabled', v ? 'true' : 'false')}
                  label="activer Telegram"
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
                  {testing ? 'envoi…' : 'tester la connexion'}
                </button>
                {testResult && (
                  <span className={`tg-result ${testResult.ok ? 'ok' : 'err'}`}>{testResult.msg}</span>
                )}
              </div>
            </fieldset>

            <div className="modal-actions">
              <button className="primary" onClick={save} disabled={busy}>enregistrer</button>
              <button onClick={onClose}>annuler</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
