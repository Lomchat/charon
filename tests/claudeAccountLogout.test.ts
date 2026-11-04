import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), load: vi.fn(), ssh: vi.fn(), status: vi.fn(),
  stopLogin: vi.fn(), set: vi.fn(), run: vi.fn(), emit: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ requireApiSession: mocks.auth }));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id' },
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: mocks.load }) }) }),
    update: () => ({ set: mocks.set }),
  },
}));
vi.mock('@/lib/server/hub/sshExec', () => ({ sshExec: mocks.ssh }));
vi.mock('@/lib/server/agent/claudeLoginCheck', () => ({ readClaudeAuthStatus: mocks.status }));
vi.mock('@/lib/server/agent/loginSession', () => ({ stopLoginSession: mocks.stopLogin }));
vi.mock('@/lib/server/agent/sessionOps', () => ({ emitGlobalVpsStatus: mocks.emit }));

import { DELETE } from '@/app/api/vps/[id]/claude/account/route';

const context = { params: Promise.resolve({ id: 'claude-vps' }) };
const logout = () => DELETE(new Request('http://localhost/account', { method: 'DELETE' }), context);

describe('Claude account logout', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ userId: 'test-user' });
    mocks.load.mockReturnValue({ id: 'claude-vps', agentStatus: 'ok' });
    mocks.ssh.mockResolvedValue({ ok: true });
    mocks.status.mockResolvedValue({ ok: true, loggedIn: false });
    mocks.set.mockReturnValue({ where: () => ({ run: mocks.run }) });
  });

  it('requires authentication before touching the remote account', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await logout()).status).toBe(401);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it('rejects an unknown VPS before touching the remote account', async () => {
    mocks.load.mockReturnValue(undefined);
    expect((await logout()).status).toBe(404);
    expect(mocks.ssh).not.toHaveBeenCalled();
  });

  it('records and broadcasts a confirmed logout after cancelling sign-in', async () => {
    expect(await (await logout()).json()).toEqual({ ok: true });
    expect(mocks.stopLogin).toHaveBeenCalledWith('claude-vps');
    expect(mocks.stopLogin.mock.invocationCallOrder[0]).toBeLessThan(mocks.ssh.mock.invocationCallOrder[0]);
    expect(mocks.ssh).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude-vps' }),
      expect.stringContaining('claude auth logout'), { timeoutMs: 20_000 });
    expect(mocks.set).toHaveBeenCalledWith({ claudeLoggedIn: 0, claudeLoggedInCheckedAt: expect.any(Number) });
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledWith('claude-vps', 'ok', expect.objectContaining({ claudeLoggedIn: 0 }));
  });

  it('keeps the icon state on an SSH failure', async () => {
    mocks.ssh.mockResolvedValue({ ok: false });
    expect((await logout()).status).toBe(502);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, loggedIn: false, error: 'probe unavailable' },
    { ok: true, loggedIn: true },
  ])('keeps the icon state if logout cannot be confirmed: %j', async (status) => {
    mocks.status.mockResolvedValue(status);
    expect((await logout()).status).toBe(502);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
