import { describe, expect, it } from 'vitest';
import { buildRewindChoices } from '../app/RewindModal';
import type { Msg } from '../app/sessionTypes';

const msg = (id: string, role: string, content: string, createdAt: number): Msg => ({
  id, role, content, createdAt,
});

describe('rewind conversation choices', () => {
  it('shows visible user messages newest first with stable row anchors', () => {
    const choices = buildRewindChoices([
      msg('m1', 'user', 'first question', 1),
      msg('a1', 'assistant', 'first answer', 2),
      msg('tool', 'tool_use', '{}', 3),
      msg('a2', 'assistant', 'answer after tool', 4),
      msg('m5', 'user', 'second question', 5),
      msg('a3', 'assistant', 'second answer', 6),
    ]);

    expect(choices.map(({ id }) => id)).toEqual(['m5', 'm1']);
    expect(choices[1].assistant).toBe('first answer\nanswer after tool');
  });

  it('keeps only the 100 turns supported by the rollback protocol', () => {
    const messages = Array.from({ length: 105 }, (_, index) =>
      msg(`m${index + 1}`, 'user', `question ${index}`, index));
    const choices = buildRewindChoices(messages);

    expect(choices).toHaveLength(100);
    expect(choices[0]).toMatchObject({ id: 'm105' });
    expect(choices[99]).toMatchObject({ id: 'm6' });
  });
});
