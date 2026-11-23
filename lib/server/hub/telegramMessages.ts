import 'server-only';
import { and, eq, isNull, lt, type SQL } from 'drizzle-orm';
import { db, telegramMessages } from '@/lib/db';
import { getSetting } from './settings';
import { tgPost } from './telegramApi';

// Telegram mirrors Charon's attention: a session's notices disappear once it
// is read (§14.47), a gate's messages once it resolves, wherever it was
// answered. Rows are durable so a hub restart still deletes them.

/** Telegram refuses to delete a message older than 48 h. */
const DELETE_WINDOW_MS = 48 * 3600_000;

export type TelegramMessageRef = { chatId: string; messageId: number };

export function recordTelegramMessage(m: {
  chatId: string | number; messageId: number; sessionId?: string | null; gateId?: string | null;
}): void {
  const now = Date.now();
  try {
    db.delete(telegramMessages).where(lt(telegramMessages.sentAt, now - DELETE_WINDOW_MS)).run();
    db.insert(telegramMessages).values({
      chatId: String(m.chatId), messageId: m.messageId,
      sessionId: m.sessionId ?? null, gateId: m.gateId ?? null, sentAt: now,
    }).onConflictDoNothing().run();
  } catch (e) {
    console.warn('[telegram] record message:', (e as Error)?.message ?? e);
  }
}

/** Rows leave the table BEFORE the deletes run: a second caller finds nothing. */
function take(where: SQL | undefined): TelegramMessageRef[] {
  try {
    return db.delete(telegramMessages).where(where)
      .returning({ chatId: telegramMessages.chatId, messageId: telegramMessages.messageId }).all();
  } catch {
    return [];
  }
}

/** Deletes each message; returns the ones Telegram refused (too old, no right…). */
async function deleteAll(refs: TelegramMessageRef[]): Promise<TelegramMessageRef[]> {
  if (refs.length === 0) return [];
  const token = (getSetting('telegram.bot_token') ?? '').trim();
  if (!token) return refs;
  const failed: TelegramMessageRef[] = [];
  for (const r of refs) {
    try {
      await tgPost(token, 'deleteMessage', { chat_id: r.chatId, message_id: r.messageId });
    } catch (e) {
      // Already gone (deleted by hand) is the wanted outcome.
      if (!/message to delete not found/i.test(String((e as Error)?.message))) failed.push(r);
    }
  }
  return failed;
}

/** The session was read: its notices go; a pending gate's stay. */
export function deleteSessionTelegramNotices(sessionId: string): void {
  const refs = take(and(eq(telegramMessages.sessionId, sessionId), isNull(telegramMessages.gateId)));
  void deleteAll(refs).catch(() => {});
}

/** The gate resolved: every message about it goes (the question, each step,
 *  the replies typed in Telegram). Returns those Telegram refused. */
export function deleteGateTelegramMessages(gateId: string): Promise<TelegramMessageRef[]> {
  return deleteAll(take(eq(telegramMessages.gateId, gateId))).catch(() => []);
}
