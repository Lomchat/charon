// Request/response types for `lib/api.ts`.
// Every `api.*` method must have its `XxxBody` / `XxxResponse` pair here.
// Reuse DB types (Vps, ClaudeSession, ...) and protocol types (PermissionMode,
// WorkerStatus) rather than redeclaring them.

import type {
  Vps, VpsFolder, VpsPath, ClaudeSession, ClaudeSessionMessage,
  ClaudePendingPermission, ClaudePendingQuestion, ClaudeSetting,
  ClaudePushSub,
} from '@/lib/db/schema';
import type { PermissionMode, WorkerStatus } from '@/lib/server/claude/types';
import type { ShellInfo } from '@/lib/server/shell/shellSession';
import type { InstallInfo, InstallStatus } from '@/lib/server/install/installSession';

// Re-export so consumers don't have to know the source
export type { Vps, VpsFolder, VpsPath, ClaudeSession, ClaudeSessionMessage,
  ClaudePendingPermission, ClaudePendingQuestion, ClaudeSetting,
  ClaudePushSub, PermissionMode, WorkerStatus, ShellInfo,
  InstallInfo, InstallStatus };

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

export type UpdateVpsAgentResponse = {
  ok: boolean;
  error?: string;
  newVersion?: string | null;
  newPyzSha?: string | null;
  builtPyzSha: string;
  detail: string;
};

export type LocalAgentStatus = {
  installed: boolean;
  deployedPyzSha: string | null;
  builtPyzSha: string | null;
  outOfDate: boolean;
  serviceActive: boolean | null;
};

// ── Shells ───────────────────────────────────────────────────────────────────

export type ShellsListResponse = { shells: ShellInfo[] };
export type StartShellBody = { cwd?: string | null };
export type UpdateShellBody = { name?: string | null; color?: string | null };

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

// ── Claude sessions ──────────────────────────────────────────────────────────

export type ClaudeSessionListQuery = { vpsId?: string; status?: string };

export type SessionListItem = ClaudeSession & {
  liveStatus: WorkerStatus | string;
  subscribers: number;
  pendingPermissions: number;
  firstUserMessage: string | null;
};
export type ClaudeSessionsListResponse = { sessions: SessionListItem[] };

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

export type CreateClaudeSessionBody = {
  vpsId: string;
  cwd: string;
  name?: string | null;
  permissionMode?: PermissionMode;
};
export type CreateClaudeSessionResponse = {
  id: string;
  status: WorkerStatus | string;
  claudeSessionId: string | null;
  vpsId: string;
  cwd: string;
  name: string | null;
  permissionMode: PermissionMode;
};

export type ImportClaudeSessionBody = {
  vpsId: string;
  claudeSessionId: string;
  cwd: string;
  name?: string | null;
  permissionMode?: PermissionMode;
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

export type SetClaudeModeBody = { mode: PermissionMode };
export type SetClaudeModeResponse = { ok: true; mode: PermissionMode };

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

// ── Generic response helpers ─────────────────────────────────────────────────

export type OkResponse = { ok: true };
export type OkOrErrorResponse = { ok: boolean; error?: string };
