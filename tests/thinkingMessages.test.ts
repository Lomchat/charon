import { describe, expect, it } from 'vitest';
import { appendThinkingMessage, closeThinkingMessage, prependMessagePage } from '@/app/thinkingMessages';
import { rebuildStateFromMessages, type PersistedMessage } from '@/app/sessionRebuild';
import type { Msg } from '@/app/sessionTypes';

const fragment = (content: string, id: number): Msg => ({
  id: `m${id}`, role: 'thinking', content, createdAt: id, thinkingDelta: true,
});
const event = (text: string, id: number): PersistedMessage => ({
  id, role: 'event', content: JSON.stringify({ type: 'thinking', text }), createdAt: id,
});

describe('streamed thinking bubbles', () => {
  it('appends exact tokens to one stable bubble without mutating previous state', () => {
    const parts = ['CODEX_VERSION', ' shows', ' ', '0', '.', '154', '.', '0', '\n', 'é 🧠'];
    let messages: Msg[] = [];
    for (const [index, text] of parts.entries()) {
      const snapshot = structuredClone(messages);
      const next = appendThinkingMessage(messages, fragment(text, index + 1));
      expect(messages).toEqual(snapshot);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ id: 'm1', createdAt: 1, content: parts.slice(0, index + 1).join('') });
      messages = next;
    }
    expect(appendThinkingMessage(messages, fragment('', 99))).toBe(messages);
  });

  it.each(['user', 'assistant', 'tool_use', 'tool_result', 'error', 'compaction', 'external', 'plan'])(
    'starts a new bubble after %s', (role) => {
      const middle = { id: 'boundary', role, content: 'boundary', createdAt: 2 };
      const messages = appendThinkingMessage([fragment('before', 1), middle], fragment('after', 3));
      expect(messages.map((m) => m.content)).toEqual(['before', 'boundary', 'after']);
    },
  );

  it('keeps complete SDK/imported blocks separate from streamed fragments', () => {
    const complete = { id: 'complete', role: 'thinking', content: 'Full thought.', createdAt: 1 };
    expect(appendThinkingMessage([complete], { ...complete, id: 'next' })).toHaveLength(2);
    expect(appendThinkingMessage([complete], fragment('delta', 2))).toHaveLength(2);
    expect(appendThinkingMessage([fragment('delta', 2)], complete)).toHaveLength(2);
  });

  it('closes a block on stop so a later turn cannot continue it', () => {
    const messages = [fragment('before', 1)];
    const closed = closeThinkingMessage(messages);
    expect(messages[0].thinkingClosed).toBeUndefined();
    expect(closeThinkingMessage(closed)).toBe(closed);
    expect(appendThinkingMessage(closed, fragment('after', 2))).toHaveLength(2);
  });

  it.each(['codex', 'cursor'] as const)('rebuilds old fragmented %s history exactly like live delivery', (provider) => {
    const parts = ['0', '.', '154', '.', '0', '\nNext ', 'thought'];
    const rows = parts.map((text, index) => event(text, index + 1));
    const live = parts.reduce((messages, text, index) =>
      appendThinkingMessage(messages, fragment(text, index + 1)), [] as Msg[]);
    const rebuilt = rebuildStateFromMessages(rows, 'thinking', provider).messages;
    expect(rebuilt).toEqual(live);
    expect(rebuilt).toHaveLength(1);
    expect(rebuildStateFromMessages(rows, 'thinking', provider).messages).toEqual(rebuilt);
  });

  it('preserves Claude block boundaries and imported reasoning rows', () => {
    const rows = [event('First thought.', 1), event('Second thought.', 2)];
    expect(rebuildStateFromMessages(rows, 'active', 'claude').messages).toHaveLength(2);
    const imported = rows.map((row) => ({ ...row, role: 'thinking', content: 'Complete thought.' }));
    expect(rebuildStateFromMessages(imported, 'active', 'codex').messages).toHaveLength(2);
  });

  it('ignores control-plane updates but respects the durable end of a turn', () => {
    const rows = [
      event('a', 1),
      { id: 2, role: 'event', content: JSON.stringify({ type: 'tool_activity' }), createdAt: 2 },
      event('b', 3),
      { id: 4, role: 'event', content: JSON.stringify({ type: 'turn_usage' }), createdAt: 4 },
      event('c', 5),
    ];
    const messages = rebuildStateFromMessages(rows, 'active', 'codex').messages;
    expect(messages.map((m) => m.content)).toEqual(['ab', 'c']);
  });

  it('rejoins a streamed block split between older and current history pages', () => {
    const rows = [event('first ', 1), event('second ', 2), event('third', 3)];
    const older = rebuildStateFromMessages(rows.slice(0, 2), 'active', 'codex').messages;
    const current = rebuildStateFromMessages(rows.slice(2), 'active', 'codex').messages;
    expect(prependMessagePage(older, current))
      .toEqual(rebuildStateFromMessages(rows, 'active', 'codex').messages);
    expect(older[0].content).toBe('first second ');
    expect(current[0].content).toBe('third');
    expect(prependMessagePage(closeThinkingMessage(older), current)).toHaveLength(2);
  });
});
