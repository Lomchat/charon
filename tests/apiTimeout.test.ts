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

    const pending = api.sendSessionInput('session-1', 'hello');
    const rejected = expect(pending).rejects.toThrow(
      'Sending the message timed out after 90s. It may already have been accepted; the transcript will reconcile automatically.',
    );
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('the bound covers a stalled BODY read too (the window GET settles instead of wedging its flight)', async () => {
    vi.useFakeTimers();
    let bodySignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      bodySignal = init?.signal ?? undefined;
      return {
        ok: true, status: 200,
        // Headers arrived; the body never completes until the request aborts.
        json: () => new Promise((_r, reject) => {
          bodySignal?.addEventListener('abort', () => reject(bodySignal!.reason), { once: true });
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = api.getAgentSession('session-1');
    const rejected = expect(pending).rejects.toThrow(/timed out after 60s/);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(bodySignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('a caller abort during the body read rejects with the caller reason', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_p: string, init?: RequestInit) => ({
      ok: true, status: 200,
      json: () => new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
    }) as unknown as Response));
    const pending = api.getAgentSession('session-1', ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort(new DOMException('window superseded', 'AbortError'));
    await expect(pending).rejects.toThrow('window superseded');
  });
});
