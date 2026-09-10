'use client';
import { useEffect, useState } from 'react';
import { DEFAULT_BROWSER_NOTIFICATIONS, browserNotificationsEnabled, normalizeBrowserNotifications, parseBrowserNotifications, type BrowserNotificationPreferences } from '@/lib/notificationPreferences';
import { pushCurrentEndpoint, pushSubscribe, syncPushPreferences } from './pushClient';

const KEY = 'charon.browserNotifications';
const CHANGED = 'charon:browser-notifications';
export function readBrowserNotifications(): BrowserNotificationPreferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseBrowserNotifications(raw, false);
    return { ...DEFAULT_BROWSER_NOTIFICATIONS, sound: localStorage.getItem('hub.claude.notif.sound') !== '0' };
  } catch { return DEFAULT_BROWSER_NOTIFICATIONS; }
}
function storePreferences(value: BrowserNotificationPreferences) {
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(CHANGED));
}
// Serialize saves within a tab so an older network response cannot win a rapid toggle.
let saving = Promise.resolve();
export function saveBrowserNotifications(value: BrowserNotificationPreferences): Promise<void> {
  const next = normalizeBrowserNotifications(value);
  // Permission must be requested directly from the click gesture.
  const subscribe = browserNotificationsEnabled(next) && !browserNotificationsEnabled(readBrowserNotifications())
    ? pushSubscribe(next) : null;
  const task = saving.catch(() => {}).then(async () => {
    if (subscribe) {
      const result = await subscribe;
      if (!result.ok) throw new Error(result.reason ?? 'Push could not be enabled');
    } else {
      await syncPushPreferences(next);
    }
    storePreferences(next);
  });
  saving = task;
  return task;
}
/**
 * Carry a session's browser override onto a branch (fork). The Telegram half
 * travels server-side with the fork; this half is localStorage, so only the
 * device doing the forking can copy it — and only if it HAS an override:
 * absent means "inherit the defaults", which the branch already does.
 * Never re-prompts for permission — an enabled override already makes
 * `browserNotificationsEnabled` true, so this can only ever be a resync.
 */
export function copySessionNotifications(fromSessionId: string, toSessionId: string): Promise<void> {
  const current = readBrowserNotifications();
  const value = current.sessions?.[fromSessionId];
  if (!value) return Promise.resolve();
  return saveBrowserNotifications({ ...current, sessions: { ...current.sessions, [toSessionId]: value } });
}
let initializing: Promise<void> | null = null;
function initialize(): Promise<void> {
  if (!initializing) {
    initializing = saving.catch(() => {}).then(async () => {
      const endpoint = await pushCurrentEndpoint();
      const value = readBrowserNotifications();
      // Existing subscriptions keep working on upgrade; a fresh browser starts off.
      if (!localStorage.getItem(KEY)) value.enabled = !!endpoint;
      else if (!endpoint) {
        value.enabled = false;
        for (const preference of Object.values(value.sessions ?? {})) preference.enabled = false;
      }
      await syncPushPreferences(value);
      storePreferences(value);
    }).catch(() => { initializing = null; });
    saving = initializing;
  }
  return initializing;
}
export function useBrowserNotifications() {
  const [preferences, setPreferences] = useState(DEFAULT_BROWSER_NOTIFICATIONS);
  useEffect(() => {
    const refresh = () => setPreferences(readBrowserNotifications());
    const onStorage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) refresh(); };
    refresh();
    window.addEventListener(CHANGED, refresh);
    window.addEventListener('storage', onStorage);
    void initialize();
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return preferences;
}
