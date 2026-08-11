/**
 * Hub side of the source-control panel — a thin, cached bridge to the agent's
 * `git_*` RPCs (agent >= 0.24.0, agent/charon_agent/git.py). cf. CLAUDE.md §14.76.
 *
 * Three jobs, and deliberately nothing else (the payload shapes are the
 * agent's, only re-cased):
 *
 *  1. **Degrade legibly.** There is NO ssh fallback: re-implementing the
 *     porcelain-v2 parser hub-side would be the real cost of this feature and
 *     the two copies would drift. So a VPS whose agent is offline or older
 *     than 0.24.0 gets `reason: 'offline' | 'unsupported'` and the UI says so
 *     (with the existing update button) instead of showing a wrong count.
 *     `client.status` is checked BEFORE calling: `AgentClient.call` waits up
 *     to 30s for a connection, and the dirty chip must never hang a render.
 *
 *  2. **Collapse the polling.** The chip next to the cwd and the git tab are
 *     two views of one thing, and several sessions (and browser tabs, and
 *     devices) can sit on the SAME `(vpsId, cwd)`. Keyed on that pair — never
 *     on the session — with a short TTL plus in-flight dedup, so N watchers
 *     cost one `git status`.
 *
 *  3. **Keep writes honest.** Every write invalidates the cache for its repo,
 *     so the chip drops the instant a commit lands rather than a poll later.
 */
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import type {
  GitCommitResponse, GitDiffResponse, GitFailureReason, GitFileEntry,
  GitOpResponse, GitStatusResponse, GitWorkspaceResponse,
  GitBranch, GitBranchesResponse, GitCheckoutBody, GitCheckoutResponse,
  GitCommit, GitLogResponse, GitShowResponse,
} from '@/lib/types/api';

// Long enough to merge the near-simultaneous polls of several tabs/sessions
// watching one repo, short enough that a commit made in another tab shows up
// on the next tick. Writes invalidate explicitly, so this never masks one.
const STATUS_TTL_MS = 5_000;
const CACHE_MAX_AGE_MS = 10 * 60_000;

// The agent's RPC socket is opened with no `limit=`, so asyncio caps ONE
// inbound line at 64 KiB (CLAUDE.md §14.73). A selection of a few thousand
// long paths would silently blow past that, so we refuse early with something
// actionable rather than letting the request vanish into a timeout.
const MAX_REQUEST_BYTES = 48_000;

type Entry = { at: number; value?: GitWorkspaceResponse; inflight?: Promise<GitWorkspaceResponse> };
const g = globalThis as unknown as { __charonGitStatusCache?: Map<string, Entry> };
const cache = (g.__charonGitStatusCache ??= new Map<string, Entry>());

/**
 * A write targets ONE repo, which may be a subfolder of the session's cwd.
 * `repo` wins as the git target; `cwd` remains the cache key, so a commit in
 * one project still refreshes the workspace the panel is showing.
 *
 * Containment is checked here and not only agent-side: `repo` arrives from a
 * query string, and "the repo you are committing to" is not something a
 * client should be able to point anywhere on the VPS.
 */
function gitTarget(cwd: string, repo?: string | null): string {
  const r = (repo ?? '').trim();
  if (!r || !r.startsWith('/')) return cwd;
  const base = cwd.replace(/\/+$/, '');
  const clean = r.replace(/\/+$/, '');
  if (clean.includes('/../') || clean.endsWith('/..')) return cwd;
  return clean === base || clean.startsWith(base + '/') ? clean : cwd;
}

const keyOf = (vpsId: string, cwd: string) => `${vpsId}\u0000${cwd}`;

/**
 * Browsable https URL for a git remote, or null.
 *
 * Handles the three spellings a remote actually comes in — `git@host:path`,
 * `ssh://git@host/path`, `https://host/path` — and is host-agnostic: GitHub,
 * GitLab, Bitbucket and every self-hosted forge share the `host/path` layout,
 * so matching on known hosts would only mean silently dropping the link for
 * the private ones.
 *
 * The URL is REBUILT from a validated host and path rather than passed
 * through: it ends up in an `<a href>`, and a remote is a string out of the
 * VPS's git config, not something the hub controls. Anything that isn't a
 * plain hostname + path returns null — `file://`, a local path or an unknown
 * scheme is simply not linkable.
 */
export function webUrlFromRemote(remote: string | null | undefined): string | null {
  const raw = (remote ?? '').trim();
  if (!raw) return null;
  let host = '';
  let path = '';

  // scp-like: [user@]host:path. The `(?!\/)` is what keeps `https://…` out of
  // this branch — a scheme is always followed by two slashes.
  const scp = /^(?:[\w.+-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(raw);
  if (scp) {
    host = scp[1];
    // `host:2222/owner/repo` — an ssh port, not the first path segment.
    path = scp[2].replace(/^\d+\//, '');
  } else {
    const m = /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?([\w.-]+(?::\d+)?)\/(.+)$/i.exec(raw);
    if (!m) return null;
    host = m[1].replace(/:\d+$/, '');   // a git port means nothing to a browser
    path = m[2];
  }

  path = path.replace(/\.git\/?$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path || !/^[\w.-]+$/.test(host) || !host.includes('.')) return null;
  // Defence in depth: no segment may reintroduce a scheme, an authority or a
  // traversal once this is concatenated into an href.
  if (/[\\?#\s]|(^|\/)\.\.(\/|$)/.test(path)) return null;
  return `https://${host}/${path}`;
}

function prune() {
  if (cache.size < 64) return;
  const now = Date.now();
  for (const [k, e] of cache) if (!e.inflight && now - e.at > CACHE_MAX_AGE_MS) cache.delete(k);
}

/** Drop the memoized status for a repo (after any write). */
export function invalidateGitStatus(vpsId: string, cwd: string) {
  cache.delete(keyOf(vpsId, cwd));
}

function fail(error: string, reason: GitFailureReason) {
  return { ok: false as const, error, reason };
}

/**
 * One RPC round-trip, with the two hub-side failure modes mapped.
 * Agent-level failures ({ok:false, reason}) pass through untouched.
 */
async function rpc<T extends { ok: boolean }>(
  vpsId: string, method: string, params: Record<string, unknown>,
): Promise<T | { ok: false; error: string; reason: GitFailureReason }> {
  let client;
  try {
    client = getAgentClientForVpsId(vpsId);
  } catch {
    return fail('no agent for this VPS', 'offline');
  }
  if (!client || client.status !== 'connected') {
    return fail('the agent is not connected', 'offline');
  }
  try {
    return await client.call<T>(method, params);
  } catch (e: unknown) {
    // -32601: the agent predates 0.24.0. Detected from the RPC error rather
    // than compared against vps.agentVersion — the column can lag a rollout,
    // the error cannot.
    if (e instanceof AgentRpcError && e.code === -32601) {
      return fail('this VPS runs an agent older than 0.24.0 — update it to enable git', 'unsupported');
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/unknown method/i.test(msg)) {
      return fail('this VPS runs an agent older than 0.24.0 — update it to enable git', 'unsupported');
    }
    return fail(msg.slice(0, 300), /timeout/i.test(msg) ? 'timeout' : 'error');
  }
}

// ── snake_case → camelCase, the only reshaping we do ────────────────────────
type RawFile = {
  path: string; orig_path?: string | null; x: string; y: string; status: string;
  untracked: boolean; conflict?: boolean; binary?: boolean;
  added: number | null; deleted: number | null;
};

function toStatus(raw: Record<string, unknown>): GitStatusResponse {
  const files = Array.isArray(raw.files) ? (raw.files as RawFile[]) : [];
  return {
    ok: raw.ok !== false,
    error: raw.error as string | undefined,
    reason: raw.reason as GitFailureReason | undefined,
    isRepo: raw.is_repo === true,
    root: (raw.root as string | null) ?? null,
    branch: (raw.branch as string | null) ?? null,
    detached: raw.detached === true,
    head: (raw.head as string | null) ?? null,
    upstream: (raw.upstream as string | null) ?? null,
    ahead: (raw.ahead as number) ?? 0,
    behind: (raw.behind as number) ?? 0,
    remotes: (raw.remotes as string[]) ?? [],
    remoteUrl: (raw.remote_url as string | null) ?? null,
    remoteWebUrl: webUrlFromRemote(raw.remote_url as string | null),
    recentSubjects: (raw.recent_subjects as string[]) ?? [],
    files: files.map((f): GitFileEntry => ({
      path: f.path,
      origPath: f.orig_path ?? null,
      x: f.x, y: f.y, status: f.status,
      untracked: !!f.untracked,
      conflict: !!f.conflict,
      binary: !!f.binary,
      added: f.added ?? null,
      deleted: f.deleted ?? null,
    })),
    fileCount: (raw.file_count as number) ?? files.length,
    truncated: raw.truncated === true,
    added: (raw.added as number) ?? 0,
    deleted: (raw.deleted as number) ?? 0,
    conflicts: (raw.conflicts as number) ?? 0,
    rel: (raw.rel as string) ?? '',
    name: (raw.name as string) ?? '',
  };
}

function statusFailure(error: string, reason: GitFailureReason): GitStatusResponse {
  return { ok: false, error, reason, isRepo: false, files: [] };
}

function wsFailure(error: string, reason: GitFailureReason): GitWorkspaceResponse {
  return { ok: false, error, reason, mode: 'none', repos: [] };
}

/**
 * Every repo visible from `cwd`, cached per `(vpsId, cwd)`.
 *
 * `force` bypasses the TTL (after a write, and for the ↻ button) and also
 * bypasses the AGENT's discovery cache, so ↻ is how you make a freshly cloned
 * project appear rather than waiting a minute for it.
 */
export async function getGitWorkspace(
  vpsId: string, cwd: string, opts: { force?: boolean; includeRecent?: boolean } = {},
): Promise<GitWorkspaceResponse> {
  const key = keyOf(vpsId, cwd);
  const hit = cache.get(key);
  if (hit?.inflight) return hit.inflight;            // dedup, even when forced
  // `includeRecent` implies force: a cached entry from a plain poll has no
  // subjects, and silently returning it would make the generated message
  // ignore the repo's conventions. The enriched value is a superset, so
  // writing it back to the cache is harmless for later polls.
  const force = opts.force || opts.includeRecent;
  if (!force && hit?.value && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;

  const inflight = (async (): Promise<GitWorkspaceResponse> => {
    const r = await rpc<{ ok: boolean }>(vpsId, 'git_workspace', {
      cwd, include_recent: !!opts.includeRecent, refresh: !!opts.force,
    });
    // Agents 0.24.0–0.28.x have git but no workspace scan. Fall back to the
    // single-repo call rather than showing "update your agent" on a fleet
    // where git already works — the folder-of-projects case is the only thing
    // they miss, and it is exactly the case that used to show nothing anyway.
    if (r.ok === false && 'reason' in r && r.reason === 'unsupported') {
      const one = await rpc<{ ok: boolean }>(vpsId, 'git_status', {
        cwd, include_recent: !!opts.includeRecent,
      });
      if (one.ok === false && 'reason' in one && !('is_repo' in one)) {
        return wsFailure((one as { error: string }).error, (one as { reason: GitFailureReason }).reason);
      }
      const st = toStatus(one as unknown as Record<string, unknown>);
      return st.isRepo
        ? { ok: true, mode: 'single', repos: [st] }
        : { ok: st.ok, mode: 'none', repos: [], error: st.error, reason: st.reason };
    }
    if (r.ok === false && 'reason' in r && !('repos' in r)) {
      return wsFailure((r as { error: string }).error, (r as { reason: GitFailureReason }).reason);
    }
    return toWorkspace(r as unknown as Record<string, unknown>);
  })();

  cache.set(key, { at: Date.now(), value: hit?.value, inflight });
  try {
    const value = await inflight;
    // A failed poll must NOT clobber a good snapshot with an error the UI
    // would render as "git is broken" — same rule as the usage gauges
    // (§14.72e). The caller still receives the failure for THIS call.
    const keep = value.ok || !hit?.value?.ok ? value : hit.value;
    cache.set(key, { at: Date.now(), value: keep });
    prune();
    return value;
  } catch {
    cache.set(key, { at: Date.now(), value: hit?.value });
    return wsFailure('git status failed', 'error');
  }
}

function toWorkspace(raw: Record<string, unknown>): GitWorkspaceResponse {
  const rawRepos = Array.isArray(raw.repos) ? (raw.repos as Record<string, unknown>[]) : [];
  const mode = raw.mode === 'single' || raw.mode === 'multi' ? raw.mode : 'none';
  return {
    ok: raw.ok !== false,
    error: raw.error as string | undefined,
    reason: raw.reason as GitFailureReason | undefined,
    mode,
    repos: rawRepos.map(toStatus),
    scanned: raw.scanned as number | undefined,
    truncated: raw.truncated === true,
  };
}

export async function getGitDiff(
  vpsId: string, cwd: string, path: string, repo?: string | null,
): Promise<GitDiffResponse> {
  const r = await rpc<{ ok: boolean }>(vpsId, 'git_diff', { cwd: gitTarget(cwd, repo), path });
  return r as unknown as GitDiffResponse;
}

export async function gitCommit(
  vpsId: string, cwd: string,
  body: { message: string; paths?: string[]; all?: boolean; push?: boolean; repo?: string | null },
): Promise<GitCommitResponse> {
  const params: Record<string, unknown> = {
    cwd: gitTarget(cwd, body.repo), message: body.message, push: !!body.push,
  };
  if (body.all) params.all = true;
  else params.paths = body.paths ?? [];

  if (JSON.stringify(params).length > MAX_REQUEST_BYTES) {
    return {
      ok: false, reason: 'bad_paths',
      error: 'too many files selected for one request — use “commit all” instead',
    };
  }

  const r = await rpc<{ ok: boolean }>(vpsId, 'git_commit', params) as Record<string, unknown>;
  invalidateGitStatus(vpsId, cwd);
  return {
    ok: r.ok !== false,
    error: r.error as string | undefined,
    reason: r.reason as GitFailureReason | undefined,
    committed: r.committed === true,
    sha: (r.sha as string | null) ?? null,
    subject: r.subject as string | undefined,
    pushed: r.pushed === true,
    pushError: r.push_error as string | undefined,
    pushReason: r.push_reason as GitFailureReason | undefined,
    pushOutput: r.push_output as string | undefined,
  };
}

async function op(
  vpsId: string, cwd: string, repo: string | null | undefined,
  method: 'git_push' | 'git_pull' | 'git_discard' | 'git_fetch' | 'git_delete_branch',
  extra: Record<string, unknown> = {},
): Promise<GitOpResponse> {
  const params = { cwd: gitTarget(cwd, repo), ...extra };
  if (JSON.stringify(params).length > MAX_REQUEST_BYTES) {
    return { ok: false, reason: 'bad_paths', error: 'too many files selected for one request' };
  }
  const r = await rpc<{ ok: boolean }>(vpsId, method, params) as Record<string, unknown>;
  invalidateGitStatus(vpsId, cwd);
  // A network op can outlive AgentClient's 60s RPC timeout while the agent
  // keeps going (it allows 170s). We lost the ANSWER, not the push — saying
  // "timed out" would read as "it failed" and invite a pointless retry.
  if (r.reason === 'timeout' && (method === 'git_push' || method === 'git_pull' || method === 'git_fetch')) {
    return {
      ok: false, reason: 'timeout',
      error: 'still running on the VPS — refresh in a moment to see the result',
    };
  }
  return {
    ok: r.ok !== false,
    error: r.error as string | undefined,
    reason: r.reason as GitFailureReason | undefined,
    output: r.output as string | undefined,
    discarded: r.discarded as string[] | undefined,
  };
}

// ── History (agent >= 0.32.0, §14.87) ──────────────────────────────────────
// Not cached either: it is read on demand, it pages, and a commit list that
// silently came from a minute ago is worse than a round trip.
function toCommit(c: Record<string, unknown>): GitCommit {
  return {
    sha: String(c.sha ?? ''),
    short: String(c.short ?? '').slice(0, 12),
    author: String(c.author ?? ''),
    email: (c.email as string) ?? '',
    at: (c.at as number | null) ?? null,
    refs: Array.isArray(c.refs) ? (c.refs as string[]) : [],
    subject: String(c.subject ?? ''),
    body: (c.body as string) ?? '',
  };
}

export async function getGitLog(
  vpsId: string, cwd: string,
  opts: { repo?: string | null; path?: string | null; limit?: number; skip?: number } = {},
): Promise<GitLogResponse> {
  const r = await rpc<{ ok: boolean }>(vpsId, 'git_log', {
    cwd: gitTarget(cwd, opts.repo),
    path: opts.path ?? '',
    limit: opts.limit ?? 60,
    skip: opts.skip ?? 0,
  }) as Record<string, unknown>;
  if (r.ok === false) {
    return { ok: false, error: r.error as string, reason: r.reason as GitFailureReason, commits: [] };
  }
  const raw = Array.isArray(r.commits) ? (r.commits as Record<string, unknown>[]) : [];
  return {
    ok: true,
    root: (r.root as string) ?? null,
    path: (r.path as string | null) ?? null,
    commits: raw.map(toCommit),
    hasMore: r.has_more === true,
  };
}

export async function getGitShow(
  vpsId: string, cwd: string, sha: string, opts: { repo?: string | null; path?: string | null } = {},
): Promise<GitShowResponse> {
  const r = await rpc<{ ok: boolean }>(vpsId, 'git_show', {
    cwd: gitTarget(cwd, opts.repo), sha, path: opts.path ?? '',
  }) as Record<string, unknown>;
  if (r.ok === false) {
    return { ok: false, error: r.error as string, reason: r.reason as GitFailureReason, files: [] };
  }
  const files = Array.isArray(r.files) ? (r.files as Record<string, unknown>[]) : [];
  return {
    ok: true,
    commit: r.commit ? toCommit(r.commit as Record<string, unknown>) : undefined,
    files: files.map((f) => ({
      path: String(f.path ?? ''),
      origPath: null,
      x: 'M', y: 'M', status: 'M',
      untracked: false, conflict: false,
      binary: f.binary === true,
      added: (f.added as number | null) ?? null,
      deleted: (f.deleted as number | null) ?? null,
    })),
    patch: (r.patch as string) ?? '',
    truncated: r.truncated === true,
  };
}

// ── Branches (agent >= 0.31.0, §14.85) ─────────────────────────────────────
// Not cached: the modal is opened deliberately, and a stale branch list is
// worse than a 200ms wait — you are about to switch onto one of these.
export async function getGitBranches(
  vpsId: string, cwd: string, repo?: string | null,
): Promise<GitBranchesResponse> {
  const r = await rpc<{ ok: boolean }>(vpsId, 'git_branches', { cwd: gitTarget(cwd, repo) }) as Record<string, unknown>;
  if (r.ok === false) {
    return {
      ok: false, error: r.error as string, reason: r.reason as GitFailureReason, branches: [],
    };
  }
  const raw = Array.isArray(r.branches) ? (r.branches as Record<string, unknown>[]) : [];
  return {
    ok: true,
    root: (r.root as string) ?? null,
    current: (r.current as string) ?? null,
    detached: r.detached === true,
    truncated: r.truncated === true,
    branches: raw.map((b): GitBranch => ({
      name: String(b.name ?? ''),
      short: String(b.short ?? b.name ?? ''),
      remote: b.remote === true,
      current: b.current === true,
      upstream: (b.upstream as string | null) ?? null,
      ahead: (b.ahead as number) ?? 0,
      behind: (b.behind as number) ?? 0,
      gone: b.gone === true,
      aheadHead: (b.ahead_head as number | null) ?? null,
      behindHead: (b.behind_head as number | null) ?? null,
      committedAt: (b.committed_at as number | null) ?? null,
      subject: (b.subject as string) ?? '',
      worktree: (b.worktree as string | null) ?? null,
    })),
  };
}

export async function gitCheckout(
  vpsId: string, cwd: string, body: Omit<GitCheckoutBody, 'cwd'>,
): Promise<GitCheckoutResponse> {
  const r = await rpc<{ ok: boolean }>(vpsId, 'git_checkout', {
    cwd: gitTarget(cwd, body.repo),
    branch: body.branch,
    create: !!body.create,
    start_point: body.startPoint ?? '',
    push: !!body.push,
  }) as Record<string, unknown>;
  // A switch changes every number in the panel — branch, ahead/behind, and
  // usually the file list. Drop the workspace snapshot rather than let one
  // poll interval show the old branch's state under the new name.
  invalidateGitStatus(vpsId, cwd);
  return {
    ok: r.ok !== false,
    error: r.error as string | undefined,
    reason: r.reason as GitFailureReason | undefined,
    branch: r.branch as string | undefined,
    created: r.created === true,
    pushed: r.pushed === true,
    pushError: r.push_error as string | undefined,
    pushReason: r.push_reason as GitFailureReason | undefined,
    conflicts: Array.isArray(r.conflicts) ? (r.conflicts as string[]) : undefined,
  };
}

/**
 * `git fetch` — what makes `behind` a real number.
 *
 * Ahead/behind compare a local ref to its tracking ref, and that only moves on
 * a fetch. Without this the pull button never appeared, because nothing on the
 * VPS had learned the remote moved.
 */
export const gitFetch = (vpsId: string, cwd: string, repo?: string | null) =>
  op(vpsId, cwd, repo, 'git_fetch');

export const gitDeleteBranch = (vpsId: string, cwd: string, branch: string, repo?: string | null) =>
  op(vpsId, cwd, repo, 'git_delete_branch', { branch });

export const gitPush = (vpsId: string, cwd: string, repo?: string | null) =>
  op(vpsId, cwd, repo, 'git_push');
export const gitPull = (vpsId: string, cwd: string, repo?: string | null) =>
  op(vpsId, cwd, repo, 'git_pull');
export const gitDiscard = (vpsId: string, cwd: string, paths: string[], repo?: string | null) =>
  op(vpsId, cwd, repo, 'git_discard', { paths });
