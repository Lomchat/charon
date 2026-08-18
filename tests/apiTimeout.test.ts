import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('HTTP request timeouts', () => {
  it('gives chat input a long bound and never exposes the browser abort text', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.sendClaudeInput('session-1', 'hello');
    const rejected = expect(pending).rejects.toThrow(
      'Sending the message timed out after 90s. It may already have been accepted; the transcript will reconcile automatically.',
    );
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });
});
