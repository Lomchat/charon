import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileStreamingPreview } from '@/app/streamingPreview';

// The `__streaming` bubble: the hub's unflushed assistant text, mirrored in the
// browser from SSE deltas. Two transports, one buffer — the rules that keep it
// from rewinding mid-answer AND from outliving the turn that produced it.

describe('reconcileStreamingPreview', () => {
  it('adopts the server text when it is caught up or ahead', () => {
    expect(reconcileStreamingPreview({
      serverText: 'Hello wor', localText: 'Hello', status: 'thinking',
    })).toBe('Hello wor');
  });

  it('is a no-op when both sides are empty', () => {
    expect(reconcileStreamingPreview({
      serverText: '', localText: '', status: 'sleeping',
    })).toBe('');
  });

  it('never rewinds a live answer the hub has not caught up with', () => {
    // Mid-stream the hub is briefly behind (25ms broadcast coalescing) and the
    // text is not in any row yet: keeping the local buffer is the whole point.
    expect(reconcileStreamingPreview({
      serverText: 'Hel', localText: 'Hello there', status: 'thinking',
      lastAssistant: 'an older answer',
    })).toBe('Hello there');
  });

  it('clears once the buffered text is provably persisted', () => {
    expect(reconcileStreamingPreview({
      serverText: '', localText: 'Hello', status: 'thinking',
      lastAssistant: 'Hello there',
    })).toBe('');
  });

  // The reported bug: reopening a finished session showed its last message
  // with half a sentence from EARLIER in the same turn pinned underneath,
  // rendered as plain text — a reply being generated in a session that had
  // stopped hours before.
  it('drops a preview whose turn is over even when no row matches it', () => {
    expect(reconcileStreamingPreview({
      serverText: '',
      localText: 'Let me look at the fi',      // snapshot taken mid-turn
      status: 'sleeping',
      lastAssistant: 'Done — the config was missing a trailing slash.',
    })).toBe('');
  });

  it('drops it on every settled status, not just sleeping', () => {
    for (const status of ['active', 'sleeping', 'error', 'failed', 'background']) {
      expect(reconcileStreamingPreview({
        serverText: '', localText: 'half a sentence', status,
      })).toBe('');
    }
  });

  it('keeps it while a turn may still be producing text', () => {
    // An empty server buffer mid-turn is a race (the hub just flushed at a
    // boundary the SSE has not delivered yet), NOT an answer. Truncating here
    // would eat the head of a live message.
    for (const status of ['thinking', 'starting', 'reconnecting']) {
      expect(reconcileStreamingPreview({
        serverText: '', localText: 'half a sentence', status,
      })).toBe('half a sentence');
    }
  });

  it('keeps it when the status is unknown', () => {
    for (const status of [null, undefined, '']) {
      expect(reconcileStreamingPreview({
        serverText: '', localText: 'half a sentence', status,
      })).toBe('half a sentence');
    }
  });
});

// The other half of the fix: a cached response is HISTORY. Storing the live
// preview with it is what replayed a dead turn's text into a fresh mount.
describe('sessionCache', () => {
  const getClaudeSession = vi.fn();
  beforeEach(() => { vi.resetModules(); getClaudeSession.mockReset(); });

  async function load() {
    vi.doMock('@/lib/api', () => ({ api: { getClaudeSession } }));
    return import('@/app/sessionCache');
  }

  const response = (streamingText: string) => ({
    session: { id: 's1' }, messages: [{ id: 1, role: 'assistant', content: 'done' }],
    streamingText,
  });

  it('returns the live preview to the caller but never stores it', async () => {
    const { fetchAndCache, getCached } = await load();
    getClaudeSession.mockResolvedValue(response('half a sent'));

    const fresh = await fetchAndCache('s1', true);
    // The caller opening a session that IS streaming still gets its preview…
    expect(fresh.streamingText).toBe('half a sent');
    // …but the next mount reads history, not a stale turn.
    expect(getCached('s1')?.streamingText).toBe('');
    expect(getCached('s1')?.messages).toHaveLength(1);
  });

  it('leaves a response without a preview untouched', async () => {
    const { fetchAndCache, getCached } = await load();
    getClaudeSession.mockResolvedValue(response(''));
    const fresh = await fetchAndCache('s1', true);
    expect(getCached('s1')).toBe(fresh);
  });
});
