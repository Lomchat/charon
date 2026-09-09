// ── Which Claude settings files a session loads (§14.100) ───────────────────
// The Claude Agent SDK exposes `setting_sources`, i.e. WHICH of the three
// on-disk settings files the CLI reads when a session starts:
//
//   user     ~/.claude/settings.json            — the box's own config
//   project  <cwd>/.claude/settings.json        — the repo's config (+ CLAUDE.md)
//   local    <cwd>/.claude/settings.local.json  — this machine, this repo
//
// Charon hard-coded ['project'] from the very first agent commit. That is what
// loads CLAUDE.md, but it also means the VPS owner's own rules — permission
// deny lists, hooks, user-level skills/agents/commands — were silently ignored
// for every session, while the repo (the LEAST trusted of the three) was the
// only source that could speak. This module is the vocabulary that makes the
// choice explicit and shared by the four layers that can express it:
//
//   .env  →  hub setting  →  vps.claudeSettingSources  →  session config
//
// PLAIN module on purpose (no 'server-only'): the routes, the resolution in
// sessionOps and the browser controls must agree on one parser, one canonical
// order and one rendering — cf. nextPath.ts (§14.40) for the same reason.

export const CLAUDE_SETTING_SOURCES = ['user', 'project', 'local'] as const;
export type ClaudeSettingSource = (typeof CLAUDE_SETTING_SOURCES)[number];

/** What a session loads when no layer says otherwise (the historical value). */
export const DEFAULT_SETTING_SOURCES: readonly ClaudeSettingSource[] = ['project'];

// A stored/serialized empty list needs a word: '' already means "inherit", so
// isolation mode (the SDK's `[]` — no settings file at all, CLAUDE.md included)
// is spelled out. Keeping the two apart is the load-bearing distinction of this
// whole feature; every layer round-trips through the pair below.
export const SETTING_SOURCES_NONE = 'none';

export function isClaudeSettingSource(v: unknown): v is ClaudeSettingSource {
  return typeof v === 'string' && (CLAUDE_SETTING_SOURCES as readonly string[]).includes(v);
}

function canonical(values: string[]): ClaudeSettingSource[] {
  const seen = new Set<ClaudeSettingSource>();
  for (const raw of values) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!isClaudeSettingSource(v)) throw new Error(`unknown settings source: ${raw.trim().slice(0, 32)}`);
    seen.add(v);
  }
  // Canonical ORDER (not insertion order) so equality checks, tests and stored
  // strings are stable no matter which UI produced them.
  return CLAUDE_SETTING_SOURCES.filter((s) => seen.has(s));
}

/**
 * Tri-state parse. Returns `null` for "inherit the layer above" (absent, null,
 * empty string), `[]` for explicit isolation ('none' / an empty array), and the
 * canonical list otherwise. THROWS on an unknown token — callers turn that into
 * a 400 / a rejected settings key rather than silently dropping it.
 */
export function parseSettingSources(raw: unknown): ClaudeSettingSource[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return canonical(raw.map((v) => {
      if (typeof v !== 'string') throw new Error('settings sources must be strings');
      return v;
    }));
  }
  if (typeof raw !== 'string') throw new Error('settings sources must be a list or a comma-separated string');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === SETTING_SOURCES_NONE) return [];
  return canonical(trimmed.split(','));
}

/**
 * parseSettingSources for read paths that must not throw: a value that made it
 * into storage (or arrived from an older hub) is treated as "no opinion" rather
 * than taking a render or a session start down with it.
 */
export function safeParseSettingSources(raw: unknown): ClaudeSettingSource[] | null {
  try { return parseSettingSources(raw); } catch { return null; }
}

/** Inverse of parseSettingSources: '' = inherit, 'none' = isolation. */
export function formatSettingSources(value: readonly ClaudeSettingSource[] | null | undefined): string {
  if (value == null) return '';
  return value.length ? value.join(',') : SETTING_SOURCES_NONE;
}

/**
 * First layer that expresses an opinion wins; the built-in default closes the
 * chain. Pass the layers OUTSIDE-IN (most specific first): session, VPS, hub.
 */
export function resolveSettingSources(
  ...layers: Array<readonly ClaudeSettingSource[] | null | undefined>
): ClaudeSettingSource[] {
  for (const layer of layers) if (layer != null) return [...layer];
  return [...DEFAULT_SETTING_SOURCES];
}

export const SETTING_SOURCE_INFO: Record<ClaudeSettingSource, { file: string; hint: string }> = {
  user: {
    file: '~/.claude/settings.json',
    hint: 'the VPS owner’s own rules: permission deny lists, hooks, user-level skills, subagents and slash commands',
  },
  project: {
    file: '<cwd>/.claude/settings.json',
    hint: 'the repository’s settings — also what loads its CLAUDE.md files',
  },
  local: {
    file: '<cwd>/.claude/settings.local.json',
    hint: 'per-machine settings inside the repo (git-ignored). The agent can write this file itself',
  },
};

/** One-line human rendering, used by every surface that shows a resolved value. */
export function describeSettingSources(value: readonly ClaudeSettingSource[] | null | undefined): string {
  if (value == null) return 'inherited';
  if (!value.length) return 'none (no settings file, no CLAUDE.md)';
  return value.join(' + ');
}

/** Dropping `project` also drops CLAUDE.md — worth saying wherever it is picked. */
export function settingSourcesWarning(value: readonly ClaudeSettingSource[] | null | undefined): string | null {
  if (value == null) return null;
  if (!value.includes('project')) return 'without “project”, this session no longer loads the repository’s CLAUDE.md.';
  if (value.includes('local')) return '“local” is a file inside the working tree, so a session can write its own rules for its next start.';
  return null;
}
