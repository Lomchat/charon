import { NOTIFICATION_EVENTS } from '@/lib/notificationPreferences';
import {
  PROVIDERS, SESSION_PROVIDERS, providerSettingKey,
} from '@/lib/sessionCapabilities';

// Which settings keys a POST may write.
//
// Extracted from the route so it can be TESTED: a key missing here is dropped
// silently by the write loop, so the toggle flips, saves "successfully" and
// comes back on at the next GET. That is exactly how the Cursor switch shipped
// doing nothing — the guard test existed but only knew the two hard-coded
// keys it was written with.
//
// Per-provider keys are DERIVED (§14.102), so provider #4 cannot repeat it.
export const SETTINGS_WRITE_ALLOWLIST = [
  'ssh.private_key_path',
  ...NOTIFICATION_EVENTS.map(({ id }) => `telegram.notify.${id}`),
  'telegram.enabled',
  'telegram.bot_token',
  'telegram.chat_id',
  'app.public_url',
  // Hub-wide look — an id from app/themes.ts, validated below (§11).
  'app.theme',
  'app.density',
  // Hub-wide backend switches + per-provider defaults, DERIVED from the
  // registry (§14.102). A key missing here is dropped SILENTLY by the loop
  // below — which is exactly how the Cursor toggle shipped doing nothing and
  // re-enabling itself on reopen. Deriving them means provider #4 cannot
  // repeat it.
  ...SESSION_PROVIDERS.flatMap((p) => [
    PROVIDERS[p].settings.enabledKey,
    // The fleet auto-update gate. DERIVED because it is not derivable from the
    // id: Claude's is the historical `sdk.auto_update`. Listed by hand, the
    // third backend's gate was dropped SILENTLY by the write loop, so its
    // toggle could never be turned off — and it defaults ON, which meant every
    // release of an OPT-IN backend's package sleeping and resuming every
    // session on every quiet VPS in the fleet.
    PROVIDERS[p].settings.autoUpdateKey,
    providerSettingKey(p, 'default_model'),
    providerSettingKey(p, 'default_effort'),
    providerSettingKey(p, 'default_permission_mode'),
  ]),
  'claude.default_fallback_model',
  // Fleet default for the Claude settings scope (§14.100). A VPS and a session
  // may each override it; validated below through the shared parser so 'none'
  // and an unknown token can't be confused.
  'claude.setting_sources',
  'codex.default_approvals_reviewer',
  // Optional hub-side Anthropic API key, used only to auto-sync the model
  // list from GET /v1/models (see modelSync.ts). models_cache/_at are written
  // by the sync, never accepted from a settings POST.
  'claude.api_key',
];
