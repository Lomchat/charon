/** The two provider instruction filenames share one source through a symlink. */
const COUNTERPART: Readonly<Record<string, string>> = {
  'AGENTS.md': 'CLAUDE.md',
  'CLAUDE.md': 'AGENTS.md',
};

/**
 * Return the missing counterpart that may be created for `sourceName`.
 *
 * Names are intentionally case-sensitive: these are the exact conventional
 * filenames read by the CLIs on a Linux VPS. A stale tree may still offer the
 * action during a race, but the agent's lexists check remains authoritative
 * and refuses to overwrite the newly-created sibling.
 */
export function missingInstructionSymlink(
  sourceName: string,
  siblingNames: Iterable<string>,
): string | null {
  const counterpart = COUNTERPART[sourceName];
  if (!counterpart) return null;
  for (const name of siblingNames) {
    if (name === counterpart) return null;
  }
  return counterpart;
}
