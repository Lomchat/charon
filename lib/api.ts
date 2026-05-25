// Typed HTTP client for the dashboard's API routes.
// For shapes: cf. lib/types/api.ts. Every new method must have its
// `XxxBody` / `XxxResponse` pair declared there, then type the return
// here via `send<TRes>()`.

import type {
  Vps, VpsFolder, VpsPath, ClaudeSession, PermissionMode, ShellInfo,
  CreateVpsBody, UpdateVpsBody, TestVpsResponse, UpdateVpsAgentResponse,
  CreateVpsFolderBody, UpdateVpsFolderBody, VpsLayoutBody, VpsLayoutResponse,
  LocalAgentStatus,
  ShellsListResponse, StartShellBody, UpdateShellBody,
  InstallInfo, InstallsListResponse, VpsInstallResponse,
  CreateVpsPathBody, UpdateVpsPathBody,
  ClaudeCheckResponse, SetupVpsClaudeResponse, ScanVpsClaudeResponse,
  CheckClaudeLoginResponse,
  ClaudeSessionListQuery, ClaudeSessionsListResponse,
  ClaudeSessionDetailResponse, ClaudeSessionMessageWindow,
  CreateClaudeSessionBody, CreateClaudeSessionResponse,
  ImportClaudeSessionBody, ImportClaudeSessionResponse,
  RenameClaudeSessionBody,
  DeleteClaudeSessionResponse, ResumeClaudeSessionResponse,
  RespondPermissionBody, RespondQuestionBody, RespondExitPlanBody,
  SetClaudeModeResponse,
  RevertClaudeEditResponse, SearchClaudeResponse,
  ClaudeSettingsMap, PushVapidKeyResponse, PushSubscribeBody,
  PushSubscribeResponse,
  OkResponse, OkOrErrorResponse,
} from '@/lib/types/api';

async function send<TRes = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<TRes> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Try to recover the body to display the real detail in the toast,
    // not just "→ 500". Graceful fallback if the body isn't JSON.
    let detail = '';
    try {
      const txt = await res.text();
      try {
        const j = JSON.parse(txt);
        detail = j?.error || j?.detail || txt;
      } catch {
        detail = txt;
      }
    } catch {}
    const trimmed = String(detail).slice(0, 400);
    throw new Error(`${method} ${path} → ${res.status}${trimmed ? ': ' + trimmed : ''}`);
  }
  if (res.status === 204) return null as TRes;
  return (await res.json()) as TRes;
}

export const api = {
  // ── VPS ────────────────────────────────────────────────────────────────────
  createVps: (data: CreateVpsBody) =>
    send<Vps>('POST', '/api/vps', data),
  updateVps: (id: string, data: UpdateVpsBody) =>
    send<Vps>('PATCH', `/api/vps/${id}`, data),
  deleteVps: (id: string) =>
    send<OkResponse>('DELETE', `/api/vps/${id}`),
  testVps: (id: string) =>
    send<TestVpsResponse>('POST', `/api/vps/${id}/test`),
  updateVpsAgent: (id: string) =>
    send<UpdateVpsAgentResponse>('POST', `/api/vps/${id}/agent/update`),
  getLocalAgentStatus: () =>
    send<LocalAgentStatus>('GET', '/api/local-agent/status'),
  updateLocalAgent: () =>
    send<UpdateVpsAgentResponse>('POST', '/api/local-agent/update'),

  // ── Agent installs (ephemeral, in-memory, 1 per VPS max) ───────────────────
  listInstalls: () =>
    send<InstallsListResponse>('GET', '/api/installs'),
  getInstall: (id: string) =>
    send<InstallInfo>('GET', `/api/installs/${id}`),
  getVpsInstall: (vpsId: string) =>
    send<VpsInstallResponse>('GET', `/api/vps/${vpsId}/installs`),
  startInstall: (vpsId: string) =>
    send<InstallInfo>('POST', `/api/vps/${vpsId}/installs`),
  retryInstall: (id: string) =>
    send<InstallInfo>('POST', `/api/installs/${id}/retry`),
  closeInstall: (id: string) =>
    send<OkResponse>('DELETE', `/api/installs/${id}`),

  // ── SSH shells (ephemeral, multiple per VPS) ───────────────────────────────
  listShells: () =>
    send<ShellsListResponse>('GET', '/api/shells'),
  listVpsShells: (vpsId: string) =>
    send<ShellsListResponse>('GET', `/api/vps/${vpsId}/shells`),
  startShell: (vpsId: string, cwd?: string | null) =>
    send<ShellInfo>('POST', `/api/vps/${vpsId}/shells`, { cwd: cwd ?? null } as StartShellBody),
  updateShell: (shellId: string, data: UpdateShellBody) =>
    send<ShellInfo>('PATCH', `/api/shells/${shellId}`, data),
  killShell: (shellId: string) =>
    send<OkResponse>('DELETE', `/api/shells/${shellId}`),

  // ── VPS folders (sidebar organization) ─────────────────────────────────────
  listVpsFolders: () =>
    send<{ folders: VpsFolder[] }>('GET', '/api/vps-folders'),
  createVpsFolder: (data: CreateVpsFolderBody) =>
    send<VpsFolder>('POST', '/api/vps-folders', data),
  updateVpsFolder: (id: string, data: UpdateVpsFolderBody) =>
    send<VpsFolder>('PATCH', `/api/vps-folders/${id}`, data),
  deleteVpsFolder: (id: string) =>
    send<OkResponse>('DELETE', `/api/vps-folders/${id}`),
  // Atomic re-layout: folder positions + (folderId, position) of VPSes.
  // The UI sends the complete desired state after a drag-end.
  applyVpsLayout: (data: VpsLayoutBody) =>
    send<VpsLayoutResponse>('POST', '/api/vps-folders/layout', data),

  // ── VPS paths (known cwd per VPS) ──────────────────────────────────────────
  listVpsPaths: () =>
    send<VpsPath[]>('GET', '/api/vps-paths'),
  createVpsPath: (data: CreateVpsPathBody) =>
    send<VpsPath>('POST', '/api/vps-paths', data),
  updateVpsPath: (id: number, data: UpdateVpsPathBody) =>
    send<VpsPath>('PATCH', `/api/vps-paths/${id}`, data),
  deleteVpsPath: (id: number) =>
    send<OkResponse>('DELETE', `/api/vps-paths/${id}`),
  checkVpsClaude: (id: string) =>
    send<ClaudeCheckResponse>('GET', `/api/vps/${id}/claude/check`),
  setupVpsClaude: (id: string) =>
    send<SetupVpsClaudeResponse>('POST', `/api/vps/${id}/claude/setup`),
  scanVpsClaude: (id: string) =>
    send<ScanVpsClaudeResponse>('GET', `/api/vps/${id}/claude/scan`),
  // Re-checks the VPS's `claude login` state. Persists in DB + returns.
  // Triggered when the LoginConsole closes (the user may have just logged
  // in or out), or on manual demand.
  checkVpsClaudeLogin: (id: string) =>
    send<CheckClaudeLoginResponse>('POST', `/api/vps/${id}/claude/check-login`),
  bootstrapVpsUrl: (id: string) => `/api/vps/${id}/claude/bootstrap`,

  // ── Claude sessions ───────────────────────────────────────────────────────
  listClaudeSessions: (q?: ClaudeSessionListQuery) => {
    const p = new URLSearchParams();
    if (q?.vpsId) p.set('vpsId', q.vpsId);
    if (q?.status) p.set('status', q.status);
    const qs = p.toString();
    return send<ClaudeSessionsListResponse>('GET', `/api/claude/sessions${qs ? '?' + qs : ''}`);
  },
  getClaudeSession: (id: string) =>
    send<ClaudeSessionDetailResponse>('GET', `/api/claude/sessions/${id}`),
  // Loads a window of older chat messages (scroll-up pagination).
  // The cursor is the `oldestChatId` returned by the previous response.
  // Reuses the same endpoint as getClaudeSession with `?before=<id>` — the
  // response contains the same fields but the client only uses
  // messages/hasMore/oldestChatId to extend history. Server cap 1000.
  loadOlderClaudeMessages: (id: string, before: number, limit = 200) => {
    const p = new URLSearchParams();
    p.set('before', String(before));
    p.set('limit', String(limit));
    return send<ClaudeSessionMessageWindow>('GET', `/api/claude/sessions/${id}?${p.toString()}`);
  },
  // Delta poll: returns ONLY messages whose id > `since` (chat + snapshots),
  // plus the live session state (liveStatus, streamingText, pendings).
  // Used as the safety-net polling loop in useClaudeSessionStream — no
  // matter what state the SSE + React tree are in, every ~5s we ask the
  // server "anything new since id X?" and append the delta if any. The
  // response shape matches the full GET (ClaudeSessionDetailResponse) so
  // we can reuse it; `messages` here is the delta, not a window.
  pollClaudeSessionSince: (id: string, since: number) => {
    const p = new URLSearchParams();
    p.set('since', String(since));
    return send<ClaudeSessionDetailResponse>('GET', `/api/claude/sessions/${id}?${p.toString()}`);
  },
  createClaudeSession: (data: CreateClaudeSessionBody) =>
    send<CreateClaudeSessionResponse>('POST', '/api/claude/sessions', data),
  importClaudeSession: (data: ImportClaudeSessionBody) =>
    send<ImportClaudeSessionResponse>('POST', '/api/claude/sessions/import', data),
  // Permanent deletion: kill agent + DB cascade. No more soft-kill.
  // The caller must have confirmed on the UI side (`confirm()`) — no
  // shortcut button without a warning.
  deleteClaudeSession: (id: string) =>
    send<DeleteClaudeSessionResponse>('DELETE', `/api/claude/sessions/${id}`),
  renameClaudeSession: (id: string, name: string | null) =>
    send<ClaudeSession>('PATCH', `/api/claude/sessions/${id}`, { name } as RenameClaudeSessionBody),
  // Sleep / resume / input / interrupt / force-stop: all return { ok: true }
  sleepClaudeSession: (id: string) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/sleep`),
  resumeClaudeSession: (id: string) =>
    send<ResumeClaudeSessionResponse>('POST', `/api/claude/sessions/${id}/resume`),
  sendClaudeInput: (id: string, content: string) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/input`, { content }),
  interruptClaude: (id: string) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/input`, { type: 'interrupt' }),
  forceStopClaude: (id: string) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/force-stop`),
  // Responses to interactions
  respondClaudePermission: (id: string, permId: string, allow: boolean, always = false) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/permission`, { id: permId, allow, always } as RespondPermissionBody),
  respondClaudeQuestion: (id: string, qid: string, answers: Record<string, string> | null) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/question`, { id: qid, answers } as RespondQuestionBody),
  respondClaudeExitPlan: (id: string, qid: string, decision: 'approve' | 'reject', feedback?: string) =>
    send<OkResponse>('POST', `/api/claude/sessions/${id}/exit-plan`, { id: qid, decision, feedback } as RespondExitPlanBody),
  setClaudeMode: (id: string, mode: PermissionMode) =>
    send<SetClaudeModeResponse>('POST', `/api/claude/sessions/${id}/mode`, { mode }),
  revertClaudeEdit: (id: string, filePath: string, content: string | null) =>
    send<RevertClaudeEditResponse>('POST', `/api/claude/sessions/${id}/revert`, { filePath, content }),
  searchClaude: (q: string) =>
    send<SearchClaudeResponse>('GET', `/api/claude/search?q=${encodeURIComponent(q)}`),

  // ── Settings & push ───────────────────────────────────────────────────────
  getClaudeSettings: () =>
    send<ClaudeSettingsMap>('GET', '/api/claude/settings'),
  // updateClaudeSettings accepts arbitrary key/value pairs (filtered on the
  // server side by ALLOWED_KEYS). We stay free on the client side.
  updateClaudeSettings: (data: Record<string, string>) =>
    send<ClaudeSettingsMap>('POST', '/api/claude/settings', data),
  testTelegram: () =>
    send<OkOrErrorResponse>('POST', '/api/claude/telegram/test'),
  pushVapidKey: () =>
    send<PushVapidKeyResponse>('GET', '/api/claude/push/key'),
  pushSubscribe: (data: PushSubscribeBody) =>
    send<PushSubscribeResponse>('POST', '/api/claude/push/subscribe', data),
  pushUnsubscribe: (endpoint: string) =>
    send<OkResponse>('POST', '/api/claude/push/unsubscribe', { endpoint }),
};
