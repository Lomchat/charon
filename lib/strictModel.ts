// Strict-model sessions (CLAUDE.md §14.118): does the model that answered
// match the one the session asked for? A false "no" stops a good run, so the
// rules only accept what a provider is known to report for the asked id:
// Claude aliases resolve to `claude-<alias>-<version>`, a pinned id may come
// back with a date suffix, and an endpoint router may prefix its vendor.

const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

function norm(id: string): string {
  return id.trim().toLowerCase().replace(/\[1m\]$/, '');
}

/** `requested` = the session's model column (null / `default` = nothing
 *  asked, so nothing to enforce); `effective` = the agent's `effective_model`. */
export function sameModel(requested: string | null | undefined, effective: string): boolean {
  const want = norm(requested ?? '');
  const got = norm(effective);
  if (!want || want === 'default' || !got) return true;
  if (got === want) return true;
  if (CLAUDE_ALIASES.has(want)) return got.startsWith(`claude-${want}-`);
  if (got.startsWith(`${want}-`) && /^\d{8}$/.test(got.slice(want.length + 1))) return true;
  return got.endsWith(`/${want}`) || want.endsWith(`/${got}`);
}
