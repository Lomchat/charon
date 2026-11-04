export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string };

/** Claude has no native review/start surface. This prompt gives its ordinary
 * turn the same read-only, findings-first product contract as Codex review. */
export function buildClaudeReviewPrompt(target: ReviewTarget): string {
  const scope = target.type === 'uncommittedChanges'
    ? 'Review all uncommitted changes in the current working tree.'
    : target.type === 'baseBranch'
      ? `Review the changes in the current branch relative to the base branch ${JSON.stringify(target.branch)}.`
      : target.type === 'commit'
        ? `Review commit ${JSON.stringify(target.sha)}.`
        : `Review this code according to the user's instructions:\n${target.instructions}`;
  return [
    'Perform a read-only code review. Do not edit files, commit, or push.',
    scope,
    '',
    'Report concrete findings only, ordered by severity. For every finding, include the file and line/range, explain the impact, and propose a concise fix. Check correctness, regressions, security, data loss, concurrency, and missing tests. If you find nothing, say so explicitly and mention any residual testing gaps.',
  ].join('\n');
}
