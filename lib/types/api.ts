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
  // claude-agent-sdk version confirmed in the venv by the unified update
  // (null when the SDK sub-step failed — the pyz update may still be ok).
  sdkVersion?: string | null;
  builtPyzSha: string;
  detail: string;
};

export type RefreshVpsAgentResponse = {
  ok: boolean;
  agentStatus: 'ok' | 'missing' | 'error' | 'unknown';
  agentVersion?: string | null;
  agentPyzSha?: string | null;
  error?: string;
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
  permissionMode?: PermissionMode;
  // Per-session Claude config. Pass null/omit to inherit the global defaults
  // (claudeSettings.claude.default_*). Effort must be a ClaudeEffortLevel or
  // omitted; invalid values are silently dropped server-side.
  model?: string | null;
  fallbackModel?: string | null;
  effort?: string | null;
};
export type CreateClaudeSessionResponse = {
  id: string;
  status: WorkerStatus | string;
  claudeSessionId: string | null;
  vpsId: string;
  cwd: string;
  name: string | null;
  permissionMode: PermissionMode;
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
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

// POST /api/claude/sessions/[id]/effort
export type SetClaudeSessionEffortBody = { effort: ClaudeEffortLevel | null };
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

// ── Generic response helpers ─────────────────────────────────────────────────

export type OkResponse = { ok: true };
export type OkOrErrorResponse = { ok: boolean; error?: string };
