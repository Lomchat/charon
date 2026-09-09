/** Shared event vocabulary; delivery preferences are independent per channel. */
export const NOTIFICATION_EVENTS = [
  { id: 'updates', label: 'agent, SDK and CLI updates' },
  { id: 'session_finished', label: 'session finished — no background tasks left' },
  { id: 'session_error', label: 'session interrupted by an error' },
  { id: 'session_background', label: 'response finished — background tasks still running' },
  { id: 'permission', label: 'permission requested' },
  { id: 'question', label: 'question awaiting your reply' },
  { id: 'plan', label: 'plan ready for approval' },
  { id: 'installation', label: 'agent installation finished or failed' },
  { id: 'shell_idle', label: 'terminal activity finished' },
] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number]['id'];
export type NotificationEvents = Record<NotificationEvent, boolean>;
export type BrowserNotificationPreferences = { enabled: boolean; sound: boolean; events: NotificationEvents; sessions?: Record<string, ChannelNotificationPreferences> };
export const DEFAULT_NOTIFICATION_EVENTS = Object.fromEntries(
  NOTIFICATION_EVENTS.map(({ id }) => [id, true]),
) as NotificationEvents;
export const DEFAULT_BROWSER_NOTIFICATIONS: BrowserNotificationPreferences = {
  enabled: false, sound: true, events: DEFAULT_NOTIFICATION_EVENTS,
};
export function normalizeBrowserNotifications(value: unknown, enabled = false): BrowserNotificationPreferences {
  const v = value && typeof value === 'object' ? value as Partial<BrowserNotificationPreferences> : {};
  const sessions: Record<string, ChannelNotificationPreferences> = Object.create(null);
  if (v.sessions && typeof v.sessions === 'object') {
    for (const [id, pref] of Object.entries(v.sessions).slice(0, 2000)) {
      if (/^[a-zA-Z0-9_-]{1,128}$/.test(id) && pref && typeof pref === 'object') {
        // Project only channel fields; never recursively accept nested overrides.
        sessions[id] = normalizeChannelNotifications({ enabled: pref.enabled, sound: pref.sound, events: pref.events });
      }
    }
  }
  return {
    ...(Object.keys(sessions).length ? { sessions } : {}),
    enabled: typeof v.enabled === 'boolean' ? v.enabled : enabled,
    sound: typeof v.sound === 'boolean' ? v.sound : true,
    events: Object.fromEntries(NOTIFICATION_EVENTS.map(({ id }) => [
      id, typeof v.events?.[id] === 'boolean' ? v.events[id] : true,
    ])) as NotificationEvents,
  };
}
export function parseBrowserNotifications(json: string | null, enabled = true): BrowserNotificationPreferences {
  try { return normalizeBrowserNotifications(JSON.parse(json ?? 'null'), enabled); }
  catch { return normalizeBrowserNotifications(null, enabled); }
}

export const SESSION_NOTIFICATION_EVENTS = NOTIFICATION_EVENTS.filter(({ id }) =>
  !(['updates', 'installation', 'shell_idle'] as string[]).includes(id));
export type ChannelNotificationPreferences = { enabled: boolean; sound: boolean; events: NotificationEvents };
export type SessionNotificationSettings = {
  telegram: ChannelNotificationPreferences | null;
  defaults: ChannelNotificationPreferences;
};
export type NotificationSession = {
  id: string; name: string | null; cwd: string; vpsName: string; status: string;
  telegramException: boolean;
};
export function effectiveBrowserNotifications(preferences: BrowserNotificationPreferences, sessionId?: string | null): ChannelNotificationPreferences {
  return (sessionId && preferences.sessions?.[sessionId]) || preferences;
}
export function browserNotificationsEnabled(preferences: BrowserNotificationPreferences): boolean {
  return preferences.enabled || Object.values(preferences.sessions ?? {}).some((s) => s.enabled);
}
export function normalizeChannelNotifications(value: unknown): ChannelNotificationPreferences {
  const { enabled, sound, events } = normalizeBrowserNotifications(value);
  return { enabled, sound, events };
}
