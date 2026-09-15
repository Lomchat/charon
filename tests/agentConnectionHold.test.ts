import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/server/claude/settings', () => ({ getSetting: () => '' }));
vi.mock('@/lib/server/agent/sshShared.js', () => ({ buildAgentSshArgs: () => [] }));
vi.mock('@/lib/db', () => ({ db: {}, vps: {} }));
import { getAgentClient, dropAgentClient, holdAgentConnection } from '@/lib/server/agent/AgentClientPool';

const vps = { id: 'held-vps', name: 'test' } as any;
beforeEach(() => {
  vi.useFakeTimers(); mock.spawn.mockClear();
  mock.spawn.mockImplementation(() => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: vi.fn(), end: vi.fn() }, kill: vi.fn(),
  }));
});
afterEach(async () => { await dropAgentClient(vps.id); vi.clearAllTimers(); vi.useRealTimers(); });

describe('agent transport during update', () => {
  it('parks a client recreated by a poll until the update releases it', async () => {
    getAgentClient(vps);
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    const release = holdAgentConnection(vps.id);
    await dropAgentClient(vps.id);
    const replacement = getAgentClient(vps);
    const ready = replacement.ready().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    // The old daemon may still be alive during pip -U. No hello may reach it.
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.spawn).toHaveBeenCalledTimes(2);
    await dropAgentClient(vps.id); await ready;
  });

  it('does not connect a parked client deleted before release', async () => {
    const release = holdAgentConnection(vps.id);
    const client = getAgentClient(vps);
    const ready = client.ready();
    const rejected = expect(ready).rejects.toThrow('client closed');
    await dropAgentClient(vps.id); await rejected;
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(mock.spawn).not.toHaveBeenCalled();
  });
});
