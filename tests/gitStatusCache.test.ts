import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hub-side git service (lib/server/claude/git.ts), §14.76.
//
// The module is a thin bridge, so the only logic worth pinning is the part
// that isn't the agent's: how it caches, when it refuses to cache, and how it
// degrades. Each of these was a deliberate decision:
//
//   - keyed on (vpsId, cwd), NEVER on a session — two sessions in one repo
//     must share the poll and agree on the number;
//   - a FAILED poll must not clobber the last good snapshot (the rule the
//     usage gauges had to learn the hard way, §14.72e);
//   - an offline or too-old agent is `offline` / `unsupported`, not a crash
//     and not a fake "clean tree" — the UI turns those into a fix;
//   - `includeRecent` implies force, or the commit-message generator would be
//     handed a cached status with no commit subjects in it and quietly ignore
//     the repo's conventions.

const call = vi.fn();
const clientStatus = { value: 'connected' as string };

vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ get status() { return clientStatus.value; }, call }),
}));

const { getGitStatus, invalidateGitStatus } = await import('@/lib/server/claude/git');
const { AgentRpcError } = await import('@/lib/server/agent/types');

const CWD = '/srv/charon';
function rawStatus(over: Record<string, unknown> = {}) {
  return {
    ok: true, is_repo: true, root: CWD, branch: 'main', detached: false,
    head: 'abc123', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'],
    files: [], file_count: 0, truncated: false, added: 0, deleted: 0, conflicts: 0,
    ...over,
  };
}

let n = 0;
/** A fresh repo key per test — the cache is a module singleton. */
const freshCwd = () => `${CWD}/t${++n}`;

beforeEach(() => {
  call.mockReset();
  clientStatus.value = 'connected';
});

describe('getGitStatus — shape', () => {
  it('re-cases the agent payload and nothing more', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(rawStatus({
      files: [{ path: 'a.ts', x: '.', y: 'M', status: 'M', untracked: false, added: 3, deleted: 1 }],
      file_count: 1, added: 3, deleted: 1,
    }));
    const r = await getGitStatus('v1', cwd);
    expect(r.ok).toBe(true);
    expect(r.isRepo).toBe(true);
    expect(r.branch).toBe('main');
    expect(r.fileCount).toBe(1);
    expect(r.files[0]).toMatchObject({ path: 'a.ts', status: 'M', added: 3, deleted: 1 });
  });

  it('a non-repo cwd is a SUCCESS, not an error', async () => {
    // The UI renders nothing at all for a plain folder; if this came back
    // ok:false every non-git session would show an error chip.
    const cwd = freshCwd();
    call.mockResolvedValue({ ok: true, is_repo: false, root: null, files: [] });
    const r = await getGitStatus('v1', cwd);
    expect(r.ok).toBe(true);
    expect(r.isRepo).toBe(false);
  });
});

describe('getGitStatus — caching', () => {
  it('serves a second call from cache within the TTL', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(rawStatus());
    await getGitStatus('v1', cwd);
    await getGitStatus('v1', cwd);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('is keyed on (vpsId, cwd) — a different repo is a different entry', async () => {
    const a = freshCwd();
    const b = freshCwd();
    call.mockResolvedValue(rawStatus());
    await getGitStatus('v1', a);
    await getGitStatus('v1', b);
    await getGitStatus('v2', a);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('dedups concurrent callers into one RPC', async () => {
    // The chip and the panel mount together; two sessions on one repo poll on
    // their own clocks. They must cost one `git status`.
    const cwd = freshCwd();
    let release: (v: unknown) => void = () => {};
    call.mockReturnValue(new Promise((res) => { release = res; }));
    const p1 = getGitStatus('v1', cwd);
    const p2 = getGitStatus('v1', cwd);
    release(rawStatus());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it('force bypasses the TTL', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(rawStatus());
    await getGitStatus('v1', cwd);
    await getGitStatus('v1', cwd, { force: true });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('invalidateGitStatus drops the entry (what every write calls)', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(rawStatus());
    await getGitStatus('v1', cwd);
    invalidateGitStatus('v1', cwd);
    await getGitStatus('v1', cwd);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('includeRecent forces AND asks the agent for the subjects', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(rawStatus());
    await getGitStatus('v1', cwd);                              // plain poll, cached
    call.mockResolvedValue(rawStatus({ recent_subjects: ['feat: x', 'fix: y'] }));
    const r = await getGitStatus('v1', cwd, { includeRecent: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][1]).toMatchObject({ include_recent: false });
    expect(call.mock.calls[1][1]).toMatchObject({ include_recent: true });
    expect(r.recentSubjects).toEqual(['feat: x', 'fix: y']);
  });

  it('a failed poll does not clobber the last good snapshot', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(rawStatus({ file_count: 4 }));
    await getGitStatus('v1', cwd);

    clientStatus.value = 'reconnecting';
    const failed = await getGitStatus('v1', cwd, { force: true });
    expect(failed.ok).toBe(false);          // THIS call still reports the failure
    expect(failed.reason).toBe('offline');

    clientStatus.value = 'connected';
    // …but the cached good snapshot survived, so the chip kept its numbers
    // instead of blanking on one transient reconnect.
    const cached = await getGitStatus('v1', cwd);
    expect(cached.ok).toBe(true);
    expect(cached.fileCount).toBe(4);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('getGitStatus — degradation', () => {
  it('a disconnected agent is offline, not an exception', async () => {
    clientStatus.value = 'reconnecting';
    const r = await getGitStatus('v1', freshCwd());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offline');
    expect(r.files).toEqual([]);
    expect(call).not.toHaveBeenCalled();     // never waits 30s on a dead client
  });

  it('-32601 from an old agent is unsupported (the UI offers the update)', async () => {
    call.mockRejectedValue(new AgentRpcError(-32601, 'unknown method: git_status'));
    const r = await getGitStatus('v1', freshCwd());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsupported');
  });

  it('an RPC timeout is reported as such', async () => {
    call.mockRejectedValue(new Error('agent chalco: timeout on git_status'));
    const r = await getGitStatus('v1', freshCwd());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });
});
