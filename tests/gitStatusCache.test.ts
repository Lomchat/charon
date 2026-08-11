import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Hub-side git service (lib/server/claude/git.ts), §14.76 / §14.82.
//
// The module is a thin bridge, so the only logic worth pinning is the part
// that isn't the agent's: how it caches, when it refuses to cache, and how it
// degrades. Each of these was a deliberate decision:
//
//   - keyed on (vpsId, cwd), NEVER on a session — two sessions in one repo
//     must share the poll and agree on the number;
//   - a FAILED poll must not clobber the last good snapshot (the rule the
//     usage gauges had to learn the hard way, §14.72e);
//   - an offline agent is `offline`, not a crash and not a fake "clean tree";
//   - an agent with git but no workspace scan (0.24–0.28) silently falls back
//     to the single-repo call, because the only thing it misses is the
//     folder-of-projects case, which used to show nothing anyway;
//   - `includeRecent` implies force, or the commit-message generator would be
//     handed a cached status with no commit subjects in it and quietly ignore
//     the repo's conventions.

const call = vi.fn();
const clientStatus = { value: 'connected' as string };

vi.mock('@/lib/server/agent/AgentClientPool', () => ({
  getAgentClientForVpsId: () => ({ get status() { return clientStatus.value; }, call }),
}));

const { getGitWorkspace, invalidateGitStatus } = await import('@/lib/server/claude/git');
const { AgentRpcError } = await import('@/lib/server/agent/types');

const CWD = '/srv/charon';
function rawStatus(over: Record<string, unknown> = {}) {
  return {
    ok: true, is_repo: true, root: CWD, branch: 'main', detached: false,
    head: 'abc123', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'],
    files: [], file_count: 0, truncated: false, added: 0, deleted: 0, conflicts: 0,
    rel: '', name: 'charon',
    ...over,
  };
}
const single = (over: Record<string, unknown> = {}) =>
  ({ ok: true, mode: 'single', repos: [rawStatus(over)] });

let n = 0;
/** A fresh key per test — the cache is a module singleton. */
const freshCwd = () => `${CWD}/t${++n}`;

beforeEach(() => {
  call.mockReset();
  clientStatus.value = 'connected';
});

describe('getGitWorkspace — shape', () => {
  it('re-cases the agent payload and nothing more', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(single({
      files: [{ path: 'a.ts', x: '.', y: 'M', status: 'M', untracked: false, added: 3, deleted: 1 }],
      file_count: 1, added: 3, deleted: 1,
    }));
    const r = await getGitWorkspace('v1', cwd);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('single');
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({ isRepo: true, branch: 'main', fileCount: 1 });
    expect(r.repos[0].files[0]).toMatchObject({ path: 'a.ts', status: 'M', added: 3, deleted: 1 });
  });

  it('a plain folder is a SUCCESS with no repos, not an error', async () => {
    // The UI renders nothing at all for a plain folder; if this came back
    // ok:false every non-git session would show an error chip.
    const cwd = freshCwd();
    call.mockResolvedValue({ ok: true, mode: 'none', repos: [] });
    const r = await getGitWorkspace('v1', cwd);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('none');
    expect(r.repos).toEqual([]);
  });

  it('carries every repo of a folder of projects, with its display keys', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue({
      ok: true, mode: 'multi', scanned: 2, truncated: false,
      repos: [
        rawStatus({ root: `${cwd}/alpha`, rel: 'alpha', name: 'alpha', branch: 'main' }),
        rawStatus({ root: `${cwd}/nest/beta`, rel: 'nest/beta', name: 'beta', branch: 'dev' }),
      ],
    });
    const r = await getGitWorkspace('v1', cwd);
    expect(r.mode).toBe('multi');
    expect(r.repos.map((x) => x.name)).toEqual(['alpha', 'beta']);
    expect(r.repos.map((x) => x.rel)).toEqual(['alpha', 'nest/beta']);
    expect(r.repos[1].branch).toBe('dev');
  });
});

describe('getGitWorkspace — caching', () => {
  it('serves a second call from cache within the TTL', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(single());
    await getGitWorkspace('v1', cwd);
    await getGitWorkspace('v1', cwd);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('is keyed on (vpsId, cwd) — a different folder is a different entry', async () => {
    const a = freshCwd();
    const b = freshCwd();
    call.mockResolvedValue(single());
    await getGitWorkspace('v1', a);
    await getGitWorkspace('v1', b);
    await getGitWorkspace('v2', a);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('dedups concurrent callers into one RPC', async () => {
    // The chip and the panel mount together; two sessions on one folder poll
    // on their own clocks. They must cost one scan.
    const cwd = freshCwd();
    let release: (v: unknown) => void = () => {};
    call.mockReturnValue(new Promise((res) => { release = res; }));
    const p1 = getGitWorkspace('v1', cwd);
    const p2 = getGitWorkspace('v1', cwd);
    release(single());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it('force bypasses the TTL AND the agent-side discovery cache', async () => {
    // ↻ is how a freshly cloned project appears, so it must not be served a
    // minute-old list of repo roots either.
    const cwd = freshCwd();
    call.mockResolvedValue(single());
    await getGitWorkspace('v1', cwd);
    await getGitWorkspace('v1', cwd, { force: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][1]).toMatchObject({ refresh: false });
    expect(call.mock.calls[1][1]).toMatchObject({ refresh: true });
  });

  it('invalidateGitStatus drops the entry (what every write calls)', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(single());
    await getGitWorkspace('v1', cwd);
    invalidateGitStatus('v1', cwd);
    await getGitWorkspace('v1', cwd);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('includeRecent forces AND asks the agent for the subjects', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(single());
    await getGitWorkspace('v1', cwd);                           // plain poll, cached
    call.mockResolvedValue(single({ recent_subjects: ['feat: x', 'fix: y'] }));
    const r = await getGitWorkspace('v1', cwd, { includeRecent: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][1]).toMatchObject({ include_recent: false });
    expect(call.mock.calls[1][1]).toMatchObject({ include_recent: true });
    expect(r.repos[0].recentSubjects).toEqual(['feat: x', 'fix: y']);
  });

  it('a failed poll does not clobber the last good snapshot', async () => {
    const cwd = freshCwd();
    call.mockResolvedValue(single({ file_count: 4 }));
    await getGitWorkspace('v1', cwd);

    clientStatus.value = 'reconnecting';
    const failed = await getGitWorkspace('v1', cwd, { force: true });
    expect(failed.ok).toBe(false);          // THIS call still reports the failure
    expect(failed.reason).toBe('offline');

    clientStatus.value = 'connected';
    // …but the cached good snapshot survived, so the chip kept its numbers
    // instead of blanking on one transient reconnect.
    const cached = await getGitWorkspace('v1', cwd);
    expect(cached.ok).toBe(true);
    expect(cached.repos[0].fileCount).toBe(4);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('getGitWorkspace — degradation', () => {
  it('a disconnected agent is offline, not an exception', async () => {
    clientStatus.value = 'reconnecting';
    const r = await getGitWorkspace('v1', freshCwd());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('offline');
    expect(r.repos).toEqual([]);
    expect(call).not.toHaveBeenCalled();     // never waits 30s on a dead client
  });

  it('an agent with git but no scan falls back to the single-repo call', async () => {
    // 0.24–0.28: git works, only the folder-of-projects case is missing.
    // Showing "update your agent" there would be a regression for everyone.
    const cwd = freshCwd();
    call.mockImplementation((method: string) => {
      if (method === 'git_workspace') throw new AgentRpcError(-32601, 'unknown method: git_workspace');
      return Promise.resolve(rawStatus({ root: cwd, file_count: 2 }));
    });
    const r = await getGitWorkspace('v1', cwd);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('single');
    expect(r.repos[0].fileCount).toBe(2);
    expect(call.mock.calls.map((c) => c[0])).toEqual(['git_workspace', 'git_status']);
  });

  it('…and that fallback still reports a plain folder as none', async () => {
    const cwd = freshCwd();
    call.mockImplementation((method: string) => {
      if (method === 'git_workspace') throw new AgentRpcError(-32601, 'nope');
      return Promise.resolve({ ok: true, is_repo: false, root: null, files: [] });
    });
    const r = await getGitWorkspace('v1', cwd);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('none');
  });

  it('an RPC timeout is reported as such', async () => {
    call.mockRejectedValue(new Error('agent chalco: timeout on git_workspace'));
    const r = await getGitWorkspace('v1', freshCwd());
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('timeout');
  });
});
