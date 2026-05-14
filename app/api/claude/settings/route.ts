import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getAllSettings, setSetting } from '@/lib/server/claude/settings';

const ALLOWED_KEYS = [
  'ssh.private_key_path',
  'session.max_active',
  'retention.killed_days',
  'notif.global_enabled',
  'vapid.subject',
  'telegram.enabled',
  'telegram.bot_token',
  'telegram.chat_id',
];

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const all = getAllSettings();
  // Ne pas exposer la VAPID privée
  delete all['vapid.private'];
  return NextResponse.json(all);
}

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'object required' }, { status: 400 });
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(k)) continue;
    setSetting(k as any, String(v));
  }
  const all = getAllSettings();
  delete all['vapid.private'];
  return NextResponse.json(all);
}
