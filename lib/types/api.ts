// Request/response types for `lib/api.ts`.
// Every `api.*` method must have its `XxxBody` / `XxxResponse` pair here.
// Reuse DB types (Vps, ClaudeSession, ...) and protocol types (PermissionMode,
// WorkerStatus) rather than redeclaring them.

import type {
  Vps, VpsFolder, VpsPath, ClaudeSession, ClaudeSessionMessage,
  ClaudePendingPermission, ClaudePendingQuestion, ClaudeSetting,
  ClaudePushSub,
} from '@/lib/db/schema';
import type { PermissionMode, WorkerStatus, AccountUsage } from '@/lib/server/claude/types';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import type { InstallInfo, InstallStatus } from '@/lib/server/install/installSession';

// Re-export so consumers don't have to know the source
export type { Vps, VpsFolder, VpsPath, ClaudeSession, ClaudeSessionMessage,
  ClaudePendingPermission, ClaudePendingQuestion, ClaudeSetting,
  ClaudePushSub, PermissionMode, WorkerStatus, AccountUsage, ShellInfo,
  InstallInfo, InstallStatus };

// Account usage (the `/usage` gauges) for a VPS. `usage` = the Claude account
// (api.anthropic.com/api/oauth/usage); `codexUsage` = the Codex account
// (app-server rate limits), present only when the VPS runs Codex. The header
// shows the one matching the current session's kind. cf. §14.58 / §14.59.
export type VpsUsageResponse = { usage: AccountUsage | null; codexUsage?: AccountUsage | null };

// ── Multi-agent (Claude + Codex) discriminator & Codex config ────────────────
// Duplicated here (not imported from server-only agent/types.ts) to keep client
// bundles clean, mirroring the ClaudeEffortLevel pattern below.
export type AgentKind = 'claude' | 'codex';
// Codex sessions have no interactive human approval; their "mode" is a sandbox
// level (the guardrail). cf. CLAUDE.md §14.59.
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'full-access';
export const CODEX_SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'full-access'];
// Codex reasoning-effort levels (catalog-driven per model). 'ultra' is Codex's
// Workflow-delegation tier (analog of Claude's 'ultracode').
export type CodexEffortLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
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
export type UpdateVpsBody = Partial<CreateVpsBody>;

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
  active: boolean;
};

export type ReorderTabsBody =
  | { scope: 'tabs'; vpsId: string; path: string; ids: string[] }
  | { scope: 'groups'; vpsId: string; paths: string[] }
  | { scope: 'vps'; vpsIds: string[] };

export type TabsResponse = { tabs: TabDTO[] };
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
  /** Only present when the caller asked for git decoration (`withGit`). */
  ignored?: boolean;
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
};

export type FsReadResponse = {
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

export type FsStatResponse = {
  ok: boolean;
  error?: string;
  reason?: 'offline' | 'unsupported' | 'error';
  path?: string;
  exists?: boolean;
  size?: number;
  mtimeNs?: number;
  version?: string | null;
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

// Explorer context menu (agent >= 0.27.0). One route, one shape.
export type FsOpBody = {
  root: string;
  op: 'mkdir' | 'rename' | 'delete';
  path: string;
  /** rename only — the destination, relative to `root`. */
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
};

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
  // format: 'ssh-auth: …' | 'ssh-unreachable: …' | 'daemon-down: …' | 'error: …').
  agentLastError?: string | null;
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
};
export type ScanVpsCodexResponse = { sessions: ScannedCodexSession[] };
/** Either backend's scan row — what ResumeModal actually renders. */
export type ScannedSession = ScannedClaudeSession | ScannedCodexSession;

// ── Claude sessions ──────────────────────────────────────────────────────────

export type ClaudeSessionListQuery = { vpsId?: string; status?: string };

export type SessionListItem = ClaudeSession & {
  liveStatus: WorkerStatus | string;
  subscribers: number;
  pendingPermissions: number;
  firstUserMessage: string | null;
};
export type ClaudeSessionsListResponse = {
  sessions: SessionListItem[];
  // Live staleness baselines (hub pyz sha + PyPI latests) — refreshed by the
  // client on every list poll so long-open tabs never compare against frozen
  // SSR props (phantom "update agent" badge). Optional: older servers omit it.
  meta?: {
    builtPyzSha: string | null;
    // `__version__` of the pyz this hub ships — THE staleness baseline (§14.6).
    builtAgentVersion?: string | null;
    sdkLatestVersion: string | null;
    codexLatestVersion: string | null;
  };
};

export type PendingPermissionPayload = {
  id: string;
  tool: string;
  input: unknown;
  createdAt: number;
};
export type PendingQuestionPayload = {
  id: string;
  questions: unknown[];
  createdAt: number;
};
export type PendingExitPlanPayload = {
  id: string;
  plan: string;
  createdAt: number;
};

export type ClaudeSessionDetailResponse = {
  session: ClaudeSession;
  liveStatus: WorkerStatus | string;
  subscribers: number;
  // Window of the last `limit` "chat" messages (user/assistant/tool_use/
  // tool_result/user_question/exit_plan_request/thinking) + all the
  // edit_snapshot and event entries in the same ID range (cf. backend
  // loadMessageWindow). Sorted asc by id.
  messages: ClaudeSessionMessage[];
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
  // Model id Anthropic actually used on the last AssistantMessage (agent
  // >= 0.6.0). Null when no turn has happened since attach OR the agent is
  // too old to emit `effective_model`. The UI shows it in the badge so the
  // user has a reliable source of truth — independent of the LLM's
  // self-identification (which is famously unreliable, training cutoff).
  effectiveModel?: string | null;
  pendingPermissions: PendingPermissionPayload[];
  pendingQuestions: PendingQuestionPayload[];
  pendingExitPlans: PendingExitPlanPayload[];
};

// loadMore response (GET ...?before=<id>) — same shape on the server side as
// ClaudeSessionDetailResponse but we only use the messages window to extend
// history on the client side. (The other fields are still populated by the
// route to stay typed; the client ignores them.)
export type ClaudeSessionMessageWindow = {
  messages: ClaudeSessionMessage[];
  hasMore: boolean;
  oldestChatId: number | null;
};

// GET /api/claude/sessions/[id]/edits — lazy diff-content fetch.
//
// The main session GET strips edit_snapshot `content` because it is re-fetched
// in a 5s loop (a large session's full snapshots = tens of MB per fetch, which
// got the VPS suspended for egress — cf. CLAUDE.md §14 gotcha 41). This
// endpoint serves the LATEST before/after content per modified file, once per
// session view, so the ToolPanel diffs tab still works. `before == null` means
// a new file (Write); `after == null` means a deletion / budget-dropped file.
export type ClaudeEditContent = {
  filePath: string;
  toolUseId: string;
  before: string | null;
  after: string | null;
  truncated: boolean;
};
export type ClaudeSessionEditsResponse = {
  edits: ClaudeEditContent[];
  // True if total content exceeded the server budget and some files' content
  // was omitted (before/after null, truncated true).
  truncatedList: boolean;
};

export type CreateClaudeSessionBody = {
  vpsId: string;
  cwd: string;
  name?: string | null;
  // 'claude' (default) | 'codex'. Determines the backend + config semantics.
  kind?: AgentKind;
  // Claude: 'normal'|'acceptEdits'|'auto'|'plan'. Codex: a CodexSandboxMode.
  permissionMode?: PermissionMode | CodexSandboxMode;
  // Per-session config. Pass null/omit to inherit the global defaults
  // (claude.default_* / codex.default_*). Effort validity depends on kind;
  // invalid values are silently dropped server-side.
  model?: string | null;
  fallbackModel?: string | null;   // Claude only (Codex ignores it)
  effort?: string | null;
};
export type CreateClaudeSessionResponse = {
  id: string;
  kind: AgentKind;
  status: WorkerStatus | string;
  claudeSessionId: string | null;
  vpsId: string;
  cwd: string;
  name: string | null;
  permissionMode: PermissionMode | CodexSandboxMode;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
};

export type ImportClaudeSessionBody = {
  vpsId: string;
  // Claude: the SDK session uuid. Codex: the thread id (§14.59).
  claudeSessionId: string;
  cwd: string;
  name?: string | null;
  kind?: AgentKind;
  // Claude: a PermissionMode. Codex: a CodexSandboxMode.
  permissionMode?: PermissionMode | CodexSandboxMode;
};
export type ImportClaudeSessionResponse = {
  id: string;
  messagesImported: number;
  importError?: string;
};

export type RenameClaudeSessionBody = {
  name?: string | null;
  color?: string | null;
  cwd?: string;
};

export type SendClaudeInputBody = { content: string };
// The /input endpoint also accepts `{ type: 'interrupt' }` — modelled as a
// union to stay typed. `interruptClaude` sends the 2nd branch.
export type ClaudeInputBody = SendClaudeInputBody | { type: 'interrupt' };

export type RespondPermissionBody = {
  id: string;
  allow: boolean;
  always?: boolean;
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

export type SetClaudeModeBody = { mode: PermissionMode | CodexSandboxMode };
export type SetClaudeModeResponse = { ok: true; mode: PermissionMode | CodexSandboxMode };

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
// (see lib/server/claude/modelSync.ts) — a model may support fewer (Sonnet
// 4.6 has no `xhigh`; Haiku 4.5 has none) or, in future, a brand-new level.
export const CANONICAL_EFFORTS: ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// POST /api/claude/sessions/[id]/model — change the model for ONE session.
// Both fields nullable: null/empty clears back to the global default. Takes
// effect on the next sleep+resume (see /model/route.ts header for why).
export type SetClaudeSessionModelBody = {
  model: string | null;
  fallbackModel?: string | null;
};
export type SetClaudeSessionModelResponse = { ok: true } | { error: string };

// POST /api/claude/sessions/[id]/effort (effort validity depends on the
// session's kind — Codex efforts are CodexEffortLevel).
export type SetClaudeSessionEffortBody = { effort: ClaudeEffortLevel | CodexEffortLevel | null };
export type SetClaudeSessionEffortResponse = { ok: true } | { error: string };

// GET /api/claude/models — curated picker source. Source of truth lives in
// lib/server/claude/knownModels.ts (single hand-curated list, see header
// there for why no autodiscovery).
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

export type RevertClaudeEditBody = {
  filePath: string;
  content: string | null;
};
export type RevertClaudeEditResponse = {
  ok: boolean;
  code?: number;
  stderr: string;
};

export type SearchClaudeResult = {
  messageId: number;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  session: ClaudeSession & { vpsName: string | null };
};
export type SearchClaudeResponse = { results: SearchClaudeResult[] };

// Response of DELETE /api/claude/sessions/[id]: permanent deletion
// (DB cascade). Before the kill→delete rework, the `hard` flag distinguished
// soft-kill (status='killed') from hard-delete (cascade). Soft-kill no
// longer exists — DELETE is always destructive.
export type DeleteClaudeSessionResponse = { ok: true };

export type ResumeClaudeSessionResponse = {
  ok: true;
  status: WorkerStatus | string;
};

// ── Settings & push ──────────────────────────────────────────────────────────

// Settings: free-form key/value. ALLOWED_KEYS on the server side restricts to
// a fixed set — we type minimally as Record<string, string>.
export type ClaudeSettingsMap = Record<string, string>;

export type PushVapidKeyResponse = { publicKey: string };

export type PushSubscribeBody = {
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
