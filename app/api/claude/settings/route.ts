import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getAllSettings, setSetting } from '@/lib/server/claude/settings';

const ALLOWED_KEYS = [
  'ssh.private_key_path',
  'session.max_active',
  'retention.killed_days',
  'notif.global_enabled',
  'shell.notify_idle',
  'vapid.subject',
  'telegram.enabled',
  'telegram.bot_token',
  'telegram.chat_id',
  'app.public_url',
  'claude.default_model',
  'claude.default_fallback_model',
  'claude.default_effort',
  // Codex (OpenAI) global defaults + auto-update toggle. codex.latest_version(_at)
  // are written by the freshness sync, never accepted from a settings POST.
  'codex.default_model',
  'codex.default_effort',
  'codex.auto_update',
  // Optional hub-side Anthropic API key, used only to auto-sync the model
  // list from GET /v1/models (see modelSync.ts). models_cache/_at are written
  // by the sync, never accepted from a settings POST.
  'claude.api_key',
  // Fleet-wide claude-agent-sdk auto-update (idle VPSes only, cf. sdkWatch).
  // sdk.latest_version(_at) / sdk.last_notified_version are written by the
  // sync/tick, never accepted from a settings POST.
  'sdk.auto_update',
];

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const all = getAllSettings();
  // Do not expose the private VAPID
  delete all['vapid.private'];
  // The cached model catalog can be several KB of JSON — not needed by the UI
  // (the picker fetches the merged list from /api/claude/models). Keep the
  // lightweight `claude.models_cache_at` timestamp for the "last sync" label.
  delete all['claude.models_cache'];
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
