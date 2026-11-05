import { describe, expect, it, vi } from 'vitest';
import type { Vps } from '@/lib/db/schema';

vi.mock('server-only', () => ({}));

// What the hub can do about a broken agent (CLAUDE.md §14.60): a failure that
// happened AFTER SSH reached the box can be repaired by redeploying the agent
// (agent/refresh phase 3); an SSH-level one cannot. A changed host key is its
// own verdict — never folded into "key refused", never auto-accepted.

const CHANGED_KEY = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'Host key for 185.185.49.8 has changed and you have requested strict checking.',
  'Host key verification failed.',
].join('\n');

describe('classifyAgentFailure', () => {
  it('a changed host key is ssh-hostkey, a refused key stays ssh-auth', async () => {
    const { classifyAgentFailure } = await import('@/lib/server/agent/AgentClient');
    expect(classifyAgentFailure(255, CHANGED_KEY, null).code).toBe('ssh-hostkey');
    expect(classifyAgentFailure(255, 'Host key verification failed.', null).code).toBe('ssh-hostkey');
    expect(classifyAgentFailure(255, 'root@1.2.3.4: Permission denied (publickey).', null).code).toBe('ssh-auth');
    expect(classifyAgentFailure(255, 'ssh: connect to host 1.2.3.4 port 22: Connection timed out', null).code).toBe('ssh-unreachable');
    expect(classifyAgentFailure(2, 'charon-agent: socket /root/.charon/agent.sock not found (daemon not started?)', null).code).toBe('daemon-down');
  });
});

describe('failureReachedVps', () => {
  it('true only when the remote command ran (the agent itself is broken)', async () => {
    const { failureReachedVps } = await import('@/lib/server/agent/AgentClient');
    expect(failureReachedVps('error', 'daemon-down: charon-agent: socket … not found')).toBe(true);
    expect(failureReachedVps('error', "error: SyntaxError: Non-UTF-8 code starting with '\\x84'")).toBe(true);
    for (const code of ['ssh-auth', 'ssh-hostkey', 'ssh-unreachable']) {
      expect(failureReachedVps('error', `${code}: whatever`)).toBe(false);
    }
    expect(failureReachedVps('missing', null)).toBe(false);
    expect(failureReachedVps('ok', null)).toBe(false);
    expect(failureReachedVps('error', null)).toBe(false);
  });
});

describe('health chips for a changed host key', () => {
  const vps = (over: Partial<Vps>): Vps => ({
    id: 'v1', name: 'box', ip: '10.0.0.1', sshUser: 'root', sshPort: 22,
    agentStatus: 'ok', agentLastError: null, agentVersion: '9.9.9', agentPyzSha: 'abc', agentLastSeenAt: null,
    ...over,
  } as unknown as Vps);

  it('names it, explains the check, offers no reinstall', async () => {
    const { diagnoseVps, agentAvailability } = await import('@/app/vpsHealth');
    const h = diagnoseVps(vps({ agentStatus: 'error', agentLastError: 'ssh-hostkey: Host key verification failed.' } as Partial<Vps>));
    const ssh = h.axes.find((a) => a.key === 'ssh')!;
    expect(ssh.label).toBe('host key ✗');
    expect(ssh.detail).toMatch(/DIFFERENT SSH host key/);
    expect(ssh.detail).toMatch(/charon_known_hosts/);
    expect(h.axes.find((a) => a.key === 'agent')!.label).toBe('agent ?');
    expect(h.fixes.some((f) => f.action === 'install')).toBe(false);
    expect(agentAvailability(vps({ agentStatus: 'error', agentLastError: 'ssh-hostkey: x' } as Partial<Vps>)).reason).toBe('SSH host key changed');
  });

  it('a stopped agent says its start may redeploy', async () => {
    const { diagnoseVps } = await import('@/app/vpsHealth');
    const h = diagnoseVps(vps({ agentStatus: 'error', agentLastError: 'daemon-down: socket absent' } as Partial<Vps>));
    const fix = h.axes.find((a) => a.key === 'agent')!.fixes![0];
    expect(fix.action).toBe('refresh');
    expect(fix.title).toMatch(/redeploy/);
  });
});
