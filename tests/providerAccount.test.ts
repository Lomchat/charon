import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), load: vi.fn(), claude: vi.fn(), call: vi.fn(),
  set: vi.fn(), run: vi.fn(), emit: vi.fn(), cursorIdentity: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/hub/sshExec', () => ({ sshExec: vi.fn(), shQuote: (s: string) => s }));
vi.mock('@/lib/server/session', () => ({ requireApiSession: mocks.auth }));
vi.mock('@/lib/db', () => ({
  vps: { id: 'id' },
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: mocks.load }) }) }),
    update: () => ({ set: mocks.set }),
  },
}));
vi.mock('@/lib/server/agent/claudeLoginCheck', () => ({ refreshClaudeLoginStatus: mocks.claude }));
vi.mock('@/lib/server/agent/AgentClientPool', () => ({ getAgentClient: () => ({ call: mocks.call }) }));
vi.mock('@/lib/server/agent/sessionOps', () => ({ emitGlobalVpsStatus: mocks.emit }));

vi.mock('@/lib/server/agent/accountProfiles', () => ({ requireAccountProfile: (_v: string, _p: string, id = 'default') => ({ id }), readProfileStatus: vi.fn(), acceptCursorIdentity: mocks.cursorIdentity }));
vi.mock('@/lib/server/agent/loginSession', () => ({ stopLoginSession: vi.fn() }));

import { POST } from '@/app/api/vps/[id]/account/route';

const probe = (provider: string) => POST(new Request('http://localhost/account', {
  method: 'POST', body: JSON.stringify({ provider }),
}), { params: Promise.resolve({ id: 'vps-1' }) });

describe('provider account inspection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ userId: 'user' });
    mocks.load.mockReturnValue({ id: 'vps-1', agentStatus: 'ok' });
    mocks.set.mockReturnValue({ where: () => ({ run: mocks.run }) });
  });

  it('requires authentication before probing', async () => {
    mocks.auth.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await probe('codex')).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('rejects unknown providers and missing VPSes', async () => {
    expect((await probe('unknown')).status).toBe(400);
    mocks.load.mockReturnValue(undefined);
    expect((await probe('cursor')).status).toBe(404);
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('exposes only public subscription identity', async () => {
    mocks.claude.mockResolvedValue({ ok: true, loggedIn: true, account: {
      email: 'alice@example.com', orgName: 'Team', subscriptionType: 'max',
      authMethod: 'claude.ai', accessToken: 'private',
    } });
    const data = await (await probe('claude')).json();
    expect(data).toMatchObject({ loggedIn: true, email: 'alice@example.com', organization: 'Team', subscriptionType: 'max' });
    expect(JSON.stringify(data)).not.toContain('private');
  });

  it('names the account by its official display name from the last probe of the SAME login', async () => {
    const { profileStatuses, statusKey } = await import('@/lib/server/agent/accountProfileState');
    const key = statusKey('vps-1', 'claude');
    profileStatuses.set(key, { ok: true, provider: 'claude', account_profile: 'default', logged_in: true,
      email: 'Alice@example.com', display_name: 'Alice' });
    try {
      mocks.claude.mockResolvedValue({ ok: true, loggedIn: true, account: { email: 'alice@example.com' } });
      expect(await (await probe('claude')).json()).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
      mocks.claude.mockResolvedValue({ ok: true, loggedIn: true, account: { email: 'bob@example.com' } });
      expect(await (await probe('claude')).json()).not.toHaveProperty('name');
    } finally {
      profileStatuses.delete(key);
    }
  });

  it('returns credential expiry without exporting raw SDK data', async () => {
    mocks.call.mockResolvedValue({ ok: true, logged_in: true, email: 'alice@example.com',
      expires_at_ms: 1800000000000, apiKey: 'private', usage: { five_hour: 42 } });
    const data = await (await probe('cursor')).json();
    expect(data).toMatchObject({ email: 'alice@example.com', expiresAtMs: 1800000000000 });
    expect(data).not.toHaveProperty('apiKey');
    expect(data).not.toHaveProperty('usage');
    expect(mocks.call).toHaveBeenCalledWith('cursor_auth_status', {});
    // The header learns the Cursor login's public email (no key, no usage).
    expect(mocks.cursorIdentity).toHaveBeenCalledWith('vps-1', true, 'alice@example.com');
  });

  it('persists and broadcasts a confirmed logout while discarding old identity', async () => {
    mocks.call.mockResolvedValue({ ok: true, logged_in: false, email: 'previous@example.com' });
    const data = await (await probe('codex')).json();
    expect(data.loggedIn).toBe(false);
    expect(data).not.toHaveProperty('email');
    expect(mocks.set).toHaveBeenCalledWith({ codexLoggedIn: 0, codexLoggedInCheckedAt: expect.any(Number) });
    expect(mocks.emit).toHaveBeenCalledOnce();
  });

  it.each([
    { ok: false }, { ok: true },
  ])('preserves known login state on an unsuccessful probe: %j', async (result) => {
    mocks.call.mockResolvedValue(result);
    expect((await probe('codex')).status).toBe(502);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('offers an agent update for an unsupported probe', async () => {
    mocks.call.mockRejectedValue({ code: -32601, message: 'private' });
    const response = await probe('codex');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('Update the agent');
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
