import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setConnectionFocus: vi.fn(),
  noteConnectionAttention: vi.fn(),
  markSessionRead: vi.fn(),
  markShellRead: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({
  requireApiSession: vi.fn(async () => ({ userId: 'test-user' })),
}));
vi.mock('@/lib/server/seed', () => ({ seedInitialData: vi.fn() }));
vi.mock('@/lib/server/agent/eventConnections', () => ({
  setConnectionFocus: mocks.setConnectionFocus,
  noteConnectionAttention: mocks.noteConnectionAttention,
}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  markSessionRead: mocks.markSessionRead,
}));
vi.mock('@/lib/server/agent/shellNotify', () => ({
  markShellRead: mocks.markShellRead,
}));

import { POST } from '@/app/api/focus/route';

function focusRequest(sessionId: string | null, visible = true, extra: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conn: 'connection-id',
      sessionId,
      focusSeq: 7,
      visible,
      ...extra,
    }),
  });
}

function attentionRequest(body: Record<string, unknown> = {}) {
  return new Request('http://localhost/api/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conn: 'connection-id', kind: 'attention', ...body }),
  });
}

describe('POST /api/focus read acknowledgement', () => {
  beforeEach(() => {
    mocks.setConnectionFocus.mockReset();
    mocks.noteConnectionAttention.mockReset();
    mocks.markSessionRead.mockReset();
    mocks.markShellRead.mockReset();
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

    expect(mocks.setConnectionFocus).toHaveBeenCalledWith('connection-id', 'session-1', 7, false, { attentive: undefined });
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  // Viewed = ATTENDED (§14.47): an idle device's visible focus is not a read.
  it('does not acknowledge a visible focus from an idle device (attentive:false)', async () => {
    mocks.setConnectionFocus.mockReturnValue({ ok: true, applied: true, focus: 'session-1', focusSeq: 7 });

    await POST(focusRequest('session-1', true, { attentive: false }));

    expect(mocks.setConnectionFocus).toHaveBeenCalledWith('connection-id', 'session-1', 7, true, { attentive: false });
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it('does not acknowledge an idle device even when the POST races SSE registration', async () => {
    mocks.setConnectionFocus.mockReturnValue({ ok: false, applied: false, focus: null, focusSeq: 0 });

    await POST(focusRequest('session-1', true, { attentive: false }));

    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it('acknowledges a visible, attentive, current focus', async () => {
    mocks.setConnectionFocus.mockReturnValue({ ok: true, applied: true, focus: 'session-1', focusSeq: 7 });

    await POST(focusRequest('session-1', true, { attentive: true }));

    expect(mocks.setConnectionFocus).toHaveBeenCalledWith('connection-id', 'session-1', 7, true, { attentive: true });
    expect(mocks.markSessionRead).toHaveBeenCalledWith('session-1');
  });

  it('ignores a non-boolean attentive (treated as not reported)', async () => {
    mocks.setConnectionFocus.mockReturnValue({ ok: true, applied: true, focus: 'session-1', focusSeq: 7 });

    await POST(focusRequest('session-1', true, { attentive: 'no' }));

    expect(mocks.setConnectionFocus).toHaveBeenCalledWith('connection-id', 'session-1', 7, true, { attentive: undefined });
    expect(mocks.markSessionRead).toHaveBeenCalledWith('session-1');
  });
});

describe('POST /api/focus on a shell (§14.47 twin)', () => {
  beforeEach(() => {
    mocks.setConnectionFocus.mockReset();
    mocks.noteConnectionAttention.mockReset();
    mocks.markSessionRead.mockReset();
    mocks.markShellRead.mockReset();
  });

  it('an attended focus or attention proof acknowledges its finish; an idle one does not', async () => {
    const shell = '0123456789abcdef';
    mocks.setConnectionFocus.mockReturnValue({ ok: true, applied: true, focus: shell, focusSeq: 7 });
    await POST(focusRequest(shell, true, { attentive: true }));
    expect(mocks.markShellRead).toHaveBeenCalledWith(shell);

    mocks.markShellRead.mockReset();
    await POST(focusRequest(shell, true, { attentive: false }));
    expect(mocks.markShellRead).not.toHaveBeenCalled();

    mocks.noteConnectionAttention.mockReturnValue({ ok: true, focus: shell, visible: true });
    await POST(attentionRequest());
    expect(mocks.markShellRead).toHaveBeenCalledWith(shell);
  });
});

describe('POST /api/focus kind:attention', () => {
  beforeEach(() => {
    mocks.setConnectionFocus.mockReset();
    mocks.noteConnectionAttention.mockReset();
    mocks.markSessionRead.mockReset();
    mocks.markShellRead.mockReset();
  });

  it('revives attention and reads the visible focused session, without touching focus', async () => {
    mocks.noteConnectionAttention.mockReturnValue({ ok: true, focus: 'session-1', visible: true });

    const response = await POST(attentionRequest());

    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.noteConnectionAttention).toHaveBeenCalledWith('connection-id');
    expect(mocks.setConnectionFocus).not.toHaveBeenCalled();
    expect(mocks.markSessionRead).toHaveBeenCalledWith('session-1');
  });

  it('needs no focusSeq/sessionId', async () => {
    mocks.noteConnectionAttention.mockReturnValue({ ok: true, focus: null, visible: true });

    const response = await POST(attentionRequest({ focusSeq: 'not-a-number' }));

    expect(response.status).toBe(200);
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it('reads nothing on a hidden conn or an unknown conn', async () => {
    mocks.noteConnectionAttention.mockReturnValue({ ok: true, focus: 'session-1', visible: false });
    await POST(attentionRequest());
    mocks.noteConnectionAttention.mockReturnValue({ ok: false, focus: null, visible: false });
    const response = await POST(attentionRequest());

    expect(await response.json()).toEqual({ ok: false });
    expect(mocks.markSessionRead).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    const response = await POST(attentionRequest({ kind: 'presence' }));

    expect(response.status).toBe(400);
    expect(mocks.noteConnectionAttention).not.toHaveBeenCalled();
    expect(mocks.setConnectionFocus).not.toHaveBeenCalled();
  });
});
