import { NextResponse } from 'next/server';
import { NOTIFICATION_EVENTS } from '@/lib/notificationPreferences';
import { emitGlobalSettingsChanged } from '@/lib/server/agent/sessionOps';
import { requireApiSession } from '@/lib/server/session';
import { getAllSettings, setSetting } from '@/lib/server/claude/settings';
import { isSessionMode } from '@/lib/sessionCapabilities';
import { formatSettingSources, parseSettingSources } from '@/lib/settingSources';
import { isThemeId } from '@/app/themes';

const ALLOWED_KEYS = [
  'ssh.private_key_path',
  ...NOTIFICATION_EVENTS.map(({ id }) => `telegram.notify.${id}`),
  'telegram.enabled',
  'telegram.bot_token',
  'telegram.chat_id',
  'app.public_url',
  // Hub-wide look — an id from app/themes.ts, validated below (§11).
  'app.theme',
  // Hub-wide backend switches — 'false' hides that backend's launchers (§11).
  'claude.enabled',
  'codex.enabled',
  'claude.default_model',
  'claude.default_fallback_model',
  'claude.default_effort',
  'claude.default_permission_mode',
  // Fleet default for the Claude settings scope (§14.100). A VPS and a session
  // may each override it; validated below through the shared parser so 'none'
  // and an unknown token can't be confused.
  'claude.setting_sources',
  // Codex (OpenAI) global defaults + auto-update toggle. codex.latest_version(_at)
  // are written by the freshness sync, never accepted from a settings POST.
  'codex.default_model',
  'codex.default_effort',
  'codex.default_permission_mode',
  'codex.default_approvals_reviewer',
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

// Secrets are never returned in full to the browser. Two display shapes:
//  - telegram.bot_token → `••••<last4>` (bullet mask).
//  - claude.api_key     → `sk-ant-api…<last4>` (start+end preview). It is NOT a
//    `••••` mask and its field is NOT `type=password` on purpose: Chrome's
//    password manager autofills the hub LOGIN password into password fields
//    (ignoring autocomplete=off), which silently overwrote the real key → every
//    catalog sync 401'd (real incident). A plain-text field that shows only
//    start+end dodges autofill AND never reveals the secret middle.
// POST treats a round-tripped mask/preview as "unchanged — keep the stored one"
// (telegram via the `••••` prefix; api_key via the `…` a real key never holds);
// an empty string still clears the secret. Both stay ENCRYPTED AT REST
// (settings.ts § SECRET_SETTING_KEYS).
const SECRET_KEYS = ['telegram.bot_token'] as const;
const MASK_PREFIX = '••••'; // ••••
const KEY_PREVIEW_ELLIPSIS = '…'; // U+2026 — never appears in a real api key

function maskSecrets(all: Record<string, string>): Record<string, string> {
  for (const k of SECRET_KEYS) {
    const v = all[k];
    if (v) all[k] = `${MASK_PREFIX}${v.length > 4 ? v.slice(-4) : ''}`;
  }
  // claude.api_key: reveal only start + end (`sk-ant-api…wXYZ`) so the user can
  // recognise/verify which key is set without exposing the secret middle.
  const key = all['claude.api_key'];
  if (key) {
    all['claude.api_key'] = key.length > 14
      ? `${key.slice(0, 10)}${KEY_PREVIEW_ELLIPSIS}${key.slice(-4)}`
      : `${KEY_PREVIEW_ELLIPSIS}${key.slice(-4)}`;
  }
  return all;
}

function sanitizeForResponse(all: Record<string, string>): Record<string, string> {
  // Push authentication is internal; the public key has its own subscribe endpoint.
  for (const key of Object.keys(all)) if (key.startsWith('vapid.')) delete all[key];
  delete all['notif.global_enabled'];
  delete all['shell.notify_idle'];
  // The cached model catalog can be several KB of JSON — not needed by the UI
  // (the picker fetches the merged list from /api/claude/models). Keep the
  // lightweight `claude.models_cache_at` timestamp for the "last sync" label.
  delete all['claude.models_cache'];
  delete all['claude.cli_models_cache'];
  delete all['models.notices'];
  // Same deal for the persisted account-usage snapshots (§14.72): several KB of
  // JSON the UI gets live over SSE / GET /api/vps/[id]/usage instead.
  delete all['usage.snapshots'];
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
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!ALLOWED_KEYS.includes(k)) continue;
    const val = String(v);
    if ((k.startsWith('telegram.notify.') || k === 'telegram.enabled'
         || k === 'claude.enabled' || k === 'codex.enabled')
        && val !== 'true' && val !== 'false') {
      rejected.push(k);
      continue;
    }
    if (k === 'claude.default_permission_mode' && !isSessionMode('claude', val)) {
      rejected.push(k);
      continue;
    }
    if (k === 'codex.default_permission_mode' && !isSessionMode('codex', val)) {
      rejected.push(k);
      continue;
    }
    if (k === 'codex.default_approvals_reviewer'
        && val !== 'user' && val !== 'auto_review') {
      rejected.push(k);
      continue;
    }
    // The fleet default must always name a scope: '' here would mean "inherit"
    // with nothing left to inherit from. Refuse it rather than resolve to a
    // value the operator did not pick.
    if (k === 'claude.setting_sources') {
      let parsed: ReturnType<typeof parseSettingSources> | undefined;
      try { parsed = parseSettingSources(val); } catch { parsed = undefined; }
      if (parsed === undefined || parsed === null) {
        rejected.push(k);
        continue;
      }
      setSetting(k as any, formatSettingSources(parsed));
      continue;
    }
    // An unknown theme id would render every page against tokens nothing
    // defines — refuse it here rather than degrade at paint time.
    if (k === 'app.theme' && !isThemeId(val)) {
      rejected.push(k);
      continue;
    }
    // A masked secret round-tripping from the settings form means "unchanged".
    if ((SECRET_KEYS as readonly string[]).includes(k) && val.startsWith(MASK_PREFIX)) continue;
    // The claude.api_key start+end preview round-trips as "unchanged" — a real
    // key never contains the ellipsis, so keep the stored key untouched. (Empty
    // still falls through below to clear it.)
    if (k === 'claude.api_key' && val.includes(KEY_PREVIEW_ELLIPSIS)) continue;
    // Guard: an Anthropic API key MUST look like one (`sk-ant-…`). Browsers /
    // password managers can autofill the site LOGIN password into this field;
    // storing it overwrote the real key → every catalog sync 401'd. Refuse any
    // non-empty value that isn't a plausible key (empty is still allowed =
    // "clear the key"). Skip storing it and report it back.
    if (k === 'claude.api_key' && val !== '' && !val.startsWith('sk-ant-')) {
      rejected.push(k);
      console.warn('[settings] rejected a claude.api_key that is not sk-ant-… (browser autofill?) — not storing');
      continue;
    }
    setSetting(k as any, val);
  }
  emitGlobalSettingsChanged();
  return NextResponse.json({ ...sanitizeForResponse(getAllSettings()), ...(rejected.length ? { rejected } : {}) });
}
