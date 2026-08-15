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
  /** Effort levels supported, from the live catalog (modelSync). Undefined on
   *  seed entries until enriched by a sync; empty = effort unsupported. */
  efforts?: string[];
};

export const KNOWN_MODELS: KnownModel[] = [
  // Aliases — always resolve to the latest of each family. Recommended for
  // most sessions: you'll get model upgrades for free.
  { id: 'default', label: 'default',          group: 'aliases', hint: "Claude Code's own default (= Sonnet 5 today)" },
  { id: 'best',    label: 'best',             group: 'aliases', hint: 'highest-capability model available to the account' },
  { id: 'opus',    label: 'opus (latest)',    group: 'aliases', hint: 'always latest Opus' },
  { id: 'sonnet',  label: 'sonnet (latest)',  group: 'aliases', hint: 'always latest Sonnet' },
  { id: 'haiku',   label: 'haiku (latest)',   group: 'aliases', hint: 'always latest Haiku' },
  { id: 'fable',   label: 'fable (latest)',   group: 'aliases', hint: 'always latest Fable' },
  // Not a family: plans on Opus, executes on the cheaper model.
  { id: 'opusplan', label: 'opusplan',        group: 'aliases', hint: 'Opus while planning, then steps down' },

  // Versioned pins — use when you want reproducibility (a session that
  // outlasts a model rev). Anthropic keeps older models accessible by name.
  { id: 'claude-fable-5',    label: 'Fable 5',    group: 'current', hint: 'highest tier' },
  { id: 'claude-opus-5',     label: 'Opus 5',     group: 'current', hint: '1M ctx' },
  { id: 'claude-sonnet-5',   label: 'Sonnet 5',   group: 'current', hint: 'native 1M ctx — Claude Code default' },
  { id: 'claude-opus-4-8',   label: 'Opus 4.8',   group: 'current', hint: '1M ctx, 64k out' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'current' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  group: 'current', hint: 'fastest + cheapest' },

  // Older — kept as options for users with active sessions pinned there.
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',   group: 'previous' },
  { id: 'claude-opus-4-6',   label: 'Opus 4.6',   group: 'previous' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', group: 'previous' },
];

/** Aliases the CLI accepts that are NOT `claude-*` strings. Kept as data
 *  rather than folded into the regex so the picker and the validator agree. */
const BARE_ALIASES = new Set(['default', 'best', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan']);

/** Returns true if `id` is something the CLI plausibly accepts.
 *
 *  ⚠ Do NOT reintroduce a family allow-list here (§14.43). This function used
 *  to test `^claude-(opus|sonnet|haiku)-…`, which silently rejected
 *  `claude-fable-5` — exactly the regression §14.43 was written about, shipped
 *  again. Any `claude-*` id passes; the API is the authority on which exist.
 *
 *  Two shapes beyond the plain id, both real:
 *   - a `[1m]` / `[1M]` suffix selecting the 1M-context variant
 *     (`sonnet[1m]`, `claude-opus-4-6[1m]`, and `opusplan[1m]`);
 *   - date-stamped pins (`claude-haiku-4-5-20251001`) pasted from telemetry.
 */
export function isPlausibleModelId(id: string): boolean {
  if (!id) return false;
  const bare = id.replace(/\[1m\]$/i, '');
  if (!bare) return false;
  if (KNOWN_MODELS.some((m) => m.id === bare)) return true;
  if (BARE_ALIASES.has(bare)) return true;
  return /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(bare);
}
