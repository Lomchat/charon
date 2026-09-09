'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { normalizeChannelNotifications, type ChannelNotificationPreferences, type SessionNotificationSettings } from '@/lib/notificationPreferences';
import { readBrowserNotifications, saveBrowserNotifications, useBrowserNotifications } from './browserNotifications';
import { NotificationTable } from './NotificationSettings';
import { subscribeAll, subscribeReconnect } from './globalEventStream';

export default function SessionSettingsModal({ session, onClose }: {
  session: { id: string; name: string | null; cwd: string }; onClose: () => void;
}) {
  const browser = useBrowserNotifications();
  const [settings, setSettings] = useState<SessionNotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const refresh = () => {
      if (saving.current) return;
      const current = ++generation;
      api.sessionNotifications(session.id).then((value) => {
        if (alive && current === generation && !saving.current) { setSettings(value); setError(null); }
      }).catch((e) => { if (alive) setError(e.message); });
    };
    refresh();
    const unsubscribe = subscribeAll((ev) => { if (ev.type === 'settings_changed') refresh(); });
    const reconnect = subscribeReconnect(refresh);
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { alive = false; unsubscribe(); reconnect(); window.removeEventListener('keydown', onKey); };
  }, [session.id, onClose]);
  async function save(channel: 'browser' | 'telegram', value: ChannelNotificationPreferences | null) {
    setBusy(true); saving.current = true; setError(null);
    try {
      if (channel === 'telegram') setSettings(await api.updateSessionNotifications(session.id, value));
      else {
        const current = readBrowserNotifications();
        const sessions = { ...current.sessions };
        if (value) sessions[session.id] = value; else delete sessions[session.id];
        await saveBrowserNotifications({ ...current, sessions });
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  const local = browser.sessions?.[session.id];
  return <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="claude-modal session-settings-modal" role="dialog" aria-modal="true" aria-labelledby="session-settings-title">
      <div className="notification-modal-heading">
        <div><h2 id="session-settings-title">Session settings</h2><p>{session.name || session.cwd.split('/').filter(Boolean).pop() || session.id.slice(0, 8)}</p></div>
        <button ref={closeButton} type="button" className="notification-close" onClick={onClose} aria-label="Close session settings" title="Close session settings">✕</button>
      </div>
      <div className="notification-modal-body">
        <h3 className="notification-page-title">Notifications</h3>
        <p className="notification-intro">Changes are saved automatically.</p>
        <NotificationTable session
          browser={{ value: local ?? browser, busy, inherit: !local,
            onInherit: (inherit) => void save('browser', inherit ? null : normalizeChannelNotifications(browser)),
            onChange: (value) => void save('browser', value) }}
          telegram={settings ? { value: settings.telegram ?? settings.defaults, busy, inherit: settings.telegram === null,
            onInherit: (inherit) => void save('telegram', inherit ? null : settings.defaults),
            onChange: (value) => void save('telegram', value) } : null} />
        {!settings && <p role="status">Loading Telegram settings…</p>}
        {error && <p className="notification-error" role="alert">{error}</p>}
      </div>
    </div>
  </div>;
}
