import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { readSessionInsightSnapshot } = await import(
  '@/lib/server/claude/sessionInsightSnapshot'
);

let sequence = 0;
const freshSession = () => `snapshot-test-${++sequence}`;

describe('session insight snapshots', () => {
  it('returns immediately and deduplicates every cold reader', async () => {
    const sessionId = freshSession();
    let release: (value: Record<string, unknown>) => void = () => {};
    const loader = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    }));

    const first = readSessionInsightSnapshot(sessionId, 'context', loader);
    const second = readSessionInsightSnapshot(sessionId, 'context', loader);
    expect(first).toMatchObject({ ok: false, reason: 'loading' });
    expect(second).toMatchObject({ ok: false, reason: 'loading' });

    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    release({ ok: true, total_tokens: 42 });
    await vi.waitFor(() => {
      expect(readSessionInsightSnapshot(sessionId, 'context', loader))
        .toMatchObject({ ok: true, total_tokens: 42, _snapshot: { state: 'fresh' } });
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serializes different low-priority resources for one session', async () => {
    const sessionId = freshSession();
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const firstLoader = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      releaseFirst = () => resolve({ ok: true, value: 'first' });
    }));
    const secondLoader = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      releaseSecond = () => resolve({ ok: true, value: 'second' });
    }));

    readSessionInsightSnapshot(sessionId, 'resources', firstLoader);
    readSessionInsightSnapshot(sessionId, 'mcp', secondLoader);
    await vi.waitFor(() => expect(firstLoader).toHaveBeenCalledTimes(1));
    expect(secondLoader).not.toHaveBeenCalled();

    releaseFirst();
    await vi.waitFor(() => expect(secondLoader).toHaveBeenCalledTimes(1));
    releaseSecond();
    await vi.waitFor(() => {
      expect(readSessionInsightSnapshot(sessionId, 'mcp', secondLoader))
        .toMatchObject({ ok: true, value: 'second' });
    });
  });

  it('keeps the last good value while one forced refresh is in flight', async () => {
    const sessionId = freshSession();
    let refresh: (value: Record<string, unknown>) => void = () => {};
    const loader = vi.fn()
      .mockResolvedValueOnce({ ok: true, servers: [{ name: 'peer' }] })
      .mockImplementationOnce(() => new Promise<Record<string, unknown>>((resolve) => {
        refresh = resolve;
      }));

    readSessionInsightSnapshot(sessionId, 'mcp', loader);
    await vi.waitFor(() => {
      expect(readSessionInsightSnapshot(sessionId, 'mcp', loader).ok).toBe(true);
    });

    const refreshing = readSessionInsightSnapshot(
      sessionId, 'mcp', loader, { force: true },
    );
    const duplicate = readSessionInsightSnapshot(
      sessionId, 'mcp', loader, { force: true },
    );
    expect(refreshing).toMatchObject({
      ok: true,
      servers: [{ name: 'peer' }],
      _snapshot: { state: 'refreshing' },
    });
    expect(duplicate).toMatchObject({ ok: true, _snapshot: { state: 'refreshing' } });
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));

    refresh({ ok: true, servers: [{ name: 'peer' }, { name: 'docs' }] });
    await vi.waitFor(() => {
      expect(readSessionInsightSnapshot(sessionId, 'mcp', loader).servers).toHaveLength(2);
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
