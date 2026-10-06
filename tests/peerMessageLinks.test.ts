import { describe, expect, it } from 'vitest';
import { peerAssistantReplies, peerRequestTarget, peerSessionTarget } from '@/app/peerMessageLinks';
import type { Msg } from '@/app/sessionTypes';

const message = (extra: Partial<Msg>): Msg => ({
  id: 'm1', role: 'peer_status', content: 'Run tests', createdAt: 1, ...extra,
});

describe('assistant answers to peer inputs', () => {
  it('marks both intermediate and final assistant answers to the same incoming request', () => {
    const messages = [
      message({ role: 'external', id: 'input', messageId: 'request' }),
      message({ role: 'thinking', id: 'thinking' }),
      message({ role: 'assistant', id: 'intermediate', assistantFinal: 0 }),
      message({ role: 'tool_use', id: 'tool' }),
      message({ role: 'assistant', id: 'final', assistantFinal: 1 }),
    ];
    const links = peerAssistantReplies(messages);
    expect([...links.replyToById]).toEqual([['intermediate', 'request'], ['final', 'request']]);
    expect(links.streamingReplyTo).toBe('request');
    expect(messages[2].replyTo).toBeUndefined(); // Do not rewrite persisted/history objects.
  });

  it('follows each incoming peer message and resets for a later human prompt', () => {
    const links = peerAssistantReplies([
      message({ role: 'external', id: 'first', messageId: 'request-1' }),
      message({ role: 'assistant', id: 'answer-1' }),
      message({ role: 'external', id: 'second', messageId: 'request-2' }),
      message({ role: 'assistant', id: 'answer-2' }),
      message({ role: 'user', id: 'human' }),
      message({ role: 'assistant', id: 'ordinary' }),
    ]);
    expect([...links.replyToById]).toEqual([['answer-1', 'request-1'], ['answer-2', 'request-2']]);
    expect(links.streamingReplyTo).toBeNull();
  });

  it('uses the received reply itself as the input when the requester answers it', () => {
    const links = peerAssistantReplies([
      message({ role: 'peer_status', messageId: 'original-request', peerStatus: 'replied' }),
      message({ role: 'external', id: 'received', messageId: 'received-reply', replyTo: 'original-request' }),
      message({ role: 'assistant', id: 'acknowledgement' }),
    ]);
    expect(links.replyToById.get('acknowledgement')).toBe('received-reply');
  });

  it('supports legacy input rows and does not misclassify outbound requests or fork continuations', () => {
    const links = peerAssistantReplies([
      message({ role: 'external', id: 'm123' }),
      message({ role: 'assistant', id: 'legacy-answer' }),
      message({ role: 'forkpoint', id: 'fork' }),
      message({ role: 'peer_status', id: 'outbound', messageId: 'sent' }),
      message({ role: 'assistant', id: 'ordinary' }),
    ]);
    expect([...links.replyToById]).toEqual([['legacy-answer', 'm123']]);
    expect(links.streamingReplyTo).toBeNull();
  });

  it('reconstructs the relationship once the page containing the input is loaded', () => {
    const answer = message({ role: 'assistant', id: 'answer' });
    expect(peerAssistantReplies([answer]).replyToById.size).toBe(0);
    const input = message({ role: 'external', id: 'input', messageId: 'request' });
    expect(peerAssistantReplies([input, answer]).replyToById.get('answer')).toBe('request');
  });

  it('keeps a server-supplied historical anchor when its input is outside the loaded window', () => {
    const links = peerAssistantReplies([
      message({ role: 'assistant', id: 'answer', replyTo: 'older-request' }),
      message({ role: 'tool_use', id: 'tool' }),
      message({ role: 'assistant', id: 'continuation' }),
    ]);
    expect([...links.replyToById]).toEqual([['answer', 'older-request'], ['continuation', 'older-request']]);
    expect(links.streamingReplyTo).toBe('older-request');
  });
});

describe('peer transcript links', () => {
  it('uses durable session ids rather than a recycled handle', () => {
    expect(peerSessionTarget(message({ peerTargetSessionId: 'original', peerTarget: 'api' }),
      [{ id: 'replacement', handle: 'api' }])).toBe('original');
    expect(peerSessionTarget(message({ role: 'external', sourceSessionId: 'source', from: 'api' }),
      [{ id: 'replacement', handle: 'api' }])).toBe('source');
  });

  it('resolves older handles only among the supplied same-VPS sessions', () => {
    const siblings = [{ id: 'target', handle: 'api' }];
    expect(peerSessionTarget(message({ peerTarget: 'api' }), siblings)).toBe('target');
    expect(peerSessionTarget(message({ peerTarget: 'missing' }), siblings)).toBeNull();
    expect(peerSessionTarget(message({ role: 'user', peerTarget: 'api' }), siblings)).toBeNull();
  });

  it('correlates replies to their original request rather than to matching text', () => {
    expect(peerRequestTarget(message({ role: 'external', messageId: 'reply', replyTo: 'request' }))).toBe('request');
    expect(peerRequestTarget(message({ peerStatus: 'replied', messageId: 'request' }))).toBe('request');
    expect(peerRequestTarget(message({ peerStatus: 'processing', messageId: 'request' }))).toBeNull();
  });
});
