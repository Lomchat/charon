async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  // VPS
  createVps: (data: any) => send('POST', '/api/vps', data),
  updateVps: (id: string, data: any) => send('PATCH', `/api/vps/${id}`, data),
  deleteVps: (id: string) => send('DELETE', `/api/vps/${id}`),
  testVps: (id: string) => send('POST', `/api/vps/${id}/test`),

  // VPS paths (paths connus par VPS, avec label optionnel)
  listVpsPaths: () => send('GET', '/api/vps-paths'),
  createVpsPath: (data: { vpsId: string; path: string; label?: string | null }) =>
    send('POST', '/api/vps-paths', data),
  updateVpsPath: (id: number, data: { path?: string; label?: string | null }) =>
    send('PATCH', `/api/vps-paths/${id}`, data),
  deleteVpsPath: (id: number) => send('DELETE', `/api/vps-paths/${id}`),
  checkVpsClaude: (id: string) => send('GET', `/api/vps/${id}/claude/check`),
  setupVpsClaude: (id: string) => send('POST', `/api/vps/${id}/claude/setup`),
  scanVpsClaude: (id: string) => send('GET', `/api/vps/${id}/claude/scan`),
  bootstrapVpsUrl: (id: string) => `/api/vps/${id}/claude/bootstrap`,

  // Claude sessions
  listClaudeSessions: (q?: { vpsId?: string; status?: string }) => {
    const p = new URLSearchParams();
    if (q?.vpsId) p.set('vpsId', q.vpsId);
    if (q?.status) p.set('status', q.status);
    const qs = p.toString();
    return send('GET', `/api/claude/sessions${qs ? '?' + qs : ''}`);
  },
  getClaudeSession: (id: string) => send('GET', `/api/claude/sessions/${id}`),
  createClaudeSession: (data: any) => send('POST', '/api/claude/sessions', data),
  importClaudeSession: (data: any) => send('POST', '/api/claude/sessions/import', data),
  killClaudeSession: (id: string) => send('DELETE', `/api/claude/sessions/${id}`),
  hardDeleteClaudeSession: (id: string) => send('DELETE', `/api/claude/sessions/${id}?hard=1`),
  renameClaudeSession: (id: string, name: string | null) =>
    send('PATCH', `/api/claude/sessions/${id}`, { name }),
  sleepClaudeSession: (id: string) => send('POST', `/api/claude/sessions/${id}/sleep`),
  resumeClaudeSession: (id: string) => send('POST', `/api/claude/sessions/${id}/resume`),
  sendClaudeInput: (id: string, content: string) => send('POST', `/api/claude/sessions/${id}/input`, { content }),
  interruptClaude: (id: string) => send('POST', `/api/claude/sessions/${id}/input`, { type: 'interrupt' }),
  respondClaudePermission: (id: string, permId: string, allow: boolean, always = false) =>
    send('POST', `/api/claude/sessions/${id}/permission`, { id: permId, allow, always }),
  respondClaudeQuestion: (id: string, qid: string, answers: Record<string, string> | null) =>
    send('POST', `/api/claude/sessions/${id}/question`, { id: qid, answers }),
  respondClaudeExitPlan: (id: string, qid: string, decision: 'approve' | 'reject', feedback?: string) =>
    send('POST', `/api/claude/sessions/${id}/exit-plan`, { id: qid, decision, feedback }),
  setClaudeMode: (id: string, mode: 'normal' | 'acceptEdits' | 'bypass' | 'plan') =>
    send('POST', `/api/claude/sessions/${id}/mode`, { mode }),
  revertClaudeEdit: (id: string, filePath: string, content: string | null) =>
    send('POST', `/api/claude/sessions/${id}/revert`, { filePath, content }),
  searchClaude: (q: string) => send('GET', `/api/claude/search?q=${encodeURIComponent(q)}`),
  getClaudeSettings: () => send('GET', '/api/claude/settings'),
  updateClaudeSettings: (data: any) => send('POST', '/api/claude/settings', data),
  testTelegram: () => send('POST', '/api/claude/telegram/test'),
  pushVapidKey: () => send('GET', '/api/claude/push/key'),
  pushSubscribe: (data: any) => send('POST', '/api/claude/push/subscribe', data),
  pushUnsubscribe: (endpoint: string) => send('POST', '/api/claude/push/unsubscribe', { endpoint })
};
