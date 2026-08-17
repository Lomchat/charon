import { describe, expect, it } from 'vitest';
import { buildClaudeReviewPrompt } from '@/lib/server/claude/reviewPrompt';

describe('Claude review prompt parity', () => {
  it('keeps review read-only and findings-first', () => {
    const prompt = buildClaudeReviewPrompt({ type: 'uncommittedChanges' });
    expect(prompt).toContain('read-only code review');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('ordered by severity');
    expect(prompt).toContain('file and line');
  });

  it('quotes an exact base branch and preserves custom instructions', () => {
    expect(buildClaudeReviewPrompt({ type: 'baseBranch', branch: 'origin/main' }))
      .toContain('"origin/main"');
    expect(buildClaudeReviewPrompt({ type: 'custom', instructions: 'Focus on transaction races.' }))
      .toContain('Focus on transaction races.');
  });
});
