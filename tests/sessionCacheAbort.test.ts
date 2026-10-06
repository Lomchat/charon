import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getClaudeSession: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getClaudeSession: mocks.getClaudeSession },
}));

import { fetchAndCache, getCached, invalidate } from '@/app/sessionCache';

// A request that settles only when told to, and rejects when its signal fires
// (what `fetch` does).
function pendingRequest() {
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  mocks.getClaudeSession.mockImplementationOnce((_id: string, s: AbortSignal) => {
    signal = s;
    return new Promise((res, rej) => {
      resolve = res;
      s.addEventListener('abort', () => rej(s.reason), { once: true });
    });
  });
  return { resolve: (v: unknown) => resolve(v), signal: () => signal };
}

const detail = (id: string) => ({ session: { id }, messages: [], streamingText: 'live' });

describe('sessionCache in-flight sharing', () => {
  beforeEach(() => {
    mocks.getClaudeSession.mockReset();
    invalidate('s1');
  });

  it('cancels the request once its last holder leaves', async () => {
    const req = pendingRequest();
    const a = new AbortController();
    const b = new AbortController();
    const first = fetchAndCache('s1', true, a.signal);
    const second = fetchAndCache('s1', true, b.signal);
    expect(mocks.getClaudeSession).toHaveBeenCalledTimes(1);

    a.abort();
    expect(req.signal().aborted).toBe(false);
    b.abort();
    expect(req.signal().aborted).toBe(true);
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
  });

  it('never cancels a request a caller without a signal still needs', async () => {
    const req = pendingRequest();
    const a = new AbortController();
    const first = fetchAndCache('s1', true, a.signal);
    const pinned = fetchAndCache('s1', true);
    a.abort();
    expect(req.signal().aborted).toBe(false);
    req.resolve(detail('s1'));
    await expect(pinned).resolves.toMatchObject({ streamingText: 'live' });
    await expect(first).resolves.toBeTruthy();
    // Live preview text is not history: the cached copy drops it.
    expect(getCached('s1')?.streamingText).toBe('');
  });

  it('starts a fresh request when a remount follows a cancelled one', async () => {
    const old = pendingRequest();
    const a = new AbortController();
    const first = fetchAndCache('s1', true, a.signal);
    a.abort();
    const next = pendingRequest();
    const second = fetchAndCache('s1', true, new AbortController().signal);
    expect(mocks.getClaudeSession).toHaveBeenCalledTimes(2);
    expect(old.signal().aborted).toBe(true);
    next.resolve(detail('s1'));
    await expect(second).resolves.toMatchObject({ session: { id: 's1' } });
    await expect(first).rejects.toThrow();
  });

  it('detaches from a long-lived signal once the request settles', async () => {
    const req = pendingRequest();
    const view = new AbortController();
    const removed = vi.spyOn(view.signal, 'removeEventListener');
    const pending = fetchAndCache('s1', true, view.signal);
    req.resolve(detail('s1'));
    await pending;
    await Promise.resolve();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    // A later unmount no longer touches the finished request.
    view.abort();
    expect(req.signal().aborted).toBe(false);
  });

  it('refuses a caller that has already gone', async () => {
    const a = new AbortController();
    a.abort();
    await expect(fetchAndCache('s1', true, a.signal)).rejects.toThrow();
    expect(mocks.getClaudeSession).not.toHaveBeenCalled();
  });
});
