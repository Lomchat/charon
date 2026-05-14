import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { sendTestMessage, startTelegramBot } from '@/lib/server/claude/telegram';

// POST /api/claude/telegram/test
// Envoie un message de test au chat_id configuré et confirme que le bot poll.
export async function POST() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  // S'assure que le poll est lancé après une mise à jour de config
  startTelegramBot();
  const r = await sendTestMessage();
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
