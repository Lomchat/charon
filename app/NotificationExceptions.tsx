'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { NotificationSession } from '@/lib/notificationPreferences';
import { useBrowserNotifications } from './browserNotifications';
import { subscribeAll, subscribeReconnect } from './globalEventStream';

export default function NotificationExceptions({ onOpen }: { onOpen: (session: NotificationSession) => void }) {
  const browser = useBrowserNotifications();
  const [sessions, setSessions] = useState<NotificationSession[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => api.notificationSessions().then((rows) => { if (alive) { setSessions(rows); setError(null); } })
      .catch((e) => { if (alive) setError(e.message); });
    void refresh();
    const unsubscribe = subscribeAll((ev) => {
      if (ev.type === 'settings_changed' || ev.type === 'session_list_changed' || ev.type === 'status') void refresh();
    });
    const reconnect = subscribeReconnect(() => void refresh());
    return () => { alive = false; unsubscribe(); reconnect(); };
  }, []);
  const exceptions = sessions.filter((s) => s.telegramException || browser.sessions?.[s.id])
    .sort((a, b) => (a.name || a.cwd).localeCompare(b.name || b.cwd));
  return <section className="notification-exceptions">
    <button className="notification-disclosure" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span><strong>Exceptions</strong><small>Sessions with custom notification settings</small></span>
      <span className="notification-count">{exceptions.length}</span><span aria-hidden="true">{open ? '⌄' : '›'}</span>
    </button>
    {open && <div className="notification-exception-list">
      {error ? <p className="notification-error" role="alert">{error}</p> : exceptions.length === 0
        ? <p className="notification-intro">No exceptions. All sessions use global settings.</p>
        : exceptions.map((s) => <button key={s.id} type="button" className="notification-disclosure" onClick={() => onOpen(s)}>
          <span><strong>{s.name || s.cwd.split('/').filter(Boolean).pop() || s.id.slice(0, 8)}</strong>
            <small>{s.vpsName} · {s.status === 'sleeping' ? 'sleeping' : s.status}</small>
            <small>{[browser.sessions?.[s.id] ? 'Browser' : '', s.telegramException ? 'Telegram' : ''].filter(Boolean).join(' · ')}</small></span>
          <span aria-hidden="true">›</span>
        </button>)}
    </div>}
  </section>;
}
