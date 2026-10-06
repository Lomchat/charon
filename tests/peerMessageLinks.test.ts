import { describe, expect, it } from 'vitest';
import { peerRequestTarget, peerSessionTarget } from '@/app/peerMessageLinks';
import type { Msg } from '@/app/sessionTypes';

const message = (extra: Partial<Msg>): Msg => ({
  id: 'm1', role: 'peer_status', content: 'Run tests', createdAt: 1, ...extra,
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
