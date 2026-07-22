import { NextResponse } from 'next/server';
import { requireApiSession } from '@/lib/server/session';
import { getAllSettings, setSetting } from '@/lib/server/claude/settings';

const ALLOWED_KEYS = [
  'ssh.private_key_path',
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

// Secrets are never returned in full to the browser: the GET masks them to
// `••••<last4>` (truthy, so "configured?" checks in the UI keep working) and
// the POST treats a still-masked value as "unchanged — keep the stored one".
// Sending an empty string still clears the secret explicitly.
const SECRET_KEYS = ['telegram.bot_token', 'claude.api_key'] as const;
const MASK_PREFIX = '••••'; // ••••

function maskSecrets(all: Record<string, string>): Record<string, string> {
  for (const k of SECRET_KEYS) {
    const v = all[k];
    if (v) all[k] = `${MASK_PREFIX}${v.length > 4 ? v.slice(-4) : ''}`;
  }
  return all;
}

function sanitizeForResponse(all: Record<string, string>): Record<string, string> {
  // Never expose the private VAPID key.
  delete all['vapid.private'];
  // The cached model catalog can be several KB of JSON — not needed by the UI
  // (the picker fetches the merged list from /api/claude/models). Keep the
  // lightweight `claude.models_cache_at` timestamp for the "last sync" label.
  delete all['claude.models_cache'];
  return maskSecrets(all);
}

export async function GET() {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  return NextResponse.json(sanitizeForResponse(getAllSettings()));
}

export async function POST(req: Request) {
  const s = await requireApiSession();
  if (s instanceof Response) return s;
  const body = await req.json();
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'object required' }, { status: 400 });
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(k)) continue;
    const val = String(v);
    // A masked secret round-tripping from the settings form means "unchanged".
    if ((SECRET_KEYS as readonly string[]).includes(k) && val.startsWith(MASK_PREFIX)) continue;
    setSetting(k as any, val);
  }
  return NextResponse.json(sanitizeForResponse(getAllSettings()));
}
