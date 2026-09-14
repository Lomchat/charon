import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  invalidate: vi.fn(),
  updateRun: vi.fn(),
  emitStatus: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({
  requireApiSession: vi.fn(async () => ({ userId: 'test-user' })),
}));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id' },
  db: {
    select: () => ({ from: () => ({ where: () => ({
      all: () => [{ id: 'cursor-vps', agentStatus: 'ok' }],
    }) }) }),
    update: () => ({ set: () => ({ where: () => ({ run: mocks.updateRun }) }) }),
  },
}));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClient: () => ({ call: mocks.call }),
}));
vi.mock('@/lib/server/agent/sessionOps', () => ({
  emitGlobalVpsStatus: mocks.emitStatus,
}));
vi.mock('@/lib/sessionCapabilities', () => ({
  providerLoginPatch: (_provider: string, value: number) => ({ cursorLoggedIn: value }),
}));
vi.mock('@/lib/server/claude/cursorModels', () => ({
  invalidateCursorModels: mocks.invalidate,
}));

import { GET as pollLogin } from '@/app/api/vps/[id]/cursor/login/route';
import { DELETE as logout } from '@/app/api/vps/[id]/cursor/account/route';

const context = { params: Promise.resolve({ id: 'cursor-vps' }) };

describe('Cursor account routes invalidate the server model catalog', () => {
  beforeEach(() => {
    mocks.call.mockReset();
    mocks.invalidate.mockReset();
    mocks.updateRun.mockReset();
    mocks.emitStatus.mockReset();
  });

  it('invalidates after a completed sign-in, but not while it is pending', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, status: 'pending' });
    await pollLogin(new Request('http://localhost/login?loginId=one'), context);
    expect(mocks.invalidate).not.toHaveBeenCalled();

    mocks.call.mockResolvedValueOnce({ ok: true, status: 'success' });
    await pollLogin(new Request('http://localhost/login?loginId=one'), context);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith('cursor-vps');
  });

  it('invalidates only after the agent confirms sign-out', async () => {
    mocks.call.mockResolvedValueOnce({ ok: false, error: 'still signed in' });
    await logout(new Request('http://localhost/account', { method: 'DELETE' }), context);
    expect(mocks.invalidate).not.toHaveBeenCalled();

    mocks.call.mockResolvedValueOnce({ ok: true });
    await logout(new Request('http://localhost/account', { method: 'DELETE' }), context);
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledWith('cursor-vps');
  });
});
