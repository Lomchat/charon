import 'server-only';

/** Versioned Claude models come exclusively from GET /v1/models. Only
 * Claude Code's short aliases are static; they are selectors, not releases. */
export type ClaudeModelGroup = 'aliases' | 'current' | 'previous';

export type KnownModel = {
  id: string;
  label: string;
  group: ClaudeModelGroup;
  hint?: string;
  /** Undefined on aliases/custom ids; empty means effort is unsupported. */
  efforts?: string[];
};

export const CLAUDE_MODEL_ALIASES: KnownModel[] = [
  { id: 'default', label: 'default', group: 'aliases', hint: "Claude Code's own default" },
  { id: 'best', label: 'best', group: 'aliases', hint: 'highest-capability model available to the account' },
  { id: 'opus', label: 'opus (latest)', group: 'aliases', hint: 'always latest Opus' },
  { id: 'sonnet', label: 'sonnet (latest)', group: 'aliases', hint: 'always latest Sonnet' },
  { id: 'haiku', label: 'haiku (latest)', group: 'aliases', hint: 'always latest Haiku' },
  { id: 'fable', label: 'fable (latest)', group: 'aliases', hint: 'always latest Fable' },
];

const BARE_ALIASES = new Set(CLAUDE_MODEL_ALIASES.map((m) => m.id));

/** Syntax validation only: accept any Claude family, date-stamped pins and
 * [1m] variants (§14.43). The provider decides which concrete ids exist. */
export function isPlausibleModelId(id: string): boolean {
  if (!id) return false;
  const bare = id.replace(/\[1m\]$/i, '');
  return BARE_ALIASES.has(bare) || /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(bare);
}
