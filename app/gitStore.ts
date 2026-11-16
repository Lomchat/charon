'use client';
/**
 * Shared source-control state, keyed on `(vpsId, cwd)` — NEVER on a session.
 *
 * The explorer (colours, branch, forge) and the git tab are two views of one
 * working tree, and several sessions (and tabs, and devices) can sit on the
 * same checkout. One store keyed on the repo means they always agree and cost
 * one poll between them — two views showing different states for the same
 * folder would read as a bug even when both were briefly true.
 *
 * Cadence, in order of how much of the freshness it actually delivers:
 *  1. explicit refresh after every write (commit / push / pull / discard) —
 *     the count must drop the instant the commit lands, not a poll later,
 *  2. a refresh when a turn finishes in a related folder — ANY session, not
 *     only the one on screen — or a shell command returns to its prompt,
 *  3. a slow background poll, only while the tab is visible and something is
 *     mounted — a backstop for edits made by another hub.
 *
 * A failed answer never replaces a good one (§14.76): the last snapshot stays
 * on screen with the error beside it, and the poll retries fast (an agent
 * reconnecting after a deploy is back in seconds) before settling on the
 * degraded cadence. Only states a retry cannot fix (agent too old, no git, a
 * folder with no checkout) wait long.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import type { GitFailureReason, GitStatusResponse, GitWorkspaceResponse } from '@/lib/types/api';
import { getSessionList, subscribeSummaries } from './sync/summaryStore';

const POLL_MS = 30_000;
// A cwd that isn't a repo essentially never becomes one mid-session, and
// `unsupported` / `no_git` resolve on an agent update, not on a timer.
const IDLE_POLL_MS = 300_000;
const DEGRADED_POLL_MS = 120_000;
// Consecutive failures a retry CAN fix (offline, timeout, transport).
const RETRY_MS = [5_000, 15_000, 30_000, 60_000];
// Shell activity is bursty (every prompt redraw is a busy→active edge):
// coalesce it into one refresh, at most one per window per repo.
const NUDGE_DEBOUNCE_MS = 1_500;
const NUDGE_MIN_GAP_MS = 10_000;

export type GitView = {
  /**
   * Every checkout visible from this cwd — one when the cwd IS a checkout,
   * several when it is a folder of projects (§14.83), none for a plain
   * folder. `null` until the first answer arrives.
   */
  workspace: GitWorkspaceResponse | null;
  loading: boolean;
  /**
   * The LATEST answer failed while `workspace` still holds the last good one
   * (or the route itself failed). A failure with nothing better to show rides
   * `workspace.reason` instead, with `error` null.
   */
  error: string | null;
};

type Entry = {
  view: GitView;
  subs: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  /** A forced refresh arrived during the flight: rerun ONCE after it. */
  dirty: boolean;
  /** Bumped per request; only the newest request's answer is applied. */
  generation: number;
  /** Last GOOD answer — a failure must not make a new subscriber trust it. */
  lastAt: number;
  /** Consecutive failed answers, and why the last one failed. */
  failures: number;
  lastFailure: GitFailureReason | 'transport' | null;
  nudge: ReturnType<typeof setTimeout> | null;
  nudgedAt: number;
};

const EMPTY: GitView = Object.freeze({ workspace: null, loading: false, error: null });

const g = globalThis as unknown as { __charonGitStore?: Map<string, Entry> };
const store = (g.__charonGitStore ??= new Map<string, Entry>());

const keyOf = (vpsId: string, cwd: string) => `${vpsId}\u0000${cwd}`;

function entryFor(key: string): Entry {
  let e = store.get(key);
  if (!e) {
    e = {
      view: EMPTY, subs: new Set(), timer: null, inflight: null, dirty: false, generation: 0,
      lastAt: 0, failures: 0, lastFailure: null, nudge: null, nudgedAt: 0,
    };
    store.set(key, e);
  }
  return e;
}

function emit(e: Entry, view: GitView) {
  e.view = view;
  for (const cb of e.subs) cb();
}

/** How long to wait before the next background poll, given what we last saw. */
export function nextGitDelay(e: Pick<Entry, 'view' | 'failures' | 'lastFailure'>): number {
  if (e.lastFailure === 'unsupported' || e.lastFailure === 'no_git') return DEGRADED_POLL_MS;
  if (e.failures > 0) return RETRY_MS[Math.min(e.failures, RETRY_MS.length) - 1];
  const w = e.view.workspace;
  // A folder with no checkout under it does not sprout one mid-session — and
  // this is the state that costs a directory SCAN on the VPS, so it is the one
  // that most deserves the long timer.
  if (w?.ok && w.mode === 'none') return IDLE_POLL_MS;
  return POLL_MS;
}

/**
 * Fold one answer into the entry. A failure keeps the last GOOD workspace on
 * screen with the error beside it — blanking the tree's colours over one
 * reconnect is the "it only works after ↻" bug — and is counted for the
 * retry ladder. Exported for tests.
 */
export function applyGitAnswer(
  e: Pick<Entry, 'view' | 'failures' | 'lastFailure' | 'lastAt' | 'dirty'>,
  answer: { workspace: GitWorkspaceResponse } | { transportError: string },
): GitView {
  if ('workspace' in answer && answer.workspace.ok) {
    e.failures = 0;
    e.lastFailure = null;
    e.lastAt = Date.now();
    return { workspace: answer.workspace, loading: e.dirty, error: null };
  }
  e.failures += 1;
  const prev = e.view.workspace;
  if ('transportError' in answer) {
    e.lastFailure = 'transport';
    return { workspace: prev, loading: e.dirty, error: answer.transportError };
  }
  const w = answer.workspace;
  e.lastFailure = w.reason ?? 'error';
  if (prev?.ok) {
    return { workspace: prev, loading: e.dirty, error: gitReasonHint(w.reason) ?? w.error ?? 'git status failed' };
  }
  return { workspace: w, loading: e.dirty, error: null };
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
  }, nextGitDelay(e));
}

async function fetchGit(vpsId: string, cwd: string, force = false): Promise<void> {
  const key = keyOf(vpsId, cwd);
  const e = entryFor(key);
  if (e.inflight) {
    // A poll may join the flight; a FORCED refresh (a write just landed, a
    // turn just finished) must not: the in-flight answer can predate the
    // write. It reruns once after it (R3 F14).
    if (force) e.dirty = true;
    return e.inflight;
  }

  emit(e, { ...e.view, loading: true });
  const p = (async () => {
    let forceNext = force;
    try {
      do {
        e.dirty = false;
        const gen = ++e.generation;
        try {
          const workspace = await api.getGitWorkspace(vpsId, cwd, forceNext);
          if (gen !== e.generation) continue;
          emit(e, applyGitAnswer(e, { workspace }));
        } catch (err: unknown) {
          if (gen !== e.generation) continue;
          emit(e, applyGitAnswer(e, { transportError: err instanceof Error ? err.message : String(err) }));
        }
        forceNext = true;
      } while (e.dirty);
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

/** Same folder, or one inside the other — what a write in `a` can change in `b`. */
export function relatedGitCwd(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, '') || '/';
  const y = b.replace(/\/+$/, '') || '/';
  return x === y || x === '/' || y === '/' || x.startsWith(y + '/') || y.startsWith(x + '/');
}

/** Every WATCHED entry a change in `(vpsId, cwd)` can affect. */
function relatedEntries(vpsId: string, cwd: string): [string, string, Entry][] {
  const out: [string, string, Entry][] = [];
  for (const [key, e] of store) {
    if (e.subs.size === 0) continue;
    const [v, c] = key.split('\u0000');
    if (v === vpsId && relatedGitCwd(c, cwd)) out.push([v, c, e]);
  }
  return out;
}

/** Force a refresh of every watched view touching this folder — a turn ended there. */
export function refreshRelatedGit(vpsId: string | null | undefined, cwd: string | null | undefined) {
  if (!vpsId || !cwd) return;
  for (const [v, c] of relatedEntries(vpsId, cwd)) void fetchGit(v, c, true);
}

/**
 * Something MAY have written here (a shell command returned to its prompt):
 * one trailing refresh per burst, never more than one per window per repo.
 */
export function nudgeGit(vpsId: string | null | undefined, cwd: string | null | undefined) {
  if (!vpsId || !cwd) return;
  for (const [v, c, e] of relatedEntries(vpsId, cwd)) {
    if (e.nudge) clearTimeout(e.nudge);
    const wait = Math.max(NUDGE_DEBOUNCE_MS, e.nudgedAt + NUDGE_MIN_GAP_MS - Date.now());
    e.nudge = setTimeout(() => {
      e.nudge = null;
      e.nudgedAt = Date.now();
      if (e.subs.size > 0) void fetchGit(v, c, true);
    }, wait);
  }
}

/** Drop everything we know about a repo (used when a session's cwd changes). */
export function forgetGit(vpsId: string, cwd: string) {
  const e = store.get(keyOf(vpsId, cwd));
  if (e?.timer) clearTimeout(e.timer);
  if (e?.nudge) clearTimeout(e.nudge);
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
  // Server snapshot: the store is client-only: the empty view.
  return useSyncExternalStore(sub, snapshot, () => EMPTY);
}

// A tab coming back to the foreground is the cheapest, highest-value refresh
// there is: the user is looking at the tree again and it may be minutes stale.
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

// A turn that ENDS is when an agent has just stopped writing files — in ANY
// session, not only the one on screen: a background session in the same repo
// writes the same tree. The summary store already carries every session's
// live status, so this costs one comparison per summary change.
if (typeof window !== 'undefined') {
  const gg = globalThis as unknown as { __charonGitTurnWatch?: () => void };
  gg.__charonGitTurnWatch?.();
  const last = new Map<string, string>();
  gg.__charonGitTurnWatch = subscribeSummaries(() => {
    for (const s of getSessionList()) {
      const now = String(s.liveStatus ?? s.status ?? '');
      const was = last.get(s.id);
      last.set(s.id, now);
      if (was === 'thinking' && now !== 'thinking') refreshRelatedGit(s.vpsId, s.cwd);
    }
  });
}

// ── Presentation helpers, shared by the explorer and the git tab ──────────

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
 * Merging is safe because git itself keeps the repos apart: a parent's status
 * never descends into a nested checkout, it reports that folder as ONE
 * untracked entry (`sub/`), which folds like any other.
 *
 * An enclosing checkout above a symlinked cwd keeps its REAL root (agent
 * ≥ 0.109.0 translates every other one), hence the second base `cwdReal`.
 */
export function buildGitDecorations(
  workspace: GitWorkspaceResponse | null | undefined, cwd: string | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!workspace?.ok || !cwd) return out;
  const bases = [cwd.replace(/\/+$/, '')];
  const real = workspace.cwdReal?.replace(/\/+$/, '');
  if (real && real !== bases[0]) bases.push(real);

  for (const repo of workspace.repos) {
    if (!repo.ok || !repo.isRepo || !repo.root) continue;
    const rootBase = repo.root.replace(/\/+$/, '');
    for (const f of repo.files) {
      // A nested checkout is reported as a folder, `sub/`: it folds like one
      // (the clone's own changes may already have ranked higher on it).
      const folder = f.path.endsWith('/');
      const abs = `${rootBase}/${f.path.replace(/\/+$/, '')}`;
      const base = bases.find((b) => abs.startsWith(b + '/'));
      if (!base) continue;   // in the repo, outside this tree (or the cwd itself)
      const rel = abs.slice(base.length + 1);
      const own = out.get(rel);
      if (!folder || own === undefined || (DIR_RANK[f.status] ?? 0) > (DIR_RANK[own] ?? 0)) {
        out.set(rel, f.status);
      }
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

// ── Workspace summaries, shared by the explorer and the git tab ────────────

/**
 * Folders of this tree that are checkouts of their own, `path relative to
 * cwd` — the fallback for the repo-folder glyph when the listing does not
 * carry `repo` (agent < 0.109.0). The cwd itself is ''.
 */
export function workspaceRepoDirs(
  workspace: GitWorkspaceResponse | null | undefined, cwd: string | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!workspace?.ok || !cwd) return out;
  const base = cwd.replace(/\/+$/, '');
  for (const repo of workspace.repos) {
    const root = repo.root?.replace(/\/+$/, '');
    if (!root) continue;
    if (root === base) out.add('');
    else if (root.startsWith(base + '/')) out.add(root.slice(base.length + 1));
  }
  return out;
}

/** Repos with something to show — a failed one still counts, it needs a fix. */
export function workspaceRepos(w: GitWorkspaceResponse | null | undefined): GitStatusResponse[] {
  return w?.ok ? w.repos : [];
}

/** Changed files across every checkout — what the git tab's badge counts. */
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
  cwd?: string | null,
): { repo: string; rel: string } | null {
  // The same path in the real namespace, for an enclosing root above a
  // symlinked cwd (see `buildGitDecorations`).
  const base = cwd?.replace(/\/+$/, '');
  const real = w?.cwdReal?.replace(/\/+$/, '');
  const alt = base && real && real !== base && (abs === base || abs.startsWith(base + '/'))
    ? real + abs.slice(base.length) : null;
  const inside = (r: GitStatusResponse, p: string) => !!r.root && (p === r.root || p.startsWith(r.root + '/'));
  const owner = workspaceRepos(w)
    // `/srv/a` must not own `/srv/abc/x` — the separator is the whole test.
    .filter((r) => r.ok && (inside(r, abs) || (alt != null && inside(r, alt))))
    .sort((a, b) => (b.root?.length ?? 0) - (a.root?.length ?? 0))[0];
  if (!owner?.root) return null;
  const p = inside(owner, abs) ? abs : alt!;
  return { repo: owner.root, rel: p === owner.root ? '' : p.slice(owner.root.length + 1) };
}

/** A changed file's owning repo + status row, for entry points outside GitTab. */
export function gitDiffTargetForPath(
  w: GitWorkspaceResponse | null | undefined,
  abs: string,
  cwd?: string | null,
): { repo: GitStatusResponse; file: GitStatusResponse['files'][number] } | null {
  const owner = repoForPath(w, abs, cwd);
  if (!owner) return null;
  const repo = workspaceRepos(w).find((candidate) => candidate.ok && candidate.root === owner.repo);
  const file = repo?.files.find((candidate) => candidate.path === owner.rel);
  return repo && file ? { repo, file } : null;
}

/** Commits waiting to be pushed / pulled, summed across the workspace. */
export function workspaceAheadBehind(w: GitWorkspaceResponse | null | undefined): { ahead: number; behind: number } {
  let ahead = 0;
  let behind = 0;
  for (const r of workspaceRepos(w)) { ahead += r.ahead ?? 0; behind += r.behind ?? 0; }
  return { ahead, behind };
}
