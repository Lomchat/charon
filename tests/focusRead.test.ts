import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setConnectionFocus: vi.fn(),
  markSessionRead: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({
  requireApiSession: vi.fn(async () => ({ userId: 'test-user' })),
}));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: vi.fn() }));
vi.mock('@/lib/server/agent/eventConnections', () => ({
  setConnectionFocus: mocks.setConnectionFocus,
}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  markSessionRead: mocks.markSessionRead,
}));

import { POST } from '@/app/api/claude/focus/route';

function focusRequest(sessionId: string | null, visible = true) {
  return new Request('http://localhost/api/claude/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conn: 'connection-id',
      sessionId,
      focusSeq: 7,
      visible,
    }),
  });
}

describe('POST /api/claude/focus read acknowledgement', () => {
  beforeEach(() => {
    mocks.setConnectionFocus.mockReset();
    mocks.markSessionRead.mockReset();
  });

  it('persists read even when the focus POST races SSE registration', async () => {
    mocks.setConnectionFocus.mockReturnValue({
      ok: false,
      applied: false,
      focus: null,
      focusSeq: 0,
    });

    const response = await POST(focusRequest('session-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocks.markSessionRead).toHaveBeenCalledOnce();
    expect(mocks.markSessionRead).toHaveBeenCalledWith('session-1');
  });

  it('does not let a stale visible POST clear a newer hidden focus', async () => {
    mocks.setConnectionFocus.mockReturnValue({
      ok: true,
      applied: false,
      focus: 'session-1',
      focusSeq: 8,
    });

    await POST(focusRequest('session-1'));

    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it('does not acknowledge a null focus', async () => {
    mocks.setConnectionFocus.mockReturnValue({
      ok: true,
      applied: true,
      focus: null,
      focusSeq: 7,
    });

    await POST(focusRequest(null));

    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it('does not acknowledge a session in a hidden tab', async () => {
    mocks.setConnectionFocus.mockReturnValue({ ok: true, applied: true, focus: 'session-1', focusSeq: 7 });

    await POST(focusRequest('session-1', false));

    expect(mocks.setConnectionFocus).toHaveBeenCalledWith('connection-id', 'session-1', 7, false);
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });
});
