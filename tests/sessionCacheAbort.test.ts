import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getAgentSession: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getAgentSession: mocks.getAgentSession },
}));

import { fetchAndCache, getCached, invalidate } from '@/app/sessionCache';

// A request that settles only when told to, and rejects when its signal fires
// (what `fetch` does).
function pendingRequest() {
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  mocks.getAgentSession.mockImplementationOnce((_id: string, s: AbortSignal) => {
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
    mocks.getAgentSession.mockReset();
    invalidate('s1');
  });

  it('keys entries by view: a conversation window never answers a full one', async () => {
    mocks.getAgentSession.mockImplementation(async (_id: string, _s: AbortSignal, q: { view?: string }) =>
      ({ session: { id: 's1' }, messages: [], streamingText: '', view: q?.view }));
    await fetchAndCache('s1', { force: true, view: 'conversation' });
    expect(mocks.getAgentSession).toHaveBeenLastCalledWith('s1', expect.anything(), { view: 'conversation' });
    expect(getCached('s1', 'conversation')?.view).toBe('conversation');
    expect(getCached('s1')).toBeUndefined();
    expect(getCached('s1', 'full')).toBeUndefined();
    await fetchAndCache('s1', { force: true });
    expect(getCached('s1', 'full')?.view).toBe('full');
    invalidate('s1');
    expect(getCached('s1', 'conversation')).toBeUndefined();
    expect(getCached('s1', 'full')).toBeUndefined();
  });

  it('a request carrying a focus never joins another one, nor is joined', async () => {
    const plain = pendingRequest();
    const first = fetchAndCache('s1', { force: true });
    const focused = pendingRequest();
    const second = fetchAndCache('s1', { force: true, focus: { conn: 'conn-1234', focusSeq: 3 } });
    expect(mocks.getAgentSession).toHaveBeenCalledTimes(2);
    expect(mocks.getAgentSession).toHaveBeenLastCalledWith('s1', expect.anything(),
      { view: 'full', conn: 'conn-1234', focusSeq: 3 });
    // A later plain request joins the plain one, not the focused one.
    const third = fetchAndCache('s1', { force: true });
    expect(mocks.getAgentSession).toHaveBeenCalledTimes(2);
    plain.resolve(detail('s1'));
    focused.resolve({ ...detail('s1'), streamingText: 'focused' });
    await expect(first).resolves.toMatchObject({ streamingText: 'live' });
    await expect(third).resolves.toMatchObject({ streamingText: 'live' });
    await expect(second).resolves.toMatchObject({ streamingText: 'focused' });
  });

  it('stores entries with their `sync` stamp and blanks every live buffer', async () => {
    mocks.getAgentSession.mockResolvedValueOnce({
      session: { id: 's1' }, messages: [], streamingText: 'half', streamingThinking: 'th',
      streamingToolOutput: [{ toolUseId: 't1', text: 'out', truncated: false }],
      streamingExtends: { rowId: 4, length: 3 }, sync: { epoch: 5, rev: 9 },
    });
    const fresh = await fetchAndCache('s1', { force: true });
    expect(fresh.streamingToolOutput).toHaveLength(1);
    const stored = getCached('s1')!;
    expect(stored.sync).toEqual({ epoch: 5, rev: 9 });
    expect(stored).toMatchObject({ streamingText: '', streamingThinking: '', streamingToolOutput: [], streamingExtends: null });
  });

  it('never replaces a stored entry with an older answer', async () => {
    mocks.getAgentSession.mockResolvedValueOnce({ ...detail('s1'), sync: { epoch: 5, rev: 20 }, messages: [{ id: 2 }] });
    await fetchAndCache('s1', { force: true });
    mocks.getAgentSession.mockResolvedValueOnce({ ...detail('s1'), sync: { epoch: 5, rev: 10 }, messages: [{ id: 1 }] });
    const older = await fetchAndCache('s1', { force: true, focus: { conn: 'conn-1234', focusSeq: 1 } });
    expect(older.sync).toEqual({ epoch: 5, rev: 10 });
    expect(getCached('s1')?.sync).toEqual({ epoch: 5, rev: 20 });
  });

  it('cancels the request once its last holder leaves', async () => {
    const req = pendingRequest();
    const a = new AbortController();
    const b = new AbortController();
    const first = fetchAndCache('s1', { force: true, signal: a.signal });
    const second = fetchAndCache('s1', { force: true, signal: b.signal });
    expect(mocks.getAgentSession).toHaveBeenCalledTimes(1);

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
    const first = fetchAndCache('s1', { force: true, signal: a.signal });
    const pinned = fetchAndCache('s1', { force: true });
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
    const first = fetchAndCache('s1', { force: true, signal: a.signal });
    a.abort();
    const next = pendingRequest();
    const second = fetchAndCache('s1', { force: true, signal: new AbortController().signal });
    expect(mocks.getAgentSession).toHaveBeenCalledTimes(2);
    expect(old.signal().aborted).toBe(true);
    next.resolve(detail('s1'));
    await expect(second).resolves.toMatchObject({ session: { id: 's1' } });
    await expect(first).rejects.toThrow();
  });

  it('detaches from a long-lived signal once the request settles', async () => {
    const req = pendingRequest();
    const view = new AbortController();
    const removed = vi.spyOn(view.signal, 'removeEventListener');
    const pending = fetchAndCache('s1', { force: true, signal: view.signal });
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
    await expect(fetchAndCache('s1', { force: true, signal: a.signal })).rejects.toThrow();
    expect(mocks.getAgentSession).not.toHaveBeenCalled();
  });
});
