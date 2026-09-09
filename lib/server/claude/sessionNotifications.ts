import 'server-only';
import { eq } from 'drizzle-orm';
import { db, sessionNotificationSettings } from '@/lib/db';
import { NOTIFICATION_EVENTS, normalizeChannelNotifications, type ChannelNotificationPreferences, type NotificationEvent } from '@/lib/notificationPreferences';
import { getSettingBool } from './settings';

export function telegramNotificationDefaults(): ChannelNotificationPreferences {
  return normalizeChannelNotifications({ enabled: getSettingBool('telegram.enabled'),
    events: Object.fromEntries(NOTIFICATION_EVENTS.map(({ id }) => [id, getSettingBool(`telegram.notify.${id}`)])) });
}
export function sessionTelegramNotifications(sessionId?: string): ChannelNotificationPreferences | null {
  if (!sessionId) return null;
  const row = db.select().from(sessionNotificationSettings).where(eq(sessionNotificationSettings.sessionId, sessionId)).get();
  try { return row ? normalizeChannelNotifications(JSON.parse(row.telegram)) : null; }
  catch { return null; }
}
export function telegramNotificationEnabled(event: NotificationEvent, sessionId?: string): boolean {
  const settings = sessionTelegramNotifications(sessionId) ?? telegramNotificationDefaults();
  return settings.enabled && settings.events[event];
}
export function telegramHasEnabledChannel(): boolean {
  if (getSettingBool('telegram.enabled')) return true;
  return db.select().from(sessionNotificationSettings).all().some((row) => {
    try { return JSON.parse(row.telegram).enabled === true; } catch { return false; }
  });
}
