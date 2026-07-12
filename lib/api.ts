// Typed HTTP client for the dashboard's API routes.
// For shapes: cf. lib/types/api.ts. Every new method must have its
// `XxxBody` / `XxxResponse` pair declared there, then type the return
// here via `send<TRes>()`.

import type {
  Vps, VpsFolder, VpsPath, ClaudeSession, PermissionMode, ShellInfo,
  CreateVpsBody, UpdateVpsBody, TestVpsResponse, UpdateVpsAgentResponse,
  RefreshVpsAgentResponse,
  CreateVpsFolderBody, UpdateVpsFolderBody, VpsLayoutBody, VpsLayoutResponse,
  LocalAgentStatus,
  ShellsListResponse, StartShellBody, UpdateShellBody,
  InstallInfo, InstallsListResponse, VpsInstallResponse,
  CreateVpsPathBody, UpdateVpsPathBody,
  ClaudeCheckResponse, SetupVpsClaudeResponse, ScanVpsClaudeResponse,
  CheckClaudeLoginResponse,
  ClaudeSessionListQuery, ClaudeSessionsListResponse,
  ClaudeSessionDetailResponse, ClaudeSessionMessageWindow,
  ClaudeSessionEditsResponse,
  CreateClaudeSessionBody, CreateClaudeSessionResponse,
  ImportClaudeSessionBody, ImportClaudeSessionResponse,
  RenameClaudeSessionBody,
  DeleteClaudeSessionResponse, ResumeClaudeSessionResponse,
  RespondPermissionBody, RespondQuestionBody, RespondExitPlanBody,
  SetClaudeModeResponse,
  SetClaudeSessionModelBody, SetClaudeSessionModelResponse,
  SetClaudeSessionEffortBody, SetClaudeSessionEffortResponse,
  ClaudeEffortLevel, ClaudeModelsResponse, ClaudeModelsRefreshResponse,
  RevertClaudeEditResponse, SearchClaudeResponse,
  ClaudeSettingsMap, PushVapidKeyResponse, PushSubscribeBody,
  PushSubscribeResponse,
  OkResponse, OkOrErrorResponse,
} from '@/lib/types/api';

async function send<TRes = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<TRes> {
  // Bound EVERY request with a timeout. Without this, a fetch issued just
  // before the device sleeps (laptop lid, mobile background) hangs forever
  // — the socket is suspended, not closed, so the promise neither resolves
  // nor rejects until the OS finally tears the socket down (can be
  // minutes). A hung promise wedges any inflight-dedup guard built on top
  // of it (sessionCache.inflight, useClaudeSessionStream.inflightPollRef),
  // which is exactly the "chat frozen until refresh" class of bug.
  // cf. CLAUDE.md §14 gotcha 24.
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const ac = new AbortController();
  const onExternalAbort = () => ac.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }
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
    // The unified update now includes `pip install -U claude-agent-sdk` in
    // the VPS venv (1-3 min on a slow box, wheel download included) on top
    // of the pyz redeploy + restart — way past the default 30s timeout.
    // NOTE: a reverse-proxy ProxyTimeout shorter than this can still 502
    // the response; the flow completes server-side and the badge self-heals
    // via the next vps_status hello.
    send<UpdateVpsAgentResponse>('POST', `/api/vps/${id}/agent/update`, undefined, { timeoutMs: 360_000 }),
  refreshVpsAgent: (id: string) =>
    // Can take up to ~40s in the worst case (reconnect → start daemon →
    // reconnect), so override the default 30s client timeout.
    send<RefreshVpsAgentResponse>('POST', `/api/vps/${id}/agent/refresh`, undefined, { timeoutMs: 50_000 }),
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

  // ── SSH shells (persistent, multiple per VPS) ──────────────────────────────
  listShells: () =>
    send<ShellsListResponse>('GET', '/api/shells'),
  listVpsShells: (vpsId: string) =>
    send<ShellsListResponse>('GET', `/api/vps/${vpsId}/shells`),
  // `opts.cwd` blank/omitted → the shell opens in the SSH user's home; `name`
  // is the optional sidebar label (settable later via the context menu too).
  startShell: (vpsId: string, opts?: { cwd?: string | null; name?: string | null }) =>
    send<ShellInfo>('POST', `/api/vps/${vpsId}/shells`, {
      cwd: opts?.cwd ?? null,
      name: opts?.name ?? null,
    } as StartShellBody),
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
  pollClaudeSessionSince: (id: string, since: number, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    p.set('since', String(since));
    // Shorter timeout than the default: polling is a frequent background
    // op, we'd rather abort a slow one and retry on the next 5s tick than
    // let it pile up.
    return send<ClaudeSessionDetailResponse>(
      'GET', `/api/claude/sessions/${id}?${p.toString()}`,
      undefined, { signal, timeoutMs: 12_000 },
    );
  },
  // Lazily fetch the latest before/after diff content per modified file. The
  // main session GET strips edit_snapshot content (it's re-fetched in a 5s
  // loop — cf. CLAUDE.md §14 gotcha 41); this serves the diff content on
  // demand, once per session view. Called by useClaudeSessionStream's
  // auto-load effect when the edits Map has files with stripped content.
  getClaudeSessionEdits: (id: string) =>
    send<ClaudeSessionEditsResponse>('GET', `/api/claude/sessions/${id}/edits`),
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
  // Per-session model / effort. Both take effect on next sleep+resume — the
  // UI should label "applied at next start" until then. Passing null clears
  // back to the global default (cf. SettingsModal § Claude defaults).
  setClaudeSessionModel: (id: string, model: string | null, fallbackModel: string | null = null) =>
    send<SetClaudeSessionModelResponse>('POST', `/api/claude/sessions/${id}/model`,
      { model, fallbackModel } as SetClaudeSessionModelBody),
  setClaudeSessionEffort: (id: string, effort: ClaudeEffortLevel | null) =>
    send<SetClaudeSessionEffortResponse>('POST', `/api/claude/sessions/${id}/effort`,
      { effort } as SetClaudeSessionEffortBody),
  // Curated list of model IDs (server-side source of truth in
  // lib/server/claude/knownModels.ts). Cached aggressively client-side via
  // the module-level cache in app/modelsCache.ts.
  getClaudeModels: () =>
    send<ClaudeModelsResponse>('GET', '/api/claude/models'),
  refreshClaudeModels: () =>
    send<ClaudeModelsRefreshResponse>('POST', '/api/claude/models/refresh'),
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
