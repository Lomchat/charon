import 'server-only';

/**
 * Curated list of model IDs accepted by `claude-agent-sdk` (which forwards
 * them as the SDK's `model` / `fallback_model` option, ultimately passed to
 * Anthropic's API).
 *
 * Why this is hand-curated (and not auto-fetched):
 * - The SDK does NOT expose a `list_models()` API.
 * - The Anthropic public API has no unauthenticated catalog endpoint we can
 *   hit from the hub without an API key (Charon uses OAuth via Claude Code
 *   on the VPS, not a hub-side key).
 * - We confirmed the current model IDs by running `claude --print` on a
 *   live VPS and inspecting the resulting `modelUsage` JSON. As of 2026-05:
 *     - claude-opus-4-8           (1M ctx, 64k out)
 *     - claude-sonnet-4-6         (latest sonnet)
 *     - claude-haiku-4-5-20251001 (latest haiku, date-stamped)
 *   Plus three short aliases (`opus`, `sonnet`, `haiku`) advertised by
 *   `claude --help` that resolve to the latest of each family.
 *
 * When Anthropic ships a new model:
 * 1. Update this list.
 * 2. (optional) Add a previous-version entry to the OLDER block so users
 *    can still pin against it.
 * No agent or DB change required — the agent passes the string straight
 * through, and old strings remain accepted by the API as long as Anthropic
 * keeps them available.
 *
 * The list is exposed via `GET /api/claude/models` and consumed by the
 * model picker in NewSessionDialog / NewSessionSheet / SettingsModal /
 * ModelEffortBadges. Free-text override is intentionally NOT offered any
 * more — empirically users typed model strings that don't exist
 * (`claude-opus-4-7` when the actual current is 4.8), got silent SDK
 * fallback, and concluded "the feature is broken". Better a closed list
 * that's occasionally out of date than an open one that produces silent
 * failure.
 */

export type ClaudeModelGroup = 'aliases' | 'current' | 'previous';

export type KnownModel = {
  /** The exact string passed to ClaudeAgentOptions.model / fallback_model. */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** Used to render <optgroup>. */
  group: ClaudeModelGroup;
  /** Short freeform description (context window, tradeoffs). Optional. */
  hint?: string;
};

export const KNOWN_MODELS: KnownModel[] = [
  // Aliases — always resolve to the latest of each family. Recommended for
  // most sessions: you'll get model upgrades for free.
  { id: 'opus',   label: 'opus (latest)',   group: 'aliases', hint: 'always latest Opus (= 4.8 today)' },
  { id: 'sonnet', label: 'sonnet (latest)', group: 'aliases', hint: 'always latest Sonnet (= 4.6 today)' },
  { id: 'haiku',  label: 'haiku (latest)',  group: 'aliases', hint: 'always latest Haiku (= 4.5 today)' },

  // Versioned pins — use when you want reproducibility (a session that
  // outlasts a model rev). Anthropic keeps older models accessible by name.
  { id: 'claude-opus-4-8',   label: 'Opus 4.8',   group: 'current', hint: '1M ctx, 64k out' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'current' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  group: 'current', hint: 'fastest + cheapest' },

  // Older — kept as options for users with active sessions pinned there.
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',   group: 'previous' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', group: 'previous' },
];

/** Returns true if `id` matches a known model OR a versioned format the SDK
 *  is likely to accept (claude-{family}-{m}-{n}[-YYYYMMDD]). We tolerate
 *  date-stamped variants the UI doesn't list (e.g. claude-haiku-4-5-20251001)
 *  so admins can paste a specific dated string from telemetry. */
export function isPlausibleModelId(id: string): boolean {
  if (!id) return false;
  if (KNOWN_MODELS.some((m) => m.id === id)) return true;
  return /^claude-(opus|sonnet|haiku)-\d+(-\d+)*$/.test(id);
}
