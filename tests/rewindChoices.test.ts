import { describe, expect, it } from 'vitest';
import { buildRewindChoices } from '../app/RewindModal';
import type { Msg } from '../app/sessionTypes';

const msg = (id: string, role: string, content: string, createdAt: number): Msg => ({
  id, role, content, createdAt,
});

describe('rewind conversation choices', () => {
  it('shows turns newest first and translates the selected message to a rollback count', () => {
    const choices = buildRewindChoices([
      msg('u1', 'user', 'first question', 1),
      msg('a1', 'assistant', 'first answer', 2),
      msg('tool', 'tool_use', '{}', 3),
      msg('a2', 'assistant', 'answer after tool', 4),
      msg('u2', 'user', 'second question', 5),
      msg('a3', 'assistant', 'second answer', 6),
    ]);

    expect(choices.map(({ id, turns }) => ({ id, turns }))).toEqual([
      { id: 'u2', turns: 1 },
      { id: 'u1', turns: 2 },
    ]);
    expect(choices[1].assistant).toBe('first answer\nanswer after tool');
  });

  it('keeps only the 100 turns supported by the rollback protocol', () => {
    const messages = Array.from({ length: 105 }, (_, index) =>
      msg(`u${index}`, 'user', `question ${index}`, index));
    const choices = buildRewindChoices(messages);

    expect(choices).toHaveLength(100);
    expect(choices[0]).toMatchObject({ id: 'u104', turns: 1 });
    expect(choices[99]).toMatchObject({ id: 'u5', turns: 100 });
  });
});
