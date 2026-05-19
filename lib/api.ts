// Client HTTP typé pour les routes API du dashboard.
// Pour les shapes : cf. lib/types/api.ts. Toute nouvelle méthode doit avoir
// son couple `XxxBody` / `XxxResponse` déclaré là-bas, puis typer le retour
// ici via `send<TRes>()`.

import type {
  Vps, VpsFolder, VpsPath, ClaudeSession, PermissionMode, ShellInfo,
  CreateVpsBody, UpdateVpsBody, TestVpsResponse, UpdateVpsAgentResponse,
  CreateVpsFolderBody, UpdateVpsFolderBody, VpsLayoutBody, VpsLayoutResponse,
  LocalAgentStatus,
  ShellsListResponse, StartShellBody, UpdateShellBody,
  CreateVpsPathBody, UpdateVpsPathBody,
  ClaudeCheckResponse, SetupVpsClaudeResponse, ScanVpsClaudeResponse,
  ClaudeSessionListQuery, ClaudeSessionsListResponse,
  ClaudeSessionDetailResponse,
  CreateClaudeSessionBody, CreateClaudeSessionResponse,
  ImportClaudeSessionBody, ImportClaudeSessionResponse,
  RenameClaudeSessionBody,
  KillClaudeSessionResponse, ResumeClaudeSessionResponse,
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
    // Essaie de récupérer le body pour afficher le vrai détail dans le toast,
    // pas juste "→ 500". Fallback gracieux si le body n'est pas du JSON.
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

  // ── Shells SSH (éphémères, multi par VPS) ──────────────────────────────────
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

  // ── VPS folders (organisation sidebar) ─────────────────────────────────────
  listVpsFolders: () =>
    send<{ folders: VpsFolder[] }>('GET', '/api/vps-folders'),
  createVpsFolder: (data: CreateVpsFolderBody) =>
    send<VpsFolder>('POST', '/api/vps-folders', data),
  updateVpsFolder: (id: string, data: UpdateVpsFolderBody) =>
    send<VpsFolder>('PATCH', `/api/vps-folders/${id}`, data),
  deleteVpsFolder: (id: string) =>
    send<OkResponse>('DELETE', `/api/vps-folders/${id}`),
  // Re-layout atomique : positions des dossiers + (folderId, position) des VPS.
  // L'UI envoie l'état complet désiré après un drag-end.
  applyVpsLayout: (data: VpsLayoutBody) =>
    send<VpsLayoutResponse>('POST', '/api/vps-folders/layout', data),

  // ── VPS paths (cwd connus par VPS) ─────────────────────────────────────────
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
  createClaudeSession: (data: CreateClaudeSessionBody) =>
    send<CreateClaudeSessionResponse>('POST', '/api/claude/sessions', data),
  importClaudeSession: (data: ImportClaudeSessionBody) =>
    send<ImportClaudeSessionResponse>('POST', '/api/claude/sessions/import', data),
  killClaudeSession: (id: string) =>
    send<KillClaudeSessionResponse>('DELETE', `/api/claude/sessions/${id}`),
  hardDeleteClaudeSession: (id: string) =>
    send<KillClaudeSessionResponse>('DELETE', `/api/claude/sessions/${id}?hard=1`),
  renameClaudeSession: (id: string, name: string | null) =>
    send<ClaudeSession>('PATCH', `/api/claude/sessions/${id}`, { name } as RenameClaudeSessionBody),
  // Sleep / resume / input / interrupt / force-stop : tous renvoient { ok: true }
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
  // Réponses aux interactions
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
  // updateClaudeSettings accepte des paires clé/valeur arbitraires (filtrées
  // côté serveur par ALLOWED_KEYS). On reste libre côté client.
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
