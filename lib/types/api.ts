import type { EndpointState, CustomEndpoint } from '@/lib/customEndpoints';
import type { AccountProfile } from '@/lib/accountProfiles';
// Request/response types for `lib/api.ts`.
// Every `api.*` method must have its `XxxBody` / `XxxResponse` pair here.
// Reuse DB types (Vps, AgentSession, ...) and protocol types (PermissionMode,
// WorkerStatus) rather than redeclaring them.

import type {
  Vps, VpsFolder, VpsPath, AgentSession, AgentSessionMessage,
  AgentPendingPermission, AgentPendingQuestion, AppSetting,
  PushSub,
} from '@/lib/db/schema';
import type { PermissionMode, WorkerStatus, AccountUsage } from '@/lib/server/hub/types';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import type { InstallInfo, InstallStatus } from '@/lib/server/install/installSession';
import type {
  CodexEffort, CodexSandboxMode, SessionMode, SessionProvider,
} from '@/lib/sessionCapabilities';
import type { ClaudeSettingSource } from '@/lib/settingSources';
import type { ScheduledTasksState } from '@/lib/scheduledTasks';

// Re-export so consumers don't have to know the source
export type { Vps, VpsFolder, VpsPath, AgentSession, AgentSessionMessage,
  AgentPendingPermission, AgentPendingQuestion, AppSetting,
  PushSub, PermissionMode, WorkerStatus, AccountUsage, ShellInfo,
  InstallInfo, InstallStatus };
export type { AgentSessionAttachment, AgentSessionLog } from '@/lib/db/schema';

// Account usage (the `/usage` gauges) for a VPS. `usage` = the Claude account
// (api.anthropic.com/api/oauth/usage); `codexUsage` = the Codex account
// (app-server rate limits), present only when the VPS runs Codex. The header
// shows the one matching the current session's kind. cf. §14.58 / §14.59.
export type VpsUsageResponse = {
  /** Historical Claude/Codex fields, kept for older clients. */
  usage: AccountUsage | null;
  codexUsage?: AccountUsage | null;
  /** Provider-neutral map — what new clients read, so a backend's gauges need
   *  no new response field (§14.102). Absent on older servers. */
  byProvider?: Partial<Record<SessionProvider, AccountUsage | null>>;
};

// ── Multi-agent (Claude + Codex) discriminator & Codex config ────────────────
// Duplicated here (not imported from server-only agent/types.ts) to keep client
// bundles clean, mirroring the ClaudeEffortLevel pattern below.
export type AgentKind = SessionProvider;
export type AccountProfilesResponse = { profiles: AccountProfile[] };
export type CreateAccountProfileBody = { vpsId: string; provider: SessionProvider; name: string };
export type CreateAccountProfileResponse = { profile: AccountProfile };
export type UpdateAccountProfileBody = { vpsId: string; provider: SessionProvider; id: string; name?: string };
export type UpdateAccountProfileResponse = OkResponse;
// Codex "mode" is its sandbox level. Human/automatic approval is a separate
// reviewer choice; both providers use Charon's common permission cards.
export { CODEX_SANDBOX_MODES } from '@/lib/sessionCapabilities';
export type { CodexSandboxMode } from '@/lib/sessionCapabilities';
// Codex reasoning-effort levels (catalog-driven per model). 'ultra' is Codex's
// Workflow-delegation tier (analog of Claude's 'ultracode').
export type CodexEffortLevel = CodexEffort;
export const CODEX_CANONICAL_EFFORTS: CodexEffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

// GET /api/codex/models?vpsId=… — Codex model catalog for a VPS (account-driven,
// per-VPS; from the agent's list_codex_models → openai_codex .models()).
export type CodexModelPick = {
  id: string;
  label: string;
  hint?: string;
  isDefault?: boolean;
  efforts?: string[];          // per-model supported reasoning efforts
  defaultEffort?: string | null;
};
export type CodexModelsResponse = {
  ok: boolean;
  models: CodexModelPick[];
  efforts: string[];           // union across models (∪ CODEX_CANONICAL_EFFORTS)
  error?: string;
};

// ── VPS ──────────────────────────────────────────────────────────────────────

export type CreateVpsBody = {
  name: string;
  ip: string;
  sshUser: string;
  sshPort?: number;
  defaultPath?: string | null;
  // Folder in which to place the new VPS. If omitted, the server assigns it
  // to the first folder (by position) — typically the 'default' folder.
  folderId?: string | null;
};
export type UpdateVpsBody = Partial<CreateVpsBody> & {
  // Per-VPS Claude settings scope (§14.100): the canonical comma list
  // ('user,project'), 'none' for isolation, or null to go back to inheriting
  // the hub default. Not in CreateVpsBody — the choice is made when the agent
  // is installed, not when the row is created.
  claudeSettingSources?: string | null;
};

// ── VPS folders ──────────────────────────────────────────────────────────────

export type CreateVpsFolderBody = {
  name: string;
  // Absolute position in the list. If omitted, appends at the end.
  position?: number;
};
export type UpdateVpsFolderBody = {
  name?: string;
  collapsed?: boolean;
};
// Atomic re-layout: positions of all folders + assignment+position of all
// VPSes. The server applies it in a transaction. The client sends the
// entire desired state after a drag-end.
export type VpsLayoutBody = {
  folders: { id: string; position: number }[];
  vps: { id: string; folderId: string; position: number }[];
};
export type VpsLayoutResponse = {
  ok: true;
  folders: VpsFolder[];
  vps: Vps[];
};

export type TestVpsResponse = { ok: boolean; error?: string };

// GET /api/vps/[id]/fs?path= — directories directly under `path` on the VPS
// (NewSessionWizard path autocomplete + existence check on submit).
// ok:false = ssh-level failure, SOFT (the client just hides suggestions);
// exists:false = the dir isn't there (cd failed).
export type SessionPathResponse = { ok: true; exists: boolean; resolved?: string } | { ok: false; error: string };

export type VpsFsListResponse = {
  ok: boolean;
  error?: string;
  exists?: boolean;
  // `pwd` after cd — canonical form of `path` (~ and .. resolved).
  resolved?: string | null;
  dirs?: string[];
  truncated?: boolean;
};

// ── Tabs: the persisted workspace layout (§14.78) ──────────────────────────
export type TabKind = 'session' | 'shell' | 'install' | 'file';

export type TabDTO = {
  id: string;
  vpsId: string;
  /** Group key: the session/shell cwd, or the folder containing a file. */
  path: string;
  kind: TabKind;
  /** Entity id, or the file path relative to `path`. */
  ref: string;
  /** false = temporary preview (italic, one per group). */
  pinned: boolean;
  /** Order inside the (vpsId, path) group — row 3. */
  position: number;
  /** Order of this VPS in row 1 / of this group in row 2. Denormalised: every
   *  row of a VPS shares `vpsPos`, every row of a group shares `groupPos`. */
  vpsPos: number;
  groupPos: number;
  /** Browser-local render projection. Server responses may carry the legacy
   *  shared bit, which tabStore deliberately ignores. */
  active: boolean;
};

export type ReorderTabsBody =
  | { scope: 'tabs'; vpsId: string; path: string; ids: string[] }
  | { scope: 'groups'; vpsId: string; paths: string[] }
  | { scope: 'vps'; vpsIds: string[] };

export type TabsResponse = { tabs: TabDTO[]; sync?: import('@/lib/sync/protocol').SyncStamp };
export type OpenTabBody = {
  vpsId: string; path: string; kind: TabKind; ref: string; pin?: boolean;
};
export type CloseTabResponse = { ok: boolean; nextActiveId: string | null };

// ── Read-only file tree (agent >= 0.25.0, agent/charon_agent/fsnav.py) ─────
// One directory per call: the tree expands lazily, so a node_modules costs
// nothing until someone opens it.
export type FsEntry = {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  symlink: boolean;
  /** Where a symlink points, RAW (`readlink`) — the tree's link tooltip. */
  linkTarget?: string;
  /** A symlink whose destination does not exist (agent >= 0.109.0). */
  linkBroken?: boolean;
  /** Only present when the caller asked for git decoration (`withGit`). */
  ignored?: boolean;
  /** A directory holding a `.git` entry — its own checkout (agent >= 0.109.0). */
  repo?: boolean;
  /** That checkout's remote as a browsable https URL, rebuilt hub-side from
   *  a validated host + path (agent >= 0.111.0). Absent = no usable remote. */
  remoteWebUrl?: string;
};

/**
 * Symlink half of `fs_read`/`fs_stat` (agent >= 0.85.0): the raw target is
 * what `ls -l` shows, and `linkResolved` only appears when it says something
 * the raw one doesn't — which file is actually being edited.
 */
export type FsLinkInfo = {
  symlink?: boolean;
  linkTarget?: string | null;
  linkResolved?: string | null;
};

export type FsListResponse = {
  ok: boolean;
  error?: string;
  root?: string;
  /** Path of the listed directory, relative to `root` ('.' at the top). */
  path?: string;
  entries: FsEntry[];
  count?: number;
  truncated?: boolean;
  /** A paged answer's first index (`limit` asked, agent >= 0.110.0). */
  offset?: number;
  /** Where the next page starts; absent on the last one. */
  nextOffset?: number;
};

export type FsReadResponse = FsLinkInfo & {
  ok: boolean;
  error?: string;
  path?: string;
  size?: number;
  binary?: boolean;
  encoding?: 'utf8' | 'base64' | null;
  content?: string | null;
  truncated?: boolean;
  /** Bigger than the viewer will ship — content is null and says so. */
  tooLarge?: boolean;
  /** sha256 of the BYTES ON DISK — the token a later write must present. */
  sha256?: string | null;
  /** Cheap stat token for external-change polling; never authorizes a write. */
  version?: string | null;
};

export type FsStatResponse = FsLinkInfo & {
  ok: boolean;
  error?: string;
  reason?: 'offline' | 'unsupported' | 'error';
  path?: string;
  exists?: boolean;
  size?: number;
  mtimeNs?: number;
  version?: string | null;
};

// ── File viewers' agent RPCs (agent >= 0.108.0, §14.112) ──────────────────
/** Why a viewer RPC said no: an old agent, a missing tool on the VPS, … */
export type FsToolReason =
  | 'unsupported' | 'unavailable' | 'offline' | 'format' | 'missing' | 'exists' | 'error';
type FsToolBase = { ok: boolean; error?: string; reason?: FsToolReason };

/** GET /api/vps/[id]/fs/range — `length` bytes from `offset` (negative = from the end). */
export type FsRangeResponse = FsToolBase & {
  size?: number; offset?: number; length?: number;
  /** base64 */
  data?: string;
  version?: string | null;
};

export type SqliteColumn = { name: string; type: string; pk: boolean };
export type SqliteObject = {
  type: 'table' | 'view' | 'index' | 'trigger';
  name: string;
  table: string;
  sql: string | null;
  /** Row count, null when it would have cost too long. */
  rows?: number | null;
  columns?: SqliteColumn[];
};
/** A bounded cell: blobs and long texts arrive as descriptions, not payloads. */
export type SqliteCell =
  | null | boolean | number | string
  | { $blob: number; hex: string }
  | { $text: string; length: number };
export type FsSqliteBody =
  | { root: string; path: string; op: 'schema' }
  | { root: string; path: string; op: 'query'; sql: string; params?: (string | number | null)[]; limit?: number };
export type FsSqliteResponse = FsToolBase & {
  objects?: SqliteObject[];
  size?: number;
  columns?: string[];
  rows?: SqliteCell[][];
  truncated?: boolean;
  elapsedMs?: number;
};

export type ArchiveEntry = {
  name: string;
  size: number;
  packed?: number;
  dir: boolean;
  mtime: number | null;
  link?: string | null;
  encrypted?: boolean;
};
export type FsArchiveBody = { root: string; path: string; op: 'list' | 'read' | 'extract'; member?: string };
export type FsArchiveResponse = FsToolBase & {
  kind?: 'zip' | 'tar' | 'gzip';
  entries?: ArchiveEntry[];
  total?: number;
  truncated?: boolean;
  /** read: the member's size (null for a bare .gz), base64 data. */
  size?: number | null;
  data?: string;
  /** extract: the new folder, relative to `root`. */
  dest?: string;
  files?: number;
  bytes?: number;
  skipped?: number;
};

export type FsConvertBody = { root: string; path: string; to: 'png' | 'pdf' };
export type FsConvertResponse = FsToolBase & {
  /** png: base64 */
  data?: string;
  width?: number; height?: number; origWidth?: number; origHeight?: number; frames?: number;
  /** pdf: where the agent cached it — stream it like any file. */
  root?: string;
  path?: string;
  size?: number;
};

/** POST /api/vps/[id]/fs/preview — the live view's URL (§14.110). */
export type FsLivePreviewBody = { root: string; path: string };
export type FsLivePreviewResponse = {
  ok: boolean;
  error?: string;
  /** Same-origin `/api/preview/<token>/<path>`, sandboxed by its own headers. */
  url?: string;
  /** Epoch ms after which the URL answers 403 — re-mint before then. */
  expiresAt?: number;
};

export type FsWriteBody = {
  root: string; path: string; content: string;
  /** Precondition. Omit to force, '' to require the file not to exist yet. */
  expectedSha256?: string | null;
};

export type FsWriteResponse = {
  ok: boolean;
  error?: string;
  /** 'stale' = the file changed on the VPS since it was read. */
  reason?: 'stale' | 'bad_path' | 'too_large' | 'offline' | 'unsupported' | 'error';
  size?: number;
  /** On success the new sha, on 'stale' the CURRENT one (offer a reload). */
  sha256?: string | null;
  version?: string | null;
};

// Explorer context menu (agent >= 0.27.0, symlink >= 0.75.0). One route, one shape.
export type FsOpBody = {
  root: string;
  op: 'mkdir' | 'rename' | 'symlink' | 'delete';
  path: string;
  /** rename/symlink — the destination, relative to `root`. */
  to?: string;
  /** delete only — required for a non-empty directory. */
  recursive?: boolean;
};

export type FsOpResponse = {
  ok: boolean;
  error?: string;
  /** 'exists' / 'not_empty' are questions for the user, not failures. */
  reason?: 'bad_path' | 'exists' | 'missing' | 'not_empty' | 'offline' | 'unsupported' | 'error';
  path?: string;
  /** symlink only — its relative target name. */
  target?: string;
};

// Explorer drop: OS files uploaded into a chosen folder (agent >= 0.99.0).
// Paths are relative to `root`, like every explorer route.
export type FsUploadBody =
  | { op: 'check'; root: string; paths: string[] }
  | { op: 'begin'; root: string; path: string; size: number; overwrite?: boolean };

export type FsUploadResponse = {
  ok: boolean;
  error?: string;
  reason?: import('@/lib/fsUpload').FsUploadReason;
  /** check — the paths that already exist, and whether each is a folder. */
  existing?: { path: string; dir: boolean }[];
  /** begin — the id every chunk is sent to. Absent when `done` already. */
  uploadId?: string;
  /** chunk — bytes the hub has accepted so far. */
  received?: number;
  /** begin (empty file) / last chunk — committed on the VPS. */
  done?: boolean;
};

// ── Search across the tree (agent >= 0.29.0, §14.84) ───────────────────────
// Two searches behind one shape: `text` greps inside files, `file` matches
// path names. They share every parameter that makes a search precise, so
// splitting them into two RPCs would have duplicated all of it.
export type FsSearchMode = 'text' | 'file';

export type FsSearchQuery = {
  root: string;
  query: string;
  mode: FsSearchMode;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  /** Comma-separated globs, VS Code spelling: `*.ts, src/**`. */
  include?: string;
  exclude?: string;
  /** Skip node_modules & co. On by default; the UI exposes the switch. */
  useDefaultExcludes?: boolean;
  /** Answer as NDJSON `FsSearchStreamLine`s, hits as they are found. */
  stream?: boolean;
};

export type FsSearchMatch = {
  /** 1-based, and what the editor scrolls to when the row is clicked. */
  line: number;
  col: number;
  /** The line, windowed around the first hit — a minified bundle is one line. */
  text: string;
  /** [start, end) offsets INTO `text`, already rebased onto the window. */
  ranges: [number, number][];
  /** True when `text` starts mid-line, so the UI can show the ellipsis. */
  clipped?: boolean;
};

export type FsSearchFile = {
  path: string;
  size: number;
  mtime: number;
  count: number;
  matches: FsSearchMatch[];
  /** This file hit the per-file cap — there are more matches in it. */
  truncated?: boolean;
};

/** POST /api/search/files — the global palette's file hits (hub-side fan-out). */
export type FileSearchHit = { vpsId: string; vpsName: string; root: string; path: string; size: number; mtime: number };
export type FileSearchResponse = {
  files: FileSearchHit[];
  rootsSearched: number;
  /** Roots that were late, failed or past the cap: the list may be incomplete. */
  rootsSkipped: number;
  truncated: boolean;
};

export type FsSearchResponse = {
  ok: boolean;
  error?: string;
  reason?: 'bad_query' | 'bad_path' | 'offline' | 'unsupported' | 'error';
  root?: string;
  mode?: FsSearchMode;
  files: FsSearchFile[];
  totalFiles?: number;
  totalMatches?: number;
  scanned?: number;
  /** A bound was hit. Never silently: an empty-looking search must say why. */
  truncated?: boolean;
  elapsedMs?: number;
  /** 'git' = .gitignore decided what is in scope, 'walk' = the default list. */
  source?: 'git' | 'walk';
  /** Stopped because a newer search replaced it (streamed searches only). */
  cancelled?: boolean;
};

/** One line of a streamed search (`stream: true`): hits as they are found,
 *  then ONE `done` with the totals (its `files` stays empty). An agent older
 *  than streaming answers with a single `files` line holding everything. */
export type FsSearchStreamLine =
  | { type: 'files'; files: FsSearchFile[]; scanned?: number; totalMatches?: number }
  | ({ type: 'done' } & FsSearchResponse);

// ── Source control (agent >= 0.24.0, agent/charon_agent/git.py) ────────────
// Shapes mirror the RPC results verbatim: the hub routes are a thin
// auth + cache layer, they never reshape the payload. cf. CLAUDE.md §14.76.

// Why an operation failed, in a form the UI can turn into a fix. Anything
// unrecognized collapses to 'error' — GitFailureReason must stay exhaustive
// on the CONSUMING side (vpsHealth-style), never on the producing one.
export type GitFailureReason =
  | 'ownership'   // dubious ownership → git config --global --add safe.directory
  | 'identity'    // user.name / user.email unset on the VPS
  | 'auth'        // no credentials for the remote
  | 'no_remote'
  | 'rejected'    // non-fast-forward → pull --rebase
  | 'conflict'
  | 'no_changes'
  | 'no_message'
  | 'bad_paths'
  | 'bad_path'
  | 'bad_branch'  // a branch name we refuse to hand to git
  | 'bad_ref'     // a commit-ish we refuse to hand to git
  | 'dirty'       // the switch would overwrite local changes — never forced
  | 'exists'      // create hit an existing branch
  | 'unmerged'    // branch -d refused: commits live nowhere else
  | 'current'     // that branch is checked out
  | 'no_cwd'
  | 'no_git'      // git not installed on the VPS
  | 'timeout'
  | 'hook'
  | 'unsupported' // HUB-side: agent older than 0.24.0
  | 'offline'     // HUB-side: no agent connection for this VPS
  | 'error';

export type GitFileEntry = {
  path: string;
  origPath?: string | null;   // rename source
  x: string;                  // index status letter (porcelain v2)
  y: string;                  // worktree status letter
  status: string;             // one-letter summary: M A D R U ?
  untracked: boolean;
  conflict?: boolean;
  binary?: boolean;
  added: number | null;       // null = binary / not counted
  deleted: number | null;
};

export type GitStatusResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  // false is the NORMAL answer for a non-git cwd — the UI renders nothing at
  // all, so it must never be treated as a failure.
  isRepo: boolean;
  root?: string | null;
  branch?: string | null;
  detached?: boolean;
  head?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  remotes?: string[];
  /** Raw origin URL as git has it (ssh or https). */
  remoteUrl?: string | null;
  /** Same remote rebuilt as a browsable https URL, or null when it isn't one. */
  remoteWebUrl?: string | null;
  // Last few commit subjects — only populated when the caller asked for them
  // (the commit-message generator, never the poll). They are what makes a
  // generated message match the repo's own conventions.
  recentSubjects?: string[];
  files: GitFileEntry[];
  fileCount?: number;
  truncated?: boolean;
  added?: number;
  deleted?: number;
  conflicts?: number;
  /** Path of `root` relative to the session cwd — '' when they are the same. */
  rel?: string;
  /** Basename of the repo root, for the section header of a multi-repo folder. */
  name?: string;
};

/**
 * Every checkout a session can see, in one answer (agent >= 0.29.0).
 *
 * `mode`:
 *  - `single` — the cwd is inside a checkout. One repo, scoped to its
 *    toplevel; exactly the pre-0.29.0 behaviour.
 *  - `multi`  — the cwd is NOT a checkout but contains some (a folder of
 *    projects: /srv, /var/www/html). One entry per discovered repo, reported
 *    even when there is one, because the panel then has to name the folder.
 *  - `none`   — a plain folder with nothing underneath it.
 */
export type GitWorkspaceResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  mode: 'single' | 'multi' | 'none';
  repos: GitStatusResponse[];
  /** Repos found by the downward scan (multi only). */
  scanned?: number;
  /** The scan hit its depth/count/dir budget — the list may be incomplete. */
  truncated?: boolean;
  /** `cwd` with symlinks resolved (agent >= 0.109.0): roots under it come
   *  back in cwd's own namespace, only an ENCLOSING root stays real. */
  cwdReal?: string;
};

/** One branch, local or remote-only (agent >= 0.31.0, §14.85). */
export type GitBranch = {
  /** Full short ref: `main`, or `origin/main` for a remote-only branch. */
  name: string;
  /** What to display and what to switch to — `origin/` stripped. */
  short: string;
  remote: boolean;
  current: boolean;
  upstream?: string | null;
  /** Drift vs its UPSTREAM: what the push / pull buttons are about. */
  ahead: number;
  behind: number;
  /** The upstream is gone (branch deleted on the remote). */
  gone?: boolean;
  /**
   * Drift vs the branch you are ON — what switching would cost you. null on
   * git < 2.41, which has no `ahead-behind` field.
   */
  aheadHead?: number | null;
  behindHead?: number | null;
  committedAt?: number | null;
  subject?: string;
  /** Checked out in this worktree — git will refuse a second checkout of it. */
  worktree?: string | null;
};

export type GitBranchesResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  root?: string | null;
  current?: string | null;
  detached?: boolean;
  branches: GitBranch[];
  truncated?: boolean;
};

// ── Code intelligence (agent >= 0.33.0, §14.89) ────────────────────────────
/** An LSP diagnostic, verbatim from the language server. */
export type LspDiagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** 1 error · 2 warning · 3 information · 4 hint. */
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
};

/** One place a symbol lives, with the source line so a list is choosable. */
export type LspLocation = {
  path: string;
  /** 1-based, ready for `revealLine`. */
  line: number;
  character?: number;
  /** The source line, attached agent-side — a bare file:line is unusable. */
  preview?: string;
};

export type LspStatusResponse = {
  ok: boolean;
  error?: string;
  reason?: string;
  /** LSP language id for the file, or null when nothing maps to it. */
  language?: string | null;
  /** A server binary exists on the VPS for this language. */
  available: boolean;
  /** One is running for this root right now. */
  running: boolean;
  server?: string | null;
  /** The command that would install one, when there is none. */
  install?: string | null;
};

export type LspOpenResponse = {
  ok: boolean;
  error?: string;
  reason?: string;
  install?: string | null;
  version?: number;
  diagnostics: LspDiagnostic[];
  diagVersion: number;
  server?: string | null;
};

export type LspDiagnosticsResponse = {
  ok: boolean;
  error?: string;
  reason?: string;
  diagnostics: LspDiagnostic[];
  diagVersion: number;
  /** Something changed since `since` — false means the long poll simply expired. */
  changed: boolean;
  running: boolean;
};

export type LspRequestResponse = {
  ok: boolean;
  error?: string;
  reason?: string;
  result?: unknown;
};

/** An agent touching a file, right now (§14.88). */
export type FileActivityEntry = {
  vpsId: string;
  /** Absolute path on the VPS. */
  path: string;
  kind: 'read' | 'write';
  sessionId: string;
  sessionName: string | null;
  at: number;
};

export type FileActivityResponse = { activity: FileActivityEntry[] };

/** One commit in the history list (agent >= 0.32.0, §14.87). */
export type GitCommit = {
  sha: string;
  short: string;
  author: string;
  email?: string;
  at?: number | null;
  /** Decorations git puts on the commit: `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs?: string[];
  subject: string;
  body?: string;
};

export type GitLogResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  root?: string | null;
  commits: GitCommit[];
  /** Repo-relative path this history was scoped to, if any. */
  path?: string | null;
  hasMore?: boolean;
};

export type GitShowResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  commit?: GitCommit;
  files: GitFileEntry[];
  patch?: string;
  truncated?: boolean;
};

export type GitCheckoutBody = {
  cwd: string;
  repo?: string | null;
  branch: string;
  create?: boolean;
  /** Base for a new branch. Defaults to the current HEAD. */
  startPoint?: string | null;
  /** Publish a newly created branch with `push -u`. */
  push?: boolean;
};

export type GitCheckoutResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  branch?: string;
  created?: boolean;
  pushed?: boolean;
  pushError?: string;
  pushReason?: GitFailureReason;
  /** Paths a switch would have overwritten (reason: 'dirty'). */
  conflicts?: string[];
};

export type GitDiffResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  path?: string;
  patch?: string;
  truncated?: boolean;
  tracked?: boolean;
};

export type GitCommitBody = {
  cwd: string;
  /**
   * Repo to act on, when the cwd holds several. Absolute, and validated
   * server-side to sit inside the cwd. `cwd` stays the CACHE key (one
   * workspace = one poll), `repo` is the git target.
   */
  repo?: string | null;
  message: string;
  paths?: string[];
  all?: boolean;
  push?: boolean;
};

export type GitCommitResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  committed?: boolean;
  sha?: string | null;
  subject?: string;
  // A failed push after a SUCCESSFUL commit keeps ok:true — reporting the
  // whole thing as failed would push the user to commit twice.
  pushed?: boolean;
  pushError?: string;
  pushReason?: GitFailureReason;
  pushOutput?: string;
};

export type GitOpResponse = {
  ok: boolean;
  error?: string;
  reason?: GitFailureReason;
  output?: string;
  discarded?: string[];
};

export type GitMessageResponse = {
  ok: boolean;
  error?: string;
  message?: string;
};

export type UpdateVpsAgentResponse = {
  ok: boolean;
  error?: string;
  newVersion?: string | null;
  newPyzSha?: string | null;
  // claude-agent-sdk version confirmed in the venv by the unified update
  // (null when the SDK sub-step failed — the pyz update may still be ok).
  sdkVersion?: string | null;
  // openai-codex version, same contract. Load-bearing for the badge: the
  // sidebar's `outdated` is agent OR claude-sdk OR CODEX (Sidebar §
  // codexOutdatedOf), so a VPS stale only on codex kept its "⇪ update" lit
  // after a successful update — the initiating tab patches from THIS response
  // and had no codex field to patch with.
  codexSdkVersion?: string | null;
  codexCliVersion?: string | null;
  // Third backend's venv package, same contract. The route BUILDS these from
  // the registry's declared release lines (`PROVIDER_VERSION_COLUMNS`) — this
  // declaration types them, it does not enumerate them.
  cursorSdkVersion?: string | null;
  builtPyzSha: string;
  detail: string;
  // Non-fatal sub-step failures on an ok update ("sdk upgrade failed: …",
  // "codex skipped: …") — the pyz deployed but a pip step didn't, so the
  // "update" badge will relight. The UI surfaces these as a toast.
  warnings?: string[];
};

export type RefreshVpsAgentResponse = {
  ok: boolean;
  agentStatus: 'ok' | 'missing' | 'error' | 'unknown';
  agentVersion?: string | null;
  agentPyzSha?: string | null;
  // Classified failure detail when agentStatus='error' (vps.agentLastError
  // format: 'ssh-auth: …' | 'ssh-hostkey: …' | 'ssh-unreachable: …' | 'daemon-down: …' | 'error: …').
  agentLastError?: string | null;
  /** Set when the daemon would not stay up and the hub redeployed its agent
   *  (the update flow's summary). */
  repaired?: string;
  error?: string;
};

export type LocalAgentStatus = {
  installed: boolean;
  deployedPyzSha: string | null;
  builtPyzSha: string | null;
  // Versions drive `outOfDate` (§14.6); the shas above are display-only.
  deployedAgentVersion?: string | null;
  builtAgentVersion?: string | null;
  outOfDate: boolean;
  serviceActive: boolean | null;
};

// ── Shells ───────────────────────────────────────────────────────────────────

export type ShellsListResponse = { shells: ShellInfo[] };
// startShell accepts initial dimensions so the agent's PTY is the right size
// from the first byte (the WS then forwards subsequent resizes).
export type StartShellBody = { cwd?: string | null; name?: string | null; cols?: number; rows?: number };
export type UpdateShellBody = { name?: string | null; color?: string | null };
// Input/output/resize for shells flow over WebSocket (/api/shells/[id]/ws),
// not HTTP — see app/ShellTerminal.tsx + server.js. No api.ts wrapper for
// the data plane (the terminal opens its own WebSocket directly).

// ── Installs (agent install sessions) ────────────────────────────────────────
// In-memory only, shell pattern. No POST body (the VPS id is enough).

export type InstallsListResponse = { installs: InstallInfo[] };
export type VpsInstallResponse = { install: InstallInfo | null };

// ── VPS paths ────────────────────────────────────────────────────────────────

export type CreateVpsPathBody = {
  vpsId: string;
  path: string;
  label?: string | null;
};
export type UpdateVpsPathBody = { path?: string; label?: string | null };

export type ClaudeCheckResponse = {
  ok: boolean;
  python: string | null;
  pythonOk: boolean;
  pythonWarn: boolean;
  claudeCli: string | null;
  sdk: string | null;
  sdkInstalled: boolean;
  cliInstalled: boolean;
  authOk: boolean;
  raw: Record<string, string>;
};

export type SetupVpsClaudeResponse = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

// State of `claude login` on a VPS. Returned by POST /api/vps/[id]/claude/check-login.
export type ProviderAccountResponse = {
  ok: boolean;
  loggedIn?: boolean;
  checkedAt?: number;
  email?: string;
  name?: string;
  organization?: string;
  subscriptionType?: string;
  authMethod?: string;
  expiresAtMs?: number;
  error?: string;
};

export type CheckClaudeLoginResponse = {
  ok: boolean;
  error?: string;
  loggedIn: boolean;
  checkedAt: number | null;
};

// Claude device-code login (POST|GET|DELETE /api/vps/[id]/login + POST
// /api/vps/[id]/login/code, §14.64). `claude auth login` prints a hosted OAuth
// url (platform.claude.com callback — works headless), the user authorizes on
// ANY device and pastes the code back. A rejected code is recoverable: the
// phase returns to 'pending' with a fresh `url` and a non-fatal `error`.
export type ClaudeLoginPhase = 'starting' | 'pending' | 'verifying' | 'success' | 'error';
export type ClaudeLoginAccount = {
  authMethod?: string;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
};
export type ClaudeLoginStatusResponse = {
  ok: boolean;
  phase?: ClaudeLoginPhase;
  url?: string | null;
  error?: string | null;
  account?: ClaudeLoginAccount | null;
  /** Bumps on every fresh url — distinguishes a retry from a re-render. */
  attempt?: number;
};

// Codex ChatGPT device-code login (POST|GET|DELETE /api/vps/[id]/codex/login,
// agent >= 0.16.0). The user opens verificationUrl on ANY device and types
// userCode; the VPS persists its own credentials on completion (§14.61).
export type CodexLoginStartResponse = {
  ok: boolean;
  error?: string;
  loginId?: string;
  verificationUrl?: string;
  userCode?: string;
};
export type CodexLoginStatusResponse = {
  ok: boolean;
  status?: 'pending' | 'success' | 'error';
  error?: string | null;
};

// ── Cursor sign-in (§14.104) ────────────────────────────────────────────────
// One url, no code: the SDK polls the browser handshake itself and stores the
// minted key on the VPS. Charon never receives a credential.
export type CursorLoginStartResponse = {
  ok: boolean;
  error?: string;
  loginId?: string;
  url?: string;
};
export type CursorLoginStatusResponse = {
  ok: boolean;
  status?: 'pending' | 'success' | 'error';
  url?: string | null;
  error?: string | null;
};
export type CursorLoginCheckResponse = {
  ok: boolean;
  loggedIn: boolean;
  email?: string | null;
  checkedAt?: number | null;
  error?: string | null;
};
/** One tunable knob on a Cursor model (`thinking`, `fast`) with its allowed
 *  values. This is Cursor's equivalent of an effort level — per MODEL rather
 *  than global, which is why there is no effort picker (§14.103). */
export type CursorModelParameter = {
  id: string;
  label: string;
  values: { value: string; label?: string }[];
};
/** A shipped combination of parameter values. It has no id of its own — the
 *  params ARE its identity, and Charon stores them as `id?thinking=true`. */
export type CursorModelVariant = {
  params: Record<string, string>;
  label?: string;
  description?: string;
  isDefault?: boolean;
};
/** $/million tokens, from Cursor's public pricing doc (`cursorPricing.ts`).
 *  Absent when the doc does not list that model — an unknown price shows
 *  nothing, never a guess. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  provider: string | null;
};
export type CursorModel = {
  id: string;
  label: string;
  description?: string;
  parameters?: CursorModelParameter[];
  variants?: CursorModelVariant[];
  /** Standard rate. */
  price?: ModelPrice;
  /** The `fast` lane's rate, which the doc lists as its own row — routinely
   *  2-3x the standard one, and the clearest cost signal the catalog has. */
  fastPrice?: ModelPrice;
};
export type CursorModelsResponse = {
  ok: boolean;
  models: CursorModel[];
  reason?: string;
  error?: string | null;
};

export type ScannedClaudeSession = {
  sessionId: string;
  cwd: string;
  cwdLatest: string;
  summary: string;
  aiTitle: string;
  lastPrompt: string;
  firstUserText: string;
  messageCount: number;
  model: string;
  gitBranch: string;
  mtime: number;
  size: number;
};
export type ScanVpsClaudeResponse = { sessions: ScannedClaudeSession[] };

// The Codex scan (/api/vps/[id]/codex/scan) answers the SAME shape so one
// component renders both backends — `sessionId` is the Codex THREAD id and
// `effort` is Codex-only (the reasoning effort of the thread's last turn).
// `cwdLatest`/`summary` are absent server-side; keep them optional here rather
// than emitting empty strings the UI would have to special-case.
export type ScannedCodexSession = Omit<ScannedClaudeSession, 'cwdLatest' | 'summary'> & {
  cwdLatest?: string;
  summary?: string;
  effort?: string;
  archived?: boolean;
};
export type ScanVpsCodexResponse = { sessions: ScannedCodexSession[] };
/** Either backend's scan row — what ResumeModal actually renders. */
export type ScannedSession = ScannedClaudeSession | ScannedCodexSession;

/** Provider-neutral scan response. Cursor adds workspace discovery and an
 * inclusive continuation cursor because its store is scoped by cwd. */
export type ScanVpsSessionsResponse = {
  ok?: boolean;
  sessions: ScannedSession[];
  folders?: string[];
  nextCwd?: string;
  truncated?: boolean;
  reason?: string;
  error?: string;
};
// ── Session history of a VPS (agent >= 0.124.0, history.py) ─────────────────
// The resume modal's source: one row per Claude transcript / Codex rollout,
// from the agent's cached index (ResumeModal). `approx`: a big transcript was
// sampled, `prompts` only counts what the samples saw — show the size instead.
export type HistorySession = {
  kind: AgentKind;
  /** The NATIVE id (Claude session uuid, Codex thread id) — what import takes. */
  sessionId: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  lastPrompt: string;
  prompts: number;
  approx: boolean;
  model: string;
  effort?: string;
  branch: string;
  /** Seconds since the epoch. */
  mtime: number;
  size: number;
  /** Codex: an archived thread (archived_sessions/). */
  archived?: boolean;
};
export type HistoryIndexResponse = {
  ok: boolean;
  sessions?: HistorySession[];
  /** Transcripts not indexed yet (the first build works newest-first within
   *  a time budget): call again. */
  pending?: number;
  total?: number;
  /** `unsupported`: the agent predates history_index — use the scans. */
  reason?: 'unsupported' | 'offline' | 'error';
  error?: string;
};
export type HistoryTool = {
  k: 'edit' | 'read' | 'cmd' | 'search' | 'web' | 'agent' | 'other';
  t: string;
  /** Repeats of the same action in the turn. */
  n?: number;
};
export type HistoryTurn = {
  user: string;
  answer: string;
  tools: HistoryTool[];
  more_tools: number;
  at?: string;
};
export type HistoryPreviewResponse = {
  ok: boolean;
  first?: string;
  turns?: HistoryTurn[];
  reason?: 'unsupported' | 'offline' | 'missing' | 'invalid' | 'error';
  error?: string;
};

export type ScanVpsSessionsQuery = {
  accountProfile?: string;
  archived?: boolean;
  /** First workspace to scan on the next page. */
  after?: string;
  /** Scan exactly this workspace. */
  cwd?: string;
};

// ── Claude sessions ──────────────────────────────────────────────────────────

export type AgentSessionListQuery = { vpsId?: string; status?: string; includeArchived?: boolean };

export type SessionListItem = AgentSession & {
  accountProfile?: string;
  accountProfileNumber?: number;
  endpoint?: EndpointState;
  liveStatus: WorkerStatus | string;
  /** Background tasks still running (§14.91) — the sidebar card's count.
   *  Absent on the SSR seed; `session_bg_tasks` keeps it live between polls. */
  runningBgTasks?: number;
  /** Every pending gate (= pendingBlocking + pendingAsync), kept for older tabs. */
  pendingPermissions: number;
  /** Permissions + blocking questions + plan reviews: the session waits on you.
   *  Absent from older hubs (read it as `pendingPermissions`). */
  pendingBlocking?: number;
  /** Async questions: answerable any time, never block nor expire (§14.96). */
  pendingAsync?: number;
  firstUserMessage: string | null;
  /** True only while the provider-neutral bus can route this stable handle. */
  addressable?: boolean;
  /** Newest message timestamp (ms), or null for a session that never spoke.
   *  "Finished 4 minutes ago" orders on this; `createdAt` answers the launch
   *  and `unreadStop` is only a flag. */
  lastActivityMs?: number | null;
  /** The CLI's scheduled tasks as of their last change (lib/scheduledTasks.ts);
   *  null = never reported. Dormant while the session sleeps. */
  scheduledTasks?: ScheduledTasksState | null;
  /** The prompt cache the last turn left (lib/promptCache.ts); null = none
   *  reported. The countdown runs on the browser's clock. */
  promptCache?: import('@/lib/promptCache').PromptCacheState | null;
};

// Non-sensitive VPS fields that can change while the dashboard stays open.
// The live `vps_status` SSE event is the fast path; this bounded snapshot is
// the convergence path when an event was missed (suspended tab, reconnect,
// slow-consumer close). Never return connection credentials from a list poll.
export type VpsRuntimeSnapshot = Pick<Vps,
  | 'id'
  | 'agentStatus'
  | 'agentVersion'
  | 'agentPyzSha'
  | 'agentLastError'
  | 'sdkVersion'
  | 'codexAvailable'
  | 'codexSdkVersion'
  | 'codexCliVersion'
  | 'claudeLoggedIn'
  | 'codexLoggedIn'
  | 'cursorAvailable'
  | 'cursorSdkVersion'
  | 'cursorLoggedIn'
>;

/**
 * What a client compares a VPS against to decide "is this out of date".
 *
 * The pyz baseline (§14.6) plus one `latest` per DECLARED release line, keyed
 * by the registry's `latestKey`. Consumed as a bag by `diagnoseVps`, the
 * sidebar and the data modal — none of them may re-list the keys.
 */
export type VpsStalenessBaselines = {
  builtPyzSha?: string | null;
  /** `__version__` of the pyz this hub ships — THE staleness baseline (§14.6). */
  builtAgentVersion?: string | null;
} & Partial<Record<string, string | null>>;

export type AgentSessionsListResponse = {
  sessions: SessionListItem[];
  // Authoritative runtime state for the fleet. Optional for rolling upgrades:
  // older hubs omit it, while newer clients keep the SSE-only behavior.
  vpsRuntime?: VpsRuntimeSnapshot[];
  // Live staleness baselines (hub pyz sha + PyPI latests) — refreshed by the
  // client on every list poll so long-open tabs never compare against frozen
  // SSR props (phantom "update agent" badge). Optional: older servers omit it.
  // The `latestKey`s are declared by the provider registry and produced in one
  // place (`sdkSync § latestVersionsByKey`), so the index signature is the
  // honest type: naming three of four here is how the fourth axis ended up
  // comparing against `undefined` (§14.102).
  meta?: VpsStalenessBaselines;
  /** The bus revision this list reflects (§14.108; absent from older hubs).
   *  Each `sessions` row is then a `SessionSummary` (a superset), except the
   *  `archived: 1` rows `includeArchived=1` adds. */
  sync?: import('@/lib/sync/protocol').SyncStamp;
};

/** `sync` of an action route (§3.5 of the sync refonte): read after the
 *  touched sessions' summaries were published, so `sync.rev ≥` the summary
 *  frame carrying the action. Absent from older hubs. */
export type ActionSyncStamp = { sync?: import('@/lib/sync/protocol').SyncStamp };

export type PendingPermissionPayload = {
  id: string;
  tool: string;
  input: unknown;
  createdAt: number;
  expiresAt?: number;
  /** The provider's own words for why it asks. */
  reason?: string;
  /** Claude: the CLI's "don't ask again" options (lib/permissionSuggestions.ts). */
  suggestions?: import('@/lib/permissionSuggestions').PermissionSuggestion[];
};
export type PendingQuestionPayload = {
  id: string;
  questions: unknown[];
  createdAt: number;
  expiresAt?: number;
  delivery?: 'async';
  /** Answers reserved, the send still in flight (async questions): show
   *  "sending…", not an editable form. Absent from older hubs. */
  delivering?: boolean;
};
export type PendingExitPlanPayload = {
  id: string;
  plan: string;
  createdAt: number;
  expiresAt?: number;
};

// Compact, provider-neutral projection of ONE background work item. The
// session-detail endpoint returns the currently running set independently of
// chat pagination so a task launched outside the visible message window can
// never leave the sidebar and the composer bar disagreeing.
export type SessionBackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stale';
export type SessionBackgroundTaskAgent = {
  index: number | null;
  label: string | null;
  state: string | null;
  model: string | null;
  phaseTitle: string | null;
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  resultPreview: string | null;
  // Saved workflow nodes only (journal + run folder): the native agent id,
  // wall-clock start / last activity in ms (file times), the result's shape.
  agentId?: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  outcome?: WorkflowResultSummary | null;
};
// A workflow agent's structured result, reduced to what a timeline can show
// without knowing the workflow: its first text, booleans, list sizes (lists of
// objects counted by their few-valued field, e.g. findings by severity).
export type WorkflowResultSummary = {
  text?: string;
  flags?: Array<{ key: string; value: boolean }>;
  counts?: Array<{ key: string; n: number; by?: Array<{ value: string; n: number }> }>;
};
export type SessionBackgroundTask = {
  taskId: string;
  description: string | null;
  command: string | null;
  toolUseId: string | null;
  taskType: string | null;
  status: SessionBackgroundTaskStatus;
  startedAt: number;
  endedAt: number | null;
  outputFile: string | null;
  summary: string | null;
  workflowName: string | null;
  usage: { tokens: number | null; toolUses: number | null; durationMs: number | null } | null;
  lastToolName: string | null;
  agents: SessionBackgroundTaskAgent[] | null;
  // A command a SUB-AGENT runs: a step of its owner, not work of its own
  // (`app/bgTasks.ts § bgWorkItems`). Absent = false.
  ownedBySubagent?: boolean;
};

export type AgentSessionDetailResponse = {
  // The transcript view this window was cut for (`?view=`, CLAUDE.md §14.25):
  // `conversation` carries no tool/thinking/plan rows. Optional: older hubs
  // omit it (and always answer `full`).
  view?: import('@/lib/transcriptRows').TranscriptView;
  // `tool_use` rows of the whole session (the calls tab's counter without the
  // rows; GET …/tool-calls pages them). Optional: older hubs omit it.
  toolCallCount?: number;
  // null while the hub's incremental fold of a cold session warms ("unknown,
  // keep the last value"; a `session_token_usage` frame follows).
  tokenUsage?: import('@/lib/sessionTokenUsage').SessionTokenUsage | null;
  session: AgentSession & { endpoint?: EndpointState };
  liveStatus: WorkerStatus | string;
  // The provider is summarising the conversation (stream memory, frame
  // `compacting`). Optional: older hubs omit it.
  liveCompacting?: boolean;
  // The session still runs the agent code of before an update (§14.117):
  // moved automatically once idle. Optional: older hubs omit it.
  liveRuntimeOutdated?: boolean;
  // What the outdated runtime runs (agent >= 0.131.0): the header's "from".
  liveRuntimeVersions?: import('@/lib/runtimeUpdate').RuntimeVersions | null;
  // "Applies at next start" flags the hub knows (window mode; a key is absent
  // when unknown since the hub's boot — keep the view's own value).
  pendingApply?: { model?: boolean; effort?: boolean };
  subscribers: number;
  // Window of the last `limit` "chat" messages (user/assistant/tool_use/
  // tool_result/user_question/exit_plan_request/thinking) + all the
  // edit_snapshot and event entries in the same ID range (cf. backend
  // loadMessageWindow). Sorted asc by id.
  messages: Array<AgentSessionMessage & { peerReplyTo?: string }>;
  // True if there are CHAT messages even older than `oldestChatId`.
  // Used by the client to decide whether to enable scroll-up loadMore.
  hasMore: boolean;
  // id of the oldest CHAT message in this window. Used as a cursor to
  // pass as `?before=<oldestChatId>` to the next loadMore. null if the
  // window is empty.
  oldestChatId: number | null;
  // True max message id for the session across ALL roles (incl.
  // edit_snapshot/event outside the chat window). The polling cursor.
  // Optional for backward-compat with responses cached by older builds.
  maxMessageId?: number;
  streamingText: string;
  // Set while a replay EXTENDS persisted assistant row `rowId` (a SIGTERM
  // partial): its first `length` chars are that row's, already in `messages`;
  // `streamingText` then holds only the text past them. Optional: older hubs
  // omit it (sync refonte C08).
  streamingExtends?: { rowId: number; length: number } | null;
  // Transcript features of this hub (`HUB_TRANSCRIPT_FEATURES`,
  // lib/assistantBoundaries.ts): `assistant_flushed` ⇒ the hub cuts assistant
  // bubbles. Optional: older hubs omit it (legacy client boundaries).
  features?: string[];
  // A delta provider's (Codex/Cursor) reasoning block still open hub-side,
  // not yet in a row; '' otherwise. Optional: older hubs and the conversation
  // view omit it.
  streamingThinking?: string;
  // Its first delta's time (unix ms) while it is open, else null: the open
  // bubble is dated like its row will be. Optional: older hubs omit it.
  streamingThinkingTsMs?: number | null;
  // Model id Anthropic actually used on the last AssistantMessage (agent
  // >= 0.6.0). Null when no turn has happened since attach OR the agent is
  // too old to emit `effective_model`. The UI shows it in the badge so the
  // user has a reliable source of truth — independent of the LLM's
  // self-identification (which is famously unreliable, training cutoff).
  effectiveModel?: string | null;
  // Authoritative ACTIVE registry derived from the full persisted bg_task
  // history, not from the paginated `messages` window. Optional so a cached
  // response produced by an older hub remains usable during rolling deploys.
  // Running tasks carry their launcher tool_use's `command`/`description`.
  backgroundTasks?: SessionBackgroundTask[];
  // True when the window GET could not answer `backgroundTasks` yet (a cold
  // registry warming in background slices): the running tasks already held
  // stay, and the warm set arrives as a `bg_tasks_snapshot` frame.
  backgroundTasksPending?: boolean;
  pendingPermissions: PendingPermissionPayload[];
  pendingQuestions: PendingQuestionPayload[];
  // `plan` is filled server-side when the request came without one (the plan
  // file's latest Write/Edit, conversationSources.ts § exitPlanFallback).
  pendingExitPlans: PendingExitPlanPayload[];
  // Output of the tools still running (`tool_progress` so far, last 64 KiB
  // per tool, ≤ 8 tools; `truncated` = older output dropped). Frames with a
  // rev > `sync` extend it. Optional: older hubs omit it.
  streamingToolOutput?: Array<{ toolUseId: string; text: string; truncated: boolean }>;
  // `?conn=&focusSeq=`: the focus applied atomically inside this GET (routing
  // only). `focused` = that connection now routes this session's frames.
  focus?: { applied: boolean; focused: boolean; focusSeq: number };
  // The bus revision this snapshot reflects: every frame ≤ it is inside,
  // none > it (CLAUDE.md §14.14). Optional: older hubs omit it.
  sync?: import('@/lib/sync/protocol').SyncStamp;
};

/** The window GET's answer (`GET /api/sessions/[id]` without `before`/
 *  `since`) — the transcript snapshot the client sync applies (CLAUDE.md
 *  §14.107, app/sync/windowSync.ts). */
export type SessionWindowResponse = AgentSessionDetailResponse;
/** Query of the window GET: the transcript view, and the SSE connection whose
 *  focus the GET applies atomically (`conn`/`focusSeq`). */
export type SessionWindowQuery = {
  view?: import('@/lib/transcriptRows').TranscriptView;
  conn?: string;
  focusSeq?: number;
};

// GET /api/sessions/[id]/probe?conn&afterId&view — the transcript's
// O(1) rev-gated check (sync refonte C12). The hub pushes one heartbeat to
// `conn` first, so the SSE carries a frame ≥ `rev` right behind everything it
// queued before.
export type SessionProbeResponse = {
  epoch: number; rev: number;      // currentRev() at read (after the heartbeat push)
  sessionRev: number;              // rev of the last BROWSER-ROUTED bus frame carrying this sessionId, any type
                                   // (summary frames included, `internal` excluded); 0 = none this process
  focused: boolean;                // conn registered && conn.focus === id
  maxMessageId: number;
  newRows: number[];               // ids > afterId of rows RENDERED in `view` (lib/transcriptRows.ts), ≤ 50
  newRowsTruncated: boolean;
  pendingIds: string[];            // pending gate ids (all kinds) of this session
};

// POST /api/focus (kind 'focus'): the registry's answer + the bus
// revision at that moment.
export type FocusResponse = {
  ok: boolean; applied: boolean; focus: string | null; focusSeq: number;
  sync?: import('@/lib/sync/protocol').SyncStamp;
};

// GET /api/sessions/[id]/tool-calls?before=<rowId>&limit=N (≤500): the
// calls tab in conversation view, paged newest first, each page in
// chronological order. Never ships a full tool result — a ≤512-char preview.
export type ToolCallSummary = {
  id: string;                  // SDK tool_use id, else 'h' + rowId
  rowId: number;
  name: string;
  input: unknown;              // compactToolInputForWire
  startedAt: number;           // unix seconds (the row's created_at)
  result: { isError: boolean; preview: string } | null;   // null + no resultUnknown = no result yet (running)
  /** The bounded result scan stopped before reaching this call's result (it
   *  may exist further on, e.g. a long sub-agent): NOT proof it is running. */
  resultUnknown?: true;
};
export type AgentSessionToolCallsResponse = {
  calls: ToolCallSummary[];
  hasMore: boolean;            // older calls exist (next `before` = calls[0].rowId)
  total: number;               // tool_use rows of the session
};

// loadMore response (GET ...?before=<id>): LEAN — exactly these fields; the
// session-wide envelope belongs to the window GET.
export type AgentSessionMessageWindow = {
  messages: Array<AgentSessionMessage & { peerReplyTo?: string }>;
  hasMore: boolean;
  oldestChatId: number | null;
  // The bus revision this page reflects (sync refonte C12). Optional: older
  // hubs omit it.
  sync?: import('@/lib/sync/protocol').SyncStamp;
};

// GET /api/sessions/[id]/edits — lazy diff-content fetch.
//
// The main session GET strips edit_snapshot `content` because it is re-fetched
// in a 5s loop (a large session's full snapshots = tens of MB per fetch, which
// got the VPS suspended for egress — cf. CLAUDE.md §14 gotcha 41). This
// endpoint serves the LATEST before/after content per modified file, once per
// session view, so the ToolPanel diffs tab still works. `before == null` means
// a new file (Write); `after == null` means a deletion / budget-dropped file.
export type SessionEditContent = {
  filePath: string;
  toolUseId: string;
  before: string | null;
  after: string | null;
  truncated: boolean;
};
export type AgentSessionEditsResponse = {
  edits: SessionEditContent[];
  // True if total content exceeded the server budget and some files' content
  // was omitted (before/after null, truncated true).
  truncatedList: boolean;
};

export type CreateAgentSessionBody = {
  vpsId: string;
  cwd: string;
  name?: string | null;
  // 'claude' (default) | 'codex'. Determines the backend + config semantics.
  kind?: AgentKind;
  // Whatever `sessionModes(kind)` declares for this backend: Claude's
  // permission modes, Codex's sandbox levels, Cursor's freedom ladder. Typed as
  // the union rather than as two of the three — the wizard sends the mode the
  // picker offered, and naming two providers here made the third fail to
  // compile at the one call site that was actually right (§14.102).
  permissionMode?: SessionMode;
  // Per-session config. Pass null/omit to inherit the global defaults
  // (claude.default_* / codex.default_*). Effort validity depends on kind;
  // invalid values are silently dropped server-side.
  model?: string | null;
  fallbackModel?: string | null;   // Claude only (Codex ignores it)
  effort?: string | null;
  /** Provider-specific construction options. Shared fields have identical UI
   * semantics; the adapters map them to each SDK's native shape. */
  sessionConfig?: ProviderSessionConfig | null;
  /** @deprecated request compatibility for clients predating the neutral name. */
  providerConfig?: CodexSessionConfig | null;
  /** Born on a saved custom endpoint: needs no provider account. */
  endpoint?: { savedId: string; model?: string | null };
};

export type SharedSessionConfig = {
  accountProfile?: string;
  accountProfileNumber?: number;
  customEndpoint?: CustomEndpoint & { secret?: string };
  outputSchema?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  env?: Record<string, string>;
};

export type ClaudeSessionConfig = SharedSessionConfig & {
  /** null = CLI defaults; "all" = every discovered skill; [] = none. */
  skills?: 'all' | string[] | null;
  /**
   * Which on-disk settings files this session loads (§14.100). Resolved at
   * CREATE time from the session → VPS → hub chain and persisted, so a later
   * change to the fleet default never rewrites a running session's rules.
   * null/absent = the session predates the feature (the agent then applies its
   * own ['project'] default); [] = isolation, no settings file and no CLAUDE.md.
   */
  settingSources?: ClaudeSettingSource[] | null;
};

export type CodexSessionConfig = SharedSessionConfig & {
  configOverrides?: string[];
  summary?: 'auto' | 'concise' | 'detailed' | 'none' | null;
  personality?: 'friendly' | 'pragmatic' | 'none' | null;
  serviceTier?: 'fast' | 'flex' | null;
  ephemeral?: boolean;
  modelProvider?: string | null;
  codexBin?: string | null;
  approvalsReviewer?: 'user' | 'auto_review';
  permissionProfile?: string | null;
};
export type CursorSessionConfig = SharedSessionConfig & {
  /** Ambient Cursor settings layers the session loads (`.cursor/rules`,
   *  hooks, skills). Same idea as Claude's `settingSources` (§14.100),
   *  resolved at CREATE and persisted so a fleet default never rewrites a
   *  running session's rules. null = the agent's own default. */
  settingSources?: CursorSettingSource[] | null;
  /** Route local tool calls through Cursor's own safety classifier. Charon
   *  cannot raise a per-request card for Cursor (§14.103), so this is the
   *  gate — on by default for every mode except `force`. */
  autoReview?: boolean | null;
  /** Built-in tool allow/deny lists, by tool name. */
  tools?: string[] | null;
  disallowedTools?: string[] | null;
};
/** The scopes the SDK accepts, as a value so the create route can validate
 *  against it rather than forwarding whatever a body contained. */
export const CURSOR_SETTING_SOURCES = [
  'project', 'user', 'team', 'mdm', 'plugins', 'all',
] as const;
export type CursorSettingSource = typeof CURSOR_SETTING_SOURCES[number];
export type ProviderSessionConfig =
  ClaudeSessionConfig | CodexSessionConfig | CursorSessionConfig;
export type CreateAgentSessionResponse = {
  id: string;
  kind: AgentKind;
  status: WorkerStatus | string;
  nativeSessionId: string | null;
  vpsId: string;
  cwd: string;
  name: string | null;
  permissionMode: SessionMode;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
};

export type ImportAgentSessionBody = {
  accountProfile?: string;
  vpsId: string;
  // Claude: the SDK session uuid. Codex: the thread id (§14.59).
  nativeSessionId: string;
  cwd: string;
  name?: string | null;
  kind?: AgentKind;
  // Whatever this backend declares (`sessionModes(kind)`).
  permissionMode?: SessionMode;
};
export type ImportAgentSessionResponse = {
  id: string;
  messagesImported: number;
  importError?: string;
};

export type RenameAgentSessionBody = {
  name?: string | null;
  handle?: string;
  color?: string | null;
};

export type SendAgentInputBody = {
  content: string;
  // The browser's UUID for its optimistic bubble (≤64 chars, [A-Za-z0-9-]):
  // the agent's idempotency key, echoed on `user_echo`. A retry with the same
  // id never writes a second row (sync refonte C08).
  clientMessageId?: string;
  codexInputs?: Array<Record<string, unknown>>;
};
export type SendAgentInputResponse = { ok: true; rowId: number | null; clientMessageId: string } & ActionSyncStamp;
// The /input endpoint also accepts `{ type: 'interrupt' }` — modelled as a
// union to stay typed. `interruptSession` sends the 2nd branch.
export type AgentInputBody = SendAgentInputBody | { type: 'interrupt' };

export type RespondPermissionBody = {
  id: string;
  allow: boolean;
  /** Codex: the provider's native session grant. */
  always?: boolean;
  /** Claude: index of the CLI suggestion picked (`suggestions[i]`). */
  suggestion?: number;
};
export type RespondQuestionBody = {
  id: string;
  answers: Record<string, string> | null;
};
export type RespondExitPlanBody = {
  id: string;
  decision: 'approve' | 'reject';
  feedback?: string;
};

export type SetAgentModeBody = { mode: SessionMode };
export type SetAgentModeResponse = { ok: true; mode: SessionMode };

// Mirrors EffortLevel in lib/server/agent/types.ts (and claude_agent_sdk).
// Duplicated here to avoid client bundles pulling a `server-only` module.
// 'ultracode' = Charon pseudo-effort: xhigh + dynamic-workflow orchestration
// (the Workflow tool on by default). NOT a model `capabilities.effort` level —
// it's applied agent-side via options.settings (§14.56), so it's intentionally
// absent from CANONICAL_EFFORTS (the model-capability baseline) and appended
// explicitly by the picker / isKnownEffort.
export type ClaudeEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

// Canonical fallback effort list, in increasing order. Used by the client
// EffortPicker when no live capability data is available (no API key, alias,
// or custom model id) and server-side as the baseline for `isKnownEffort`.
// The LIVE per-model list comes from the catalog's `capabilities.effort` tree
// (see lib/server/hub/modelSync.ts) — a model may support fewer (Sonnet
// 4.6 has no `xhigh`; Haiku 4.5 has none) or, in future, a brand-new level.
export const CANONICAL_EFFORTS: ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// POST /api/sessions/[id]/model — change the model for ONE session.
// Both fields nullable: null/empty clears back to the global default. Takes
// effect on the next sleep+resume (see /model/route.ts header for why).
export type SetSessionModelBody = {
  model: string | null;
  fallbackModel?: string | null;
};
export type SetSessionModelResponse = { ok: true } | { error: string };

// POST /api/sessions/[id]/effort (effort validity depends on the
// session's kind — Codex efforts are CodexEffortLevel).
/** Native effort level or a validated per-model parameter set (Cursor/endpoints). */
export type SetSessionEffortBody = { effort: string | null };
export type SetSessionEffortResponse = { ok: true } | { error: string };

// GET /api/claude/models — short aliases plus API-discovered concrete models.
export type ClaudeModelGroup = 'aliases' | 'current' | 'previous';
export type KnownClaudeModel = {
  id: string;
  label: string;
  group: ClaudeModelGroup;
  hint?: string;
  // Effort levels this model supports, from the live catalog's
  // `capabilities.effort` tree. Undefined = no live data (alias / no API key /
  // custom id) → the picker falls back to CANONICAL_EFFORTS. An empty array =
  // the catalog says this model has NO effort control (e.g. Haiku 4.5).
  efforts?: string[];
};
// `efforts` (top level) = the global union across all models (∪ canonical),
// used by selects with no model in scope (the SettingsModal global default).
export type ClaudeModelsResponse = { models: KnownClaudeModel[]; efforts: string[] };
// POST /api/claude/models/refresh — forced live sync from GET /v1/models.
export type ClaudeModelsRefreshResponse = {
  ok: boolean;
  count?: number;
  syncedAt?: number;
  error?: string;
  models: KnownClaudeModel[];
  efforts: string[];
};

export type RevertEditBody = {
  filePath: string;
};
export type RevertEditResponse = {
  ok: boolean;
  action?: 'restored' | 'deleted';
  filePath?: string;
  reason?: string;
  error?: string;
};

export type SearchSessionsResult = {
  messageId: number;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  session: AgentSession & { vpsName: string | null };
};
export type SessionSearchResponse = { results: SearchSessionsResult[] };

// Response of DELETE /api/sessions/[id]: permanent deletion
// (DB cascade). Before the kill→delete rework, the `hard` flag distinguished
// soft-kill (status='killed') from hard-delete (cascade). Soft-kill no
// longer exists — DELETE is always destructive.
export type DeleteAgentSessionResponse = { ok: true };

// POST /api/sessions/bulk-delete — the paused-sessions cleanup. Same
// destruction as the DELETE above, N at a time, announced ONCE. `onlyPaused`
// re-checks each row at deletion time: the list the user picked from can be a
// poll old, and a session that woke up since is kept, not deleted.
export type BulkDeleteSessionsBody = { ids: string[]; onlyPaused?: boolean };
export type BulkDeleteSessionsResponse = {
  ok: true;
  deleted: string[];
  /** Already gone (another tab deleted it): nothing to do, drop the row too. */
  missing: string[];
  /** Kept by `onlyPaused`: running again since the list was drawn. */
  notPaused: string[];
  failed: { id: string; error: string }[];
} & ActionSyncStamp;

export type ResumeAgentSessionResponse = {
  ok: true;
  status: WorkerStatus | string;
};

// ── Settings & push ──────────────────────────────────────────────────────────

// Settings: free-form key/value. ALLOWED_KEYS on the server side restricts to
// a fixed set — we type minimally as Record<string, string>.
export type AppSettingsMap = Record<string, string>;

export type PushVapidKeyResponse = { publicKey: string };

export type PushSubscribeBody = {
  preferences?: import('@/lib/notificationPreferences').BrowserNotificationPreferences;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
};
export type PushSubscribeResponse = {
  ok: true;
  id: string;
  updated?: boolean;
};

export type PushUnsubscribeBody = { endpoint: string };

// ── Session attachments ──────────────────────────────────────────────────────
// A file the user dropped on the chat. Charon copies it to the VPS inside the
// session cwd and hands the AGENT nothing but the path — Claude Code's `Read`
// and Codex's `view_image` do the rest. `remotePath` is therefore the payload
// that matters: it is the exact string inserted into the prompt, and the key
// the input bar underlines on.
export type SessionAttachment = {
  id: string;
  // Basename on the VPS (collision-suffixed), also the download filename.
  name: string;
  // Absolute path on the VPS — what goes into the message.
  remotePath: string;
  size: number;
  // Browser-declared MIME, informational only (drives the icon, nothing else).
  mime: string;
  // Content-type the server WILL serve this file with when opened inline, or
  // null when it can only be downloaded. Resolved server-side from the
  // extension against a security allow-list (never from `mime`, which the
  // uploading browser controls) — so the client can show/hide the "open"
  // action without duplicating that table, and can never talk the server into
  // rendering something it wouldn't have. cf. attachmentNames.ts.
  previewMime: string | null;
  createdAt: number;
};
export type SessionAttachmentsResponse = { attachments: SessionAttachment[] };
export type UploadSessionAttachmentResponse = { attachment: SessionAttachment };

// ── Generic response helpers ─────────────────────────────────────────────────

export type OkResponse = { ok: true };
export type OkOrErrorResponse = { ok: boolean; error?: string };

/** Hub-wide unread model releases; revision orders HTTP and SSE snapshots. */
export type ModelNotice = { id: string; label: string };
// Same wire shape as before ({ revision, claude: [], codex: [] }) but DERIVED:
// a new provider gets its bucket without another literal to remember.
export type ModelNoticesResponse =
  { revision: number } & Record<SessionProvider, ModelNotice[]>;
export type MarkModelsSeenBody = { provider: AgentKind; ids: string[] };

export type EndpointProbeBody = { endpoint: import('@/lib/customEndpoints').EndpointInput; engine: import('@/lib/customEndpoints').EndpointEngine; vpsId?: string; sessionId?: string; action?: 'models' | 'test' };
export type EndpointProbeResponse = { ok: boolean; models: import('@/lib/customEndpoints').EndpointModel[]; check?: import('@/lib/customEndpoints').EndpointCheck; catalogError?: string };
export type EndpointSaveBody = { endpoint: import('@/lib/customEndpoints').EndpointInput; id?: string; vpsId?: string };
export type EndpointBatchBody = { vpsId: string; endpointId?: string };
export type EndpointBatch = {
  id: string; vpsId: string; endpointId?: string;
  status: 'preparing' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';
  total: number; completed: number;
  passed: Record<import('@/lib/customEndpoints').EndpointEngine, number>;
  failed: Record<import('@/lib/customEndpoints').EndpointEngine, number>;
  active: { endpointId: string; name: string; model: string; engine: import('@/lib/customEndpoints').EndpointEngine }[];
  error?: string;
};
export type EndpointBatchResponse = { batch: EndpointBatch | null };
export type SessionEndpointBody = { endpoint?: import('@/lib/customEndpoints').EndpointInput | null; saveForReuse?: boolean; cancelPending?: boolean };

/** Workflow output is resolved from the persisted task receipt and native journal. */
// `task` + `agent`: that workflow's node by native id (no label lookup).
export type WorkflowOutputQuery = { task?: string; label?: string; phase?: string; agent?: string; activity?: '1'; before?: number; after?: number; expectedAgent?: string; fileId?: string; cursor?: string };
export type WorkflowOutputResponse =
  | { ok: true; agentId: string; blocks: string[]; entries: import('@/lib/subagentActivity').AgentActivity[]; info?: import('@/lib/subagentActivity').AgentTranscriptInfo; nextBefore: number | null; nextAfter: number; moreAfter: boolean; fileId: string; cursor: string; source: 'workflow_transcript' }
  | { ok: false; error: string; reason?: string };

export type WorkflowAgentsResponse =
  | { ok: true; agents: SessionBackgroundTaskAgent[] }
  | { ok: false; error: string; reason?: string };
