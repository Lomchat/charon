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
/**
 * Carry a session's Telegram override onto a branch (§14.94). A fork is a
 * continuation, so it inherits the delivery rules with the conversation:
 * falling back to the fleet default would silently re-enable — or silence —
 * notifications on a session the user thinks of as the same one.
 * NO row is the "inherit the defaults" state, and it copies as no row: never
 * materialise today's defaults into an override the user never asked for.
 * Returns whether anything was written, so the caller can announce it.
 */
export function copySessionNotificationSettings(fromSessionId: string, toSessionId: string): boolean {
  const row = db.select().from(sessionNotificationSettings)
    .where(eq(sessionNotificationSettings.sessionId, fromSessionId)).get();
  if (!row) return false;
  db.insert(sessionNotificationSettings).values({ sessionId: toSessionId, telegram: row.telegram })
    .onConflictDoUpdate({ target: sessionNotificationSettings.sessionId, set: { telegram: row.telegram } }).run();
  return true;
}
export function telegramHasEnabledChannel(): boolean {
  if (getSettingBool('telegram.enabled')) return true;
  return db.select().from(sessionNotificationSettings).all().some((row) => {
    try { return JSON.parse(row.telegram).enabled === true; } catch { return false; }
  });
}
