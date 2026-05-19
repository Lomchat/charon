// Types request/response pour `lib/api.ts`.
// Toute méthode `api.*` doit avoir son couple `XxxBody` / `XxxResponse` ici.
// Réutilise les types DB (Vps, ClaudeSession, …) et protocole (PermissionMode,
// WorkerStatus) plutôt que de les redéclarer.

import type {
  Vps, VpsFolder, VpsPath, ClaudeSession, ClaudeSessionMessage,
  ClaudePendingPermission, ClaudePendingQuestion, ClaudeSetting,
  ClaudePushSub,
} from '@/lib/db/schema';
import type { PermissionMode, WorkerStatus } from '@/lib/server/claude/types';
import type { ShellInfo } from '@/lib/server/shell/shellSession';

// Ré-export pour que les consommateurs n'aient pas à connaître la source
export type { Vps, VpsFolder, VpsPath, ClaudeSession, ClaudeSessionMessage,
  ClaudePendingPermission, ClaudePendingQuestion, ClaudeSetting,
  ClaudePushSub, PermissionMode, WorkerStatus, ShellInfo };

// ── VPS ──────────────────────────────────────────────────────────────────────

export type CreateVpsBody = {
  name: string;
  ip: string;
  sshUser: string;
  sshPort?: number;
  defaultPath?: string | null;
  // Dossier dans lequel placer le nouveau VPS. Si omis, le serveur l'assigne
  // au premier dossier (par position) — typiquement le dossier 'default'.
  folderId?: string | null;
};
export type UpdateVpsBody = Partial<CreateVpsBody>;

// ── VPS folders ──────────────────────────────────────────────────────────────

export type CreateVpsFolderBody = {
  name: string;
  // Position absolue dans la liste. Si omise, append à la fin.
  position?: number;
};
export type UpdateVpsFolderBody = {
  name?: string;
  collapsed?: boolean;
};
// Re-layout atomique : positions de tous les folders + assignment+position de
// tous les VPS. Le serveur l'applique en transaction. Le client envoie tout
// l'état désiré après un drag-end.
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
  messages: ClaudeSessionMessage[];
  streamingText: string;
  pendingPermissions: PendingPermissionPayload[];
  pendingQuestions: PendingQuestionPayload[];
  pendingExitPlans: PendingExitPlanPayload[];
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
// L'endpoint /input accepte aussi `{ type: 'interrupt' }` — modélisé comme
// union pour rester typé. `interruptClaude` envoie la 2e branche.
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

export type KillClaudeSessionResponse = { ok: true; hard: boolean };

export type ResumeClaudeSessionResponse = {
  ok: true;
  status: WorkerStatus | string;
};

// ── Settings & push ──────────────────────────────────────────────────────────

// Settings : clé/valeur libre. ALLOWED_KEYS côté serveur restreint à un set
// fixe — on type au minimum comme Record<string, string>.
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

// ── Helpers de réponse génériques ────────────────────────────────────────────

export type OkResponse = { ok: true };
export type OkOrErrorResponse = { ok: boolean; error?: string };
