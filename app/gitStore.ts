'use client';
/**
 * Shared source-control state, keyed on `(vpsId, cwd)` — NEVER on a session.
 *
 * The dirty chip next to the cwd and the git tab are two views of one working
 * tree, and several sessions (and tabs, and devices) can sit on the same
 * checkout. One store keyed on the repo means they always agree and cost one
 * poll between them — two chips showing different counts for the same folder
 * would read as a bug even when both numbers were briefly true.
 *
 * Cadence, in order of how much of the freshness it actually delivers:
 *  1. explicit refresh after every write (commit / push / pull / discard) —
 *     the chip must drop the instant the commit lands, not a poll later,
 *  2. a refresh when a turn finishes, since that is when an agent has just
 *     finished writing files,
 *  3. a slow background poll, only while the tab is visible and something is
 *     mounted — a backstop for edits made in a shell or by another hub.
 *
 * The poll backs off hard on states that a poll cannot fix (not a repo, agent
 * too old, agent offline): those change on a deploy or a reconnect, not on a
 * timer, and hammering them is pure waste on a fleet with many sessions.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import type { GitStatusResponse, GitWorkspaceResponse } from '@/lib/types/api';

const POLL_MS = 30_000;
// A cwd that isn't a repo essentially never becomes one mid-session, and
// `unsupported` / `offline` resolve on an agent update or a reconnect.
const IDLE_POLL_MS = 300_000;
const DEGRADED_POLL_MS = 120_000;

export type GitView = {
  /**
   * Every checkout visible from this cwd — one when the cwd IS a checkout,
   * several when it is a folder of projects (§14.83), none for a plain
   * folder. `null` until the first answer arrives.
   */
  workspace: GitWorkspaceResponse | null;
  loading: boolean;
  /** Transport-level failure (the route itself). Agent-level ones ride `workspace.reason`. */
  error: string | null;
};

type Entry = {
  view: GitView;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  lastAt: number;
};

const EMPTY: GitView = Object.freeze({ workspace: null, loading: false, error: null });

const g = globalThis as unknown as { __charonGitStore?: Map<string, Entry> };
const store = (g.__charonGitStore ??= new Map<string, Entry>());

const keyOf = (vpsId: string, cwd: string) => `${vpsId}\u0000${cwd}`;

function entryFor(key: string): Entry {
  let e = store.get(key);
  if (!e) {
    e = { view: EMPTY, subs: new Set(), timer: null, inflight: null, lastAt: 0 };
    store.set(key, e);
  }
  return e;
}

function emit(e: Entry, view: GitView) {
  e.view = view;
  for (const cb of e.subs) cb();
}

/** How long to wait before the next background poll, given what we last saw. */
function nextDelay(view: GitView): number {
  const w = view.workspace;
  if (!w) return POLL_MS;
  // A folder with no checkout under it does not sprout one mid-session — and
  // this is the state that costs a directory SCAN on the VPS, so it is the one
  // that most deserves the long timer.
  if (w.ok && w.mode === 'none') return IDLE_POLL_MS;
  if (!w.ok && (w.reason === 'unsupported' || w.reason === 'offline' || w.reason === 'no_git')) {
    return DEGRADED_POLL_MS;
  }
  return POLL_MS;
}

function schedule(key: string, vpsId: string, cwd: string) {
  const e = entryFor(key);
  if (e.timer) clearTimeout(e.timer);
  if (e.subs.size === 0) { e.timer = null; return; }
  e.timer = setTimeout(() => {
    // Never poll a hidden tab: a phone left on this page would otherwise run
    // a git subprocess on the VPS every 30s forever.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      schedule(key, vpsId, cwd);
      return;
    }
    void fetchGit(vpsId, cwd);
  }, nextDelay(e.view));
}

async function fetchGit(vpsId: string, cwd: string, force = false): Promise<void> {
  const key = keyOf(vpsId, cwd);
  const e = entryFor(key);
  if (e.inflight) return e.inflight;

  emit(e, { ...e.view, loading: true });
  const p = (async () => {
    try {
      const workspace = await api.getGitWorkspace(vpsId, cwd, force);
      e.lastAt = Date.now();
      emit(e, { workspace, loading: false, error: null });
    } catch (err: unknown) {
      // Keep the last good snapshot on screen rather than blanking real
      // numbers over one failed request (same rule as the usage gauges,
      // §14.72e) — the error rides alongside it.
      emit(e, {
        workspace: e.view.workspace,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      e.inflight = null;
      schedule(key, vpsId, cwd);
    }
  })();
  e.inflight = p;
  return p;
}

/** Force a refresh — call after every write, and when a turn finishes. */
export function refreshGit(vpsId: string | null | undefined, cwd: string | null | undefined) {
  if (!vpsId || !cwd) return;
  void fetchGit(vpsId, cwd, true);
}

/** Drop everything we know about a repo (used when a session's cwd changes). */
export function forgetGit(vpsId: string, cwd: string) {
  const e = store.get(keyOf(vpsId, cwd));
  if (e?.timer) clearTimeout(e.timer);
  store.delete(keyOf(vpsId, cwd));
}

function subscribe(vpsId: string, cwd: string, cb: () => void): () => void {
  const key = keyOf(vpsId, cwd);
  const e = entryFor(key);
  e.subs.add(cb);
  // First subscriber primes the entry; later ones join the existing cadence
  // (and get the cached view immediately — no flash of "loading").
  if (e.subs.size === 1) {
    if (Date.now() - e.lastAt > POLL_MS) void fetchGit(vpsId, cwd);
    else schedule(key, vpsId, cwd);
  }
  return () => {
    e.subs.delete(cb);
    if (e.subs.size === 0 && e.timer) { clearTimeout(e.timer); e.timer = null; }
  };
}

/**
 * Live git view for a repo. Returns a stable EMPTY view when there's nothing
 * to watch, so callers can hook unconditionally.
 */
export function useGitStatus(vpsId: string | null | undefined, cwd: string | null | undefined): GitView {
  const sub = useCallback((cb: () => void) => {
    if (!vpsId || !cwd) return () => {};
    return subscribe(vpsId, cwd, cb);
  }, [vpsId, cwd]);
  const snapshot = useCallback(() => {
    if (!vpsId || !cwd) return EMPTY;
    return entryFor(keyOf(vpsId, cwd)).view;
  }, [vpsId, cwd]);
  // Server snapshot: the store is client-only, so SSR renders the empty view.
  return useSyncExternalStore(sub, snapshot, () => EMPTY);
}

// A tab coming back to the foreground is the cheapest, highest-value refresh
// there is: the user is looking at the chip again and it may be minutes stale.
if (typeof document !== 'undefined') {
  const gg = globalThis as unknown as { __charonGitVisArmed?: boolean };
  if (!gg.__charonGitVisArmed) {
    gg.__charonGitVisArmed = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      for (const [key, e] of store) {
        if (e.subs.size === 0) continue;
        const [vpsId, cwd] = key.split('\u0000');
        if (Date.now() - e.lastAt > POLL_MS) void fetchGit(vpsId, cwd, true);
      }
    });
  }
}

// ── Presentation helpers, shared by the chip and the panel ─────────────────

/** One-letter status → a label and a CSS modifier. */
export function fileStatusLabel(status: string): { label: string; cls: string } {
  switch (status) {
    case 'M': return { label: 'modified', cls: 'm' };
    case 'A': return { label: 'added', cls: 'a' };
    case 'D': return { label: 'deleted', cls: 'd' };
    case 'R': return { label: 'renamed', cls: 'r' };
    case 'C': return { label: 'copied', cls: 'r' };
    case 'T': return { label: 'type changed', cls: 'm' };
    case 'U': return { label: 'conflict', cls: 'u' };
    case '?': return { label: 'untracked', cls: 'q' };
    default: return { label: status, cls: 'm' };
  }
}

/**
 * Turn an agent-side failure into something the user can act on. The reasons
 * come from git.py `_classify`; this is the vpsHealth-style "why + fix" pairing
 * (§14.60), because "git commit failed" on its own is never actionable.
 */
export function gitReasonHint(reason: string | undefined, root?: string | null): string | null {
  switch (reason) {
    case 'identity':
      return 'git has no author on this VPS — run: git config --global user.name "…" && git config --global user.email "…"';
    case 'ownership':
      return `this repo is owned by another user — run: git config --global --add safe.directory ${root ?? '<repo>'}`;
    case 'auth':
      return 'no credentials for the remote on this VPS — add a deploy key or a credential helper';
    case 'no_remote':
      return 'this repository has no remote to push to';
    case 'rejected':
      return 'the remote has commits you do not — pull (rebase) first';
    case 'conflict':
      return 'rebase conflict — resolve it in a shell or ask an agent to';
    case 'unsupported':
      return 'this VPS runs an agent older than 0.24.0 — update the agent from the sidebar';
    case 'offline':
      return 'the agent is not connected';
    case 'no_git':
      return 'git is not installed on this VPS';
    case 'timeout':
      return 'the VPS took too long to answer';
    default:
      return null;
  }
}

// ── Tree decoration ─────────────────────────────────────────────────────────
// Rank used ONLY to fold several child statuses into one colour for a folder.
// Files always show their own letter; a folder shows the most significant
// thing inside it, which is what makes a collapsed tree still tell you where
// the work is.
const DIR_RANK: Record<string, number> = { U: 5, M: 4, D: 3, R: 2, C: 2, T: 4, A: 1, '?': 0 };

/**
 * `path relative to cwd` → git status letter, for every changed file AND every
 * directory above it, across EVERY checkout in the workspace.
 *
 * Git speaks in paths relative to a REPO ROOT while the tree is rooted at the
 * session's cwd, and the two are frequently different — a session started in
 * `src/`, or a folder holding several projects (§14.83). Everything is rebased
 * here, once per status change, and anything outside the cwd is dropped: it
 * exists in the repo but not in this tree.
 *
 * Merging is safe precisely because the repos are disjoint subtrees — the scan
 * never descends into a checkout, so no two of them can claim the same path.
 */
export function buildGitDecorations(
  workspace: GitWorkspaceResponse | null | undefined, cwd: string | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!workspace?.ok || !cwd) return out;
  const base = cwd.replace(/\/+$/, '');

  for (const repo of workspace.repos) {
    if (!repo.ok || !repo.isRepo || !repo.root) continue;
    const rootBase = repo.root.replace(/\/+$/, '');
    for (const f of repo.files) {
      const abs = `${rootBase}/${f.path}`;
      if (abs === base) continue;
      if (!abs.startsWith(base + '/')) continue;   // in the repo, outside this tree
      const rel = abs.slice(base.length + 1);
      out.set(rel, f.status);
      // Fold up the ancestors.
      let cut = rel.lastIndexOf('/');
      while (cut > 0) {
        const dir = rel.slice(0, cut);
        const cur = out.get(dir);
        if (cur === undefined || (DIR_RANK[f.status] ?? 0) > (DIR_RANK[cur] ?? 0)) out.set(dir, f.status);
        cut = dir.lastIndexOf('/');
      }
    }
  }
  return out;
}

// ── Workspace summaries, shared by the chip and the panel ───────────────────

/** Repos with something to show — a failed one still counts, it needs a fix. */
export function workspaceRepos(w: GitWorkspaceResponse | null | undefined): GitStatusResponse[] {
  return w?.ok ? w.repos : [];
}

/** Changed files across every checkout — what the chip's badge counts. */
export function workspaceDirtyCount(w: GitWorkspaceResponse | null | undefined): number {
  let n = 0;
  for (const r of workspaceRepos(w)) n += r.fileCount ?? r.files.length;
  return n;
}

/**
 * Which checkout owns an ABSOLUTE path, and what that path is called inside it.
 *
 * Both history entry points need it — the explorer's right-click and the file
 * view's header button (§14.87) — and two copies of a containment test drift,
 * so there is one. With several checkouts under one cwd (§14.83) the deepest
 * root wins: the scan makes them disjoint, but a `single`-mode root is an
 * ancestor of the cwd and would otherwise tie with nothing to break it. A repo
 * git could not read answers nothing here: `git log` in it fails the same way.
 */
export function repoForPath(
  w: GitWorkspaceResponse | null | undefined,
  abs: string,
): { repo: string; rel: string } | null {
  const owner = workspaceRepos(w)
    // `/srv/a` must not own `/srv/abc/x` — the separator is the whole test.
    .filter((r) => r.ok && r.root && (abs === r.root || abs.startsWith(r.root + '/')))
    .sort((a, b) => (b.root?.length ?? 0) - (a.root?.length ?? 0))[0];
  if (!owner?.root) return null;
  return { repo: owner.root, rel: abs === owner.root ? '' : abs.slice(owner.root.length + 1) };
}

/** Commits waiting to be pushed / pulled, summed across the workspace. */
export function workspaceAheadBehind(w: GitWorkspaceResponse | null | undefined): { ahead: number; behind: number } {
  let ahead = 0;
  let behind = 0;
  for (const r of workspaceRepos(w)) { ahead += r.ahead ?? 0; behind += r.behind ?? 0; }
  return { ahead, behind };
}
