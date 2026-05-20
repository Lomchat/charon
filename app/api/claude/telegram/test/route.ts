import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { sendTestMessage, startTelegramBot } from '@/lib/server/claude/telegram';

// POST /api/claude/telegram/test
// Sends a test message to the configured chat_id and confirms the bot polls.
export async function POST() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  // Make sure polling is started after a config update
  startTelegramBot();
  const r = await sendTestMessage();
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
