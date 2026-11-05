import type { AccountProfile } from './accountProfiles';
import type { AccountLoginAttempt, AccountsResponse } from './providerAccounts';
import type { AccountUsage } from '@/lib/server/hub/types';
import type { AccountProfilesResponse, CreateAccountProfileResponse, UpdateAccountProfileResponse } from './types/api';
import type { CustomEndpoint, EndpointState } from '@/lib/customEndpoints';
// Typed HTTP client for the dashboard's API routes.
// For shapes: cf. lib/types/api.ts. Every new method must have its
// `XxxBody` / `XxxResponse` pair declared there, then type the return
// here via `send<TRes>()`.

import { PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';
import type {
  WorkflowOutputQuery, WorkflowOutputResponse, WorkflowAgentsResponse,
  EndpointProbeBody, EndpointProbeResponse, EndpointSaveBody, SessionEndpointBody,
  EndpointBatchBody, EndpointBatchResponse,
  Vps, VpsFolder, VpsPath, AgentSession, PermissionMode, ShellInfo,
  CreateVpsBody, UpdateVpsBody, TestVpsResponse, UpdateVpsAgentResponse,
  RefreshVpsAgentResponse, VpsUsageResponse, VpsFsListResponse, SessionPathResponse,
  GitWorkspaceResponse, GitDiffResponse, GitCommitBody, GitCommitResponse,
  GitBranchesResponse, GitCheckoutBody, GitCheckoutResponse,
  GitLogResponse, GitShowResponse, FileActivityResponse,
  LspStatusResponse, LspOpenResponse, LspDiagnosticsResponse, LspRequestResponse,
  GitOpResponse, GitMessageResponse, FsListResponse, FsReadResponse, FsStatResponse, FsLivePreviewBody, FsLivePreviewResponse,
  FsRangeResponse, FsSqliteBody, FsSqliteResponse, FsArchiveBody, FsArchiveResponse, FsConvertBody, FsConvertResponse,
  FsWriteBody, FsWriteResponse, TabsResponse, TabDTO, OpenTabBody, CloseTabResponse,
  ReorderTabsBody, FsOpBody, FsOpResponse, FsSearchFile, FsSearchQuery, FsSearchResponse, FsSearchStreamLine,
  FsUploadBody, FsUploadResponse,
  CreateVpsFolderBody, UpdateVpsFolderBody, VpsLayoutBody, VpsLayoutResponse,
  LocalAgentStatus,
  ProviderAccountResponse,
  ShellsListResponse, StartShellBody, UpdateShellBody,
  InstallInfo, InstallsListResponse, VpsInstallResponse,
  CreateVpsPathBody, UpdateVpsPathBody,
  ClaudeCheckResponse, SetupVpsClaudeResponse, ScanVpsClaudeResponse, ScanVpsCodexResponse,
  ScanVpsSessionsQuery, ScanVpsSessionsResponse,
  CheckClaudeLoginResponse, ClaudeLoginStatusResponse,
  CodexLoginStartResponse, CodexLoginStatusResponse,
  CursorLoginStartResponse, CursorLoginStatusResponse, CursorLoginCheckResponse,
  CursorModelsResponse,
  AgentSessionListQuery, AgentSessionsListResponse,
  AgentSessionDetailResponse, AgentSessionMessageWindow,
  AgentSessionEditsResponse,
  CreateAgentSessionBody, CreateAgentSessionResponse,
  ImportAgentSessionBody, ImportAgentSessionResponse,
  RenameAgentSessionBody,
  DeleteAgentSessionResponse, ResumeAgentSessionResponse,
  BulkDeleteSessionsBody, BulkDeleteSessionsResponse,
  RespondPermissionBody, RespondQuestionBody, RespondExitPlanBody,
  SetAgentModeResponse,
  SetSessionModelBody, SetSessionModelResponse,
  SetSessionEffortBody, SetSessionEffortResponse,
  ClaudeEffortLevel, ClaudeModelsResponse, ClaudeModelsRefreshResponse,
  RevertEditResponse, SessionSearchResponse,
  AppSettingsMap, PushVapidKeyResponse, PushSubscribeBody,
  PushSubscribeResponse,
  SessionAttachmentsResponse, UploadSessionAttachmentResponse,
  OkResponse, OkOrErrorResponse,
  SendAgentInputBody, SendAgentInputResponse, ActionSyncStamp,
  SessionWindowQuery, SessionProbeResponse, AgentSessionToolCallsResponse,
} from '@/lib/types/api';
import type { TranscriptView } from '@/lib/transcriptRows';

async function send<TRes = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal; timeoutMs?: number; timeoutMessage?: string },
): Promise<TRes> {
  // Bound EVERY request with a timeout. Without this, a fetch issued just
  // before the device sleeps (laptop lid, mobile background) hangs forever
  // — the socket is suspended, not closed, so the promise neither resolves
  // nor rejects until the OS finally tears the socket down (can be
  // minutes). A hung promise wedges any inflight-dedup guard built on top
  // of it (sessionCache.inflight, useSessionStream.inflightPollRef),
  // which is exactly the "chat frozen until refresh" class of bug.
  // cf. CLAUDE.md §14 gotcha 24.
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const ac = new AbortController();
  const onExternalAbort = () => ac.abort(
    opts?.signal?.reason ?? new DOMException('request cancelled', 'AbortError'),
  );
  if (opts?.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new DOMException(`request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  // The bound covers the BODY too: headers can arrive and the body read then
  // stall (a half-open socket behind a proxy, a device that slept mid-read),
  // and an unbounded `res.json()` wedges any single-flight guard built on top
  // of it (app/sync/windowSync.ts) exactly like a hung fetch.
  const mapAbort = (error: unknown): never => {
    if (timedOut) {
      const seconds = Math.round(timeoutMs / 1_000);
      throw new Error(opts?.timeoutMessage
        ?? `${method} ${path} timed out after ${seconds}s; try again when the connection is stable`);
    }
    if (opts?.signal?.aborted) {
      const reason = opts.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new DOMException('request cancelled', 'AbortError');
    }
    throw error;
  };
  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (error) {
      return mapAbort(error);
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
    try {
      return (await res.json()) as TRes;
    } catch (error) {
      if (timedOut || opts?.signal?.aborted) return mapAbort(error);
      throw error;
    }
  } finally {
    clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }
}

/** Silence that means the stream is dead (a sleeping device, a half-open
 *  socket): the agent sends a heartbeat twice a second while it searches. */
const SEARCH_STREAM_STALL_MS = 30_000;

async function readSearchStream(path: string, body: FsSearchQuery, opts: {
  signal: AbortSignal;
  onFiles: (files: FsSearchFile[], scanned?: number) => void;
}): Promise<FsSearchResponse> {
  const ac = new AbortController();
  const forward = () => ac.abort(opts.signal.reason);
  if (opts.signal.aborted) forward();
  else opts.signal.addEventListener('abort', forward, { once: true });
  let stalled = false;
  let timer = setTimeout(() => { stalled = true; ac.abort(); }, SEARCH_STREAM_STALL_MS);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { stalled = true; ac.abort(); }, SEARCH_STREAM_STALL_MS);
  };
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`POST ${path} → ${res.status}${txt ? ': ' + txt.slice(0, 400) : ''}`);
    }
    // Refused before anything was searched (offline agent, bad body): JSON.
    if (!(res.headers.get('content-type') ?? '').includes('ndjson') || !res.body) {
      return (await res.json()) as FsSearchResponse;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done: FsSearchResponse | null = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      alive();
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as FsSearchStreamLine;
        if (msg.type === 'files') opts.onFiles(msg.files, msg.scanned);
        else done = msg;
      }
    }
    return done ?? { ok: false, reason: 'error', error: 'the search was cut short', files: [] };
  } catch (error) {
    if (stalled) throw new Error('the search stopped answering; try again when the connection is stable');
    throw error;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', forward);
  }
}

export const api = {
  getWorkflowAgents: (id: string, task: string, signal?: AbortSignal) =>
    send<WorkflowAgentsResponse>('GET', `/api/sessions/${id}/subagents?${new URLSearchParams({ task })}`, undefined, { signal }),
  getWorkflowOutput: (id: string, query: WorkflowOutputQuery, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value != null) params.set(key, String(value));
    return send<WorkflowOutputResponse>('GET', `/api/sessions/${id}/subagents?${params}`, undefined, { signal });
  },
  listCustomEndpoints: () => send<{ endpoints: CustomEndpoint[] }>('GET', '/api/custom-endpoints'),
  saveCustomEndpoint: (body: EndpointSaveBody) => send<{ endpoint: CustomEndpoint }>('POST', '/api/custom-endpoints', body),
  deleteCustomEndpoint: (id: string) => send<{ ok: boolean }>('DELETE', '/api/custom-endpoints', { id }),
  probeCustomEndpoint: (body: EndpointProbeBody) => send<EndpointProbeResponse>('POST', '/api/custom-endpoints/probe', body, { timeoutMs: 65_000 }),
  getEndpointBatch: () => send<EndpointBatchResponse>('GET', '/api/custom-endpoints/test-all'),
  startEndpointBatch: (body: EndpointBatchBody) => send<EndpointBatchResponse>('POST', '/api/custom-endpoints/test-all', body),
  cancelEndpointBatch: (id: string) => send<EndpointBatchResponse>('DELETE', '/api/custom-endpoints/test-all', { id }),
  getSessionEndpoint: (id: string) => send<EndpointState>('GET', `/api/sessions/${encodeURIComponent(id)}/endpoint`),
  setSessionEndpoint: (id: string, body: SessionEndpointBody) => send<EndpointState>('POST', `/api/sessions/${encodeURIComponent(id)}/endpoint`, body, { timeoutMs: 90_000 }),

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
    // Reconnect → start the daemon → reconnect, and when the box answers SSH
    // but the agent won't stay up, a full redeploy (the update flow, pip
    // included): the update's own budget.
    send<RefreshVpsAgentResponse>('POST', `/api/vps/${id}/agent/refresh`, undefined, { timeoutMs: 360_000 }),
  // Account usage (the `/usage` gauges) for a VPS's Claude account (§14.58).
  // `cachedOnly`: the hub's snapshot, never an awaited poll (header account buttons).
  getVpsUsage: (id: string, provider?: SessionProvider, profile = 'default', refresh = false, cachedOnly = false) =>
    send<VpsUsageResponse>('GET', `/api/vps/${id}/usage${provider ? `?provider=${provider}&profile=${encodeURIComponent(profile)}&refresh=${refresh ? '1' : '0'}${cachedOnly ? '&cached=1' : ''}` : ''}`),
  // Subdirectories of `path` on the VPS — wizard path autocomplete (debounced
  // + cached client-side) and existence check on submit.
  checkSessionPath: (id: string, path: string) =>
    send<SessionPathResponse>('GET', `/api/vps/${id}/fs?check=1&path=${encodeURIComponent(path)}`, undefined, { timeoutMs: 15_000 }),
  listVpsDirs: (id: string, path: string) =>
    send<VpsFsListResponse>('GET', `/api/vps/${id}/fs?path=${encodeURIComponent(path)}`, undefined, { timeoutMs: 15_000 }),
  // ── Source control (agent >= 0.24.0, §14.76) ──────────────────────────────
  // Keyed on (vpsId, cwd), never on a session: two sessions in the same repo
  // are two views of one working tree and share the hub-side cache.
  // `cwd` is the session's folder and the CACHE key; `repo` names one checkout
  // inside it, for the folder-of-projects case (§14.83). Omitting `repo` keeps
  // the pre-0.29.0 behaviour: act on the repo containing the cwd.
  getGitWorkspace: (id: string, cwd: string, force = false) =>
    send<GitWorkspaceResponse>('GET', `/api/vps/${id}/git/status?cwd=${encodeURIComponent(cwd)}${force ? '&force=1' : ''}`, undefined, { timeoutMs: 30_000 }),
  getGitDiff: (id: string, cwd: string, path: string, repo?: string | null) =>
    send<GitDiffResponse>('GET', `/api/vps/${id}/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`, undefined, { timeoutMs: 30_000 }),
  gitCommit: (id: string, body: GitCommitBody) =>
    send<GitCommitResponse>('POST', `/api/vps/${id}/git/commit`, body, { timeoutMs: 200_000 }),
  gitPush: (id: string, cwd: string, repo?: string | null) =>
    send<GitOpResponse>('POST', `/api/vps/${id}/git/push`, { cwd, repo }, { timeoutMs: 200_000 }),
  gitPull: (id: string, cwd: string, repo?: string | null) =>
    send<GitOpResponse>('POST', `/api/vps/${id}/git/pull`, { cwd, repo }, { timeoutMs: 200_000 }),
  gitDiscard: (id: string, cwd: string, paths: string[], repo?: string | null) =>
    send<GitOpResponse>('POST', `/api/vps/${id}/git/discard`, { cwd, paths, repo }, { timeoutMs: 60_000 }),
  // ── Code intelligence (agent >= 0.33.0, §14.89) ───────────────────────────
  lspStatus: (id: string, root: string, path: string) =>
    send<LspStatusResponse>('GET', `/api/vps/${id}/lsp?op=status&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, undefined, { timeoutMs: 15_000 }),
  lspOpen: (id: string, root: string, path: string, text: string) =>
    send<LspOpenResponse>('POST', `/api/vps/${id}/lsp`, { op: 'open', root, path, text }, { timeoutMs: 90_000 }),
  lspClose: (id: string, root: string, path: string) =>
    send<{ ok: boolean }>('POST', `/api/vps/${id}/lsp`, { op: 'close', root, path }, { timeoutMs: 15_000 }),
  // Long poll: returns as soon as the server pushes something, or after
  // `wait` seconds with changed:false. Never an error on a timeout.
  lspDiagnostics: (id: string, root: string, path: string, since: number, wait = 20) =>
    send<LspDiagnosticsResponse>('GET', `/api/vps/${id}/lsp?op=diagnostics&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&since=${since}&wait=${wait}`, undefined, { timeoutMs: (wait + 15) * 1000 }),
  // Apply a WorkspaceEdit (rename, format). The agent writes atomically and
  // refuses anything outside the project root (§14.90).
  lspApplyEdit: (id: string, root: string, changes: Record<string, unknown[]>) =>
    send<{ ok: boolean; error?: string; reason?: string; changed?: string[] }>(
      'POST', `/api/vps/${id}/lsp`, { op: 'apply', root, path: root, changes }, { timeoutMs: 60_000 }),
  lspRequest: (id: string, body: { root: string; path: string; method: string; position?: unknown; extra?: unknown; item?: unknown }) =>
    send<LspRequestResponse>('POST', `/api/vps/${id}/lsp`, { op: 'request', ...body }, { timeoutMs: 30_000 }),

  // Who is reading/writing which file on this VPS, right now (§14.88).
  getFileActivity: (id: string) =>
    send<FileActivityResponse>('GET', `/api/vps/${id}/activity`, undefined, { timeoutMs: 10_000 }),

  // ── History (agent >= 0.32.0, §14.87) ─────────────────────────────────────
  getGitLog: (id: string, cwd: string, o: { repo?: string | null; path?: string | null; limit?: number; skip?: number } = {}) =>
    send<GitLogResponse>('GET', `/api/vps/${id}/git/log?cwd=${encodeURIComponent(cwd)}`
      + `${o.repo ? `&repo=${encodeURIComponent(o.repo)}` : ''}`
      + `${o.path ? `&path=${encodeURIComponent(o.path)}` : ''}`
      + `${o.limit ? `&limit=${o.limit}` : ''}${o.skip ? `&skip=${o.skip}` : ''}`,
      undefined, { timeoutMs: 30_000 }),
  getGitShow: (id: string, cwd: string, sha: string, o: { repo?: string | null; path?: string | null } = {}) =>
    send<GitShowResponse>('GET', `/api/vps/${id}/git/show?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}`
      + `${o.repo ? `&repo=${encodeURIComponent(o.repo)}` : ''}`
      + `${o.path ? `&path=${encodeURIComponent(o.path)}` : ''}`,
      undefined, { timeoutMs: 40_000 }),

  // ── Branches (agent >= 0.31.0, §14.85) ────────────────────────────────────
  getGitBranches: (id: string, cwd: string, repo?: string | null) =>
    send<GitBranchesResponse>('GET', `/api/vps/${id}/git/branches?cwd=${encodeURIComponent(cwd)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`, undefined, { timeoutMs: 30_000 }),
  gitCheckout: (id: string, body: GitCheckoutBody) =>
    send<GitCheckoutResponse>('POST', `/api/vps/${id}/git/checkout`, body, { timeoutMs: 200_000 }),
  gitFetch: (id: string, cwd: string, repo?: string | null) =>
    send<GitOpResponse>('POST', `/api/vps/${id}/git/fetch`, { cwd, repo }, { timeoutMs: 200_000 }),
  gitDeleteBranch: (id: string, cwd: string, branch: string, repo?: string | null) =>
    send<GitOpResponse>('DELETE', `/api/vps/${id}/git/checkout?cwd=${encodeURIComponent(cwd)}&branch=${encodeURIComponent(branch)}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`, undefined, { timeoutMs: 60_000 }),
  gitMessage: (id: string, cwd: string, sel: { paths?: string[]; all?: boolean }, repo?: string | null) =>
    send<GitMessageResponse>('POST', `/api/vps/${id}/git/message`, { cwd, repo, ...sel }, { timeoutMs: 120_000 }),

  // ── Read-only file tree (agent >= 0.25.0, §14.77) ─────────────────────────
  // `root` is the session cwd and the containment boundary. One directory per
  // call — the tree expands lazily.
  listFsTree: (id: string, root: string, path: string, withGit: boolean, page?: { offset: number; limit: number }) =>
    send<FsListResponse>('GET', `/api/vps/${id}/fs/list?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${withGit ? '&git=1' : ''}${page ? `&offset=${page.offset}&limit=${page.limit}` : ''}`, undefined, { timeoutMs: 20_000 }),
  writeFsFile: (id: string, body: FsWriteBody) =>
    send<FsWriteResponse>('POST', `/api/vps/${id}/fs/write`, body, { timeoutMs: 60_000 }),
  fsOp: (id: string, body: FsOpBody) =>
    send<FsOpResponse>('POST', `/api/vps/${id}/fs/op`, body, { timeoutMs: 60_000 }),
  // ── Explorer drop: upload into a folder (lib/fsUpload.ts) ──────────────
  fsUpload: (id: string, body: FsUploadBody) =>
    send<FsUploadResponse>('POST', `/api/vps/${id}/fs/upload`, body, { timeoutMs: 60_000 }),
  /** One raw chunk. Bespoke like the attachment upload: `send()` is JSON-only.
   *  The last chunk waits for the VPS to fsync and commit, hence the margin. */
  fsUploadChunk: async (
    id: string, uploadId: string, offset: number, chunk: Blob, opts?: { signal?: AbortSignal },
  ): Promise<FsUploadResponse> => {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ac.abort(), 180_000);
    let res: Response;
    try {
      res = await fetch(`/api/vps/${id}/fs/upload/${encodeURIComponent(uploadId)}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: chunk,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const txt = await res.text();
        try { detail = JSON.parse(txt)?.error || txt; } catch { detail = txt; }
      } catch { /* unreadable body */ }
      throw new Error(detail || `upload failed → ${res.status}`);
    }
    return res.json() as Promise<FsUploadResponse>;
  },
  fsUploadCancel: (id: string, uploadId: string) =>
    send<OkResponse>('DELETE', `/api/vps/${id}/fs/upload/${encodeURIComponent(uploadId)}`, undefined, { timeoutMs: 15_000 }),
  readFsFile: (id: string, root: string, path: string) =>
    send<FsReadResponse>('GET', `/api/vps/${id}/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, undefined, { timeoutMs: 40_000 }),
  statFsFile: (id: string, root: string, path: string) =>
    send<FsStatResponse>('GET', `/api/vps/${id}/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&stat=1`, undefined, { timeoutMs: 15_000 }),
  // ── File viewers' agent RPCs (agent >= 0.108.0, §14.112) ─────────────────
  /** `length` bytes from `offset` (negative = from the end): logs, big files. */
  fsReadRange: (id: string, root: string, path: string, offset: number, length: number) =>
    send<FsRangeResponse>('GET', `/api/vps/${id}/fs/range?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`, undefined, { timeoutMs: 30_000 }),
  /** A SQLite file, read-only: its schema, or one SELECT. */
  fsSqlite: (id: string, body: FsSqliteBody) =>
    send<FsSqliteResponse>('POST', `/api/vps/${id}/fs/sqlite`, body, { timeoutMs: 30_000 }),
  /** Inside an archive: list, read one member, or extract into a new folder. */
  fsArchive: (id: string, body: FsArchiveBody) =>
    send<FsArchiveResponse>('POST', `/api/vps/${id}/fs/archive`, body, {
      timeoutMs: body.op === 'extract' ? 620_000 : 60_000,
    }),
  /** Decode on the VPS what a browser cannot: images → PNG, Office → PDF. */
  fsConvert: (id: string, body: FsConvertBody) =>
    send<FsConvertResponse>('POST', `/api/vps/${id}/fs/convert`, body, { timeoutMs: 170_000 }),
  /** The sandboxed live-view URL of an HTML file (§14.110). */
  fsLivePreview: (id: string, root: string, path: string) =>
    send<FsLivePreviewResponse>('POST', `/api/vps/${id}/fs/preview`, { root, path } satisfies FsLivePreviewBody, { timeoutMs: 15_000 }),
  /**
   * Search the tree (§14.83). POST because the parameters are a form, not a
   * path — and because a regex full of `&` and `#` has no business being
   * URL-encoded twice. The timeout sits above the agent's own 20s budget so
   * a bounded search always reports its bound instead of looking offline.
   */
  searchFs: (id: string, body: FsSearchQuery) =>
    send<FsSearchResponse>('POST', `/api/vps/${id}/fs/search`, body, { timeoutMs: 45_000 }),
  /** The same search, its hits as they are found (§14.84): `onFiles` gets
   *  each batch, and the promise the totals (`files` empty, or everything at
   *  once from an agent older than streaming). Abort `signal` to drop it —
   *  the hub then cancels the walk on the VPS. */
  searchFsStream: (id: string, body: FsSearchQuery, opts: {
    signal: AbortSignal;
    onFiles: (files: FsSearchFile[], scanned?: number) => void;
  }) => readSearchStream(`/api/vps/${id}/fs/search`, { ...body, stream: true }, opts),
  // URL for the BYTES — media, a file download, or a streamed directory ZIP.
  fsFileUrl: (
    id: string, root: string, path: string,
    opts: { inline?: boolean; archive?: 'zip' } = {},
  ) =>
    `/api/vps/${id}/fs/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&${
      opts.archive === 'zip' ? 'archive=zip' : opts.inline ? 'inline=1' : 'raw=1'
    }`,

  /** Sidebar order of the sessions inside ONE vps (§14.80). */
  reorderSessions: (vpsId: string, ids: string[]) =>
    send<OkResponse & ActionSyncStamp>('POST', '/api/sessions/reorder', { vpsId, ids }),
  /** Permanent deletion of MANY sessions in one request (paused cleanup). */
  bulkDeleteSessions: (body: BulkDeleteSessionsBody) =>
    send<BulkDeleteSessionsResponse>('POST', '/api/sessions/bulk-delete', body, { timeoutMs: 120_000 }),

  // ── Tabs: the shared workspace layout (§14.78) ────────────────────────────
  listTabs: () => send<TabsResponse>('GET', '/api/tabs'),
  openTab: (body: OpenTabBody) =>
    send<{ tab: TabDTO; tabs: TabDTO[] }>('POST', '/api/tabs', body),
  updateTab: (id: string, body: { pin?: boolean; activate?: boolean }) =>
    send<{ tab: TabDTO; tabs: TabDTO[] }>('PATCH', `/api/tabs/${id}`, body),
  closeTab: (id: string, nextActiveId?: string) =>
    send<CloseTabResponse & { tabs: TabDTO[] }>('DELETE',
      `/api/tabs/${id}${nextActiveId ? `?next=${encodeURIComponent(nextActiveId)}` : ''}`),
  reorderTabs: (body: ReorderTabsBody) =>
    send<{ ok: boolean; tabs: TabDTO[] }>('POST', '/api/tabs/reorder', body),
  closeTabsWhere: (q: { vpsId?: string; path?: string; exceptId?: string }) => {
    const p = new URLSearchParams();
    if (q.vpsId !== undefined) p.set('vpsId', q.vpsId);
    if (q.path !== undefined) p.set('path', q.path);
    if (q.exceptId !== undefined) p.set('exceptId', q.exceptId);
    return send<{ ok: boolean; closed: number; tabs: TabDTO[] }>('DELETE', `/api/tabs?${p}`);
  },

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
  // force=true = "forget": drop the row even if the remote kill failed
  // (unreachable VPS). Without force, a failed kill → 502 {canForce:true}.
  killShell: (shellId: string, force = false) =>
    send<OkResponse>('DELETE', `/api/shells/${shellId}${force ? '?force=1' : ''}`),

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
  // Codex sibling: lists the VPS's Codex threads (~/.codex/sessions rollouts)
  // so they can be imported + resumed like Claude ones.
  scanVpsCodex: (id: string, archived = false) =>
    send<ScanVpsCodexResponse>('GET', `/api/vps/${id}/codex/scan${archived ? '?archived=1' : ''}`),
  /**
   * Importable sessions for ANY backend. The route directory comes from the
   * provider registry's `deployment.scanRouteDir` (§14.102), so a new backend
   * is reachable here as soon as it declares one — no branch to add.
   * Every scan answers the same row shape (§14.74).
   */
  scanVpsSessions: (
    id: string, provider: SessionProvider, query: ScanVpsSessionsQuery = {},
  ) => {
    const p = new URLSearchParams();
    if (query.accountProfile) p.set('profile', query.accountProfile);
    if (query.archived) p.set('archived', '1');
    if (query.after) p.set('after', query.after);
    if (query.cwd) p.set('cwd', query.cwd);
    const qs = p.size ? `?${p}` : '';
    return send<ScanVpsSessionsResponse>(
      'GET', `/api/vps/${id}/${PROVIDERS[provider].deployment.scanRouteDir}/scan${qs}`,
    );
  },
  // Re-checks the VPS's `claude login` state. Persists in DB + returns.
  // Triggered when the login modal closes (the user may have just logged
  // in or out), or on manual demand.
  checkVpsClaudeLogin: (id: string) =>
    send<CheckClaudeLoginResponse>('POST', `/api/vps/${id}/claude/check-login`),
  // Hub-owned provider accounts (§14.115).
  listAccounts: () => send<AccountsResponse>('GET', '/api/accounts'),
  startAccountLogin: (provider: SessionProvider, accountId?: string | null) =>
    send<{ attempt: AccountLoginAttempt }>('POST', '/api/accounts/login', { provider, accountId: accountId ?? null }, { timeoutMs: 75_000 }),
  accountLoginStatus: (attemptId: string) => send<{ attempt: AccountLoginAttempt }>('GET', `/api/accounts/login/${encodeURIComponent(attemptId)}`),
  submitAccountLoginCode: (attemptId: string, code: string) =>
    send<{ attempt: AccountLoginAttempt }>('POST', `/api/accounts/login/${encodeURIComponent(attemptId)}`, { code }, { timeoutMs: 60_000 }),
  cancelAccountLogin: (attemptId: string) => send<OkResponse>('DELETE', `/api/accounts/login/${encodeURIComponent(attemptId)}`),
  renameAccount: (id: string, name: string) => send<OkResponse>('PATCH', '/api/accounts', { id, name }),
  reorderAccounts: (provider: SessionProvider, order: string[]) => send<OkResponse>('PATCH', '/api/accounts', { provider, order }),
  removeAccount: (id: string) => send<OkResponse>('DELETE', '/api/accounts', { id }),
  refreshAccountUsage: (id: string) => send<{ usage: AccountUsage | null }>('POST', `/api/accounts/${encodeURIComponent(id)}/usage`, undefined, { timeoutMs: 60_000 }),
  switchSessionAccount: (sessionId: string, accountId: string) =>
    send<OkResponse & { restarted: boolean } & ActionSyncStamp>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/account`, { accountId }, { timeoutMs: 120_000 }),
  getAccountProfiles: (vpsId?: string) => send<AccountProfilesResponse>('GET', `/api/account-profiles${vpsId ? `?vpsId=${encodeURIComponent(vpsId)}` : ''}`),
  createAccountProfile: (vpsId: string, provider: SessionProvider, name: string) => send<CreateAccountProfileResponse>('POST', '/api/account-profiles', { vpsId, provider, name }),
  renameAccountProfile: (profile: AccountProfile, name: string) => send<UpdateAccountProfileResponse>('PATCH', '/api/account-profiles', { ...profile, name }),
  removeAccountProfile: (profile: AccountProfile) => send<UpdateAccountProfileResponse>('DELETE', '/api/account-profiles', profile),
  signOutAccountProfile: (id: string, provider: SessionProvider, profile: string) => send<OkResponse & { error?: string }>('DELETE', `/api/vps/${id}/account?provider=${provider}&profile=${encodeURIComponent(profile)}`),
  getProviderAccount: (id: string, provider: SessionProvider, profile = 'default') =>
    send<ProviderAccountResponse>('POST', `/api/vps/${id}/account`, { provider, profile }),
  bootstrapVpsUrl: (id: string) => `/api/vps/${id}/claude/bootstrap`,
  // ── Claude device-code login (§14.64) ─────────────────────────────────────
  // start → the modal polls status until an OAuth url shows up, the user
  // authorizes on any device and pastes the code back via submitClaudeLoginCode;
  // the phase then goes 'verifying' → 'success' (confirmed by
  // `claude auth status --json`, never by scraping stdout).
  startClaudeLogin: (id: string, profile = "default") =>
    send<ClaudeLoginStatusResponse>('POST', `/api/vps/${id}/login?profile=${encodeURIComponent(profile)}`),
  claudeLoginStatus: (id: string, profile = "default") =>
    send<ClaudeLoginStatusResponse>('GET', `/api/vps/${id}/login?profile=${encodeURIComponent(profile)}`),
  submitClaudeLoginCode: (id: string, code: string, profile = "default") =>
    send<ClaudeLoginStatusResponse>('POST', `/api/vps/${id}/login/code?profile=${encodeURIComponent(profile)}`, { code }),
  cancelClaudeLogin: (id: string, profile = "default") =>
    send<OkResponse>('DELETE', `/api/vps/${id}/login?profile=${encodeURIComponent(profile)}`),
  claudeSignOut: (id: string) =>
    send<OkResponse & { error?: string }>('DELETE', `/api/vps/${id}/claude/account`),
  // ── Codex device-code login (agent >= 0.16.0, §14.61) ─────────────────────
  // start → {loginId, verificationUrl, userCode}; the modal polls status
  // until the user completes the code on any device; DELETE cancels.
  startCodexLogin: (id: string, profile = "default") =>
    send<CodexLoginStartResponse>('POST', `/api/vps/${id}/codex/login?profile=${encodeURIComponent(profile)}`),
  codexLoginStatus: (id: string, loginId: string, profile = "default") =>
    send<CodexLoginStatusResponse>('GET', `/api/vps/${id}/codex/login?loginId=${encodeURIComponent(loginId)}&profile=${encodeURIComponent(profile)}`),
  cancelCodexLogin: (id: string, loginId: string, profile = "default") =>
    send<OkResponse>('DELETE', `/api/vps/${id}/codex/login?loginId=${encodeURIComponent(loginId)}&profile=${encodeURIComponent(profile)}`),
  codexSignOut: (id: string) =>
    send<OkResponse & { error?: string }>('DELETE', `/api/vps/${id}/codex/account`),

  // ── Cursor sign-in (§14.104): one link, nothing to paste back ─────────────
  startCursorLogin: (id: string) =>
    send<CursorLoginStartResponse>('POST', `/api/vps/${id}/cursor/login`),
  cursorLoginStatus: (id: string, loginId: string) =>
    send<CursorLoginStatusResponse>('GET', `/api/vps/${id}/cursor/login?loginId=${encodeURIComponent(loginId)}`),
  cancelCursorLogin: (id: string, loginId: string) =>
    send<OkResponse>('DELETE', `/api/vps/${id}/cursor/login?loginId=${encodeURIComponent(loginId)}`),
  /** Forget the stored key on this VPS (local-only, like the SDK's logout). */
  cursorSignOut: (id: string) =>
    send<OkResponse & { error?: string }>('DELETE', `/api/vps/${id}/cursor/account`),
  /** Authoritative sign-in probe — an unexpired key minted for this backend. */
  checkVpsCursorLogin: (id: string) =>
    send<CursorLoginCheckResponse>('POST', `/api/vps/${id}/cursor/check-login`),
  /** Account model catalog for this VPS (no API key — like Codex, §14.59). */
  getCursorModels: (vpsId: string) =>
    send<CursorModelsResponse>('GET', `/api/cursor/models?vpsId=${encodeURIComponent(vpsId)}`),

  // ── Claude sessions ───────────────────────────────────────────────────────
  listSessions: (q?: AgentSessionListQuery) => {
    const p = new URLSearchParams();
    if (q?.vpsId) p.set('vpsId', q.vpsId);
    if (q?.status) p.set('status', q.status);
    if (q?.includeArchived) p.set('includeArchived', '1');
    const qs = p.toString();
    return send<AgentSessionsListResponse>('GET', `/api/sessions${qs ? '?' + qs : ''}`);
  },
  // `signal` lets a view that unmounts give its bandwidth back: on a slow link
  // the previous session's 100-300KB transcript otherwise keeps downloading
  // alongside the one the user just opened (sessionCache.fetchAndCache).
  // The transcript window (CLAUDE.md §14.107): `view` (tools hidden ⇒
  // `conversation`, §14.25) and the SSE connection whose focus the GET applies
  // atomically (`conn`/`focusSeq`). `open=1`: this client reads the open
  // reasoning block from `streamingThinking` (an old bundle gets it as a
  // synthetic row instead).
  getAgentSession: (id: string, signal?: AbortSignal, q?: SessionWindowQuery) => {
    const p = new URLSearchParams();
    p.set('open', '1');
    if (q?.view) p.set('view', q.view);
    if (q?.conn && typeof q.focusSeq === 'number') {
      p.set('conn', q.conn);
      p.set('focusSeq', String(q.focusSeq));
    }
    // The window can be several MB: 60 s for headers AND body (a stalled
    // body read must settle the single window flight, windowSync.ts).
    return send<AgentSessionDetailResponse>('GET', `/api/sessions/${id}?${p.toString()}`, undefined, { signal, timeoutMs: 60_000 });
  },
  // Loads a window of older chat messages (scroll-up pagination).
  // The cursor is the `oldestChatId` returned by the previous response.
  // Same endpoint as getAgentSession, but `?before=<id>` is LEAN: the response
  // is exactly {messages, hasMore, oldestChatId, sync} (AgentSessionMessageWindow);
  // the session-wide envelope belongs to the window GET. Server cap 1000.
  loadOlderMessages: (id: string, before: number, limit = 200, view?: TranscriptView) => {
    const p = new URLSearchParams();
    p.set('before', String(before));
    p.set('limit', String(limit));
    if (view) p.set('view', view);
    return send<AgentSessionMessageWindow>('GET', `/api/sessions/${id}?${p.toString()}`);
  },
  // The transcript's O(1) rev-gated check (app/sync/repairPolicy.ts): the hub
  // pushes one heartbeat to `conn` first. 404 = an older hub (no route) or a
  // deleted session — the caller asks for a window either way.
  probeSession: (id: string, q: { conn: string; afterId: number; view: TranscriptView }, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    p.set('conn', q.conn);
    p.set('afterId', String(Math.max(0, Math.floor(q.afterId))));
    p.set('view', q.view);
    return send<SessionProbeResponse>('GET', `/api/sessions/${id}/probe?${p.toString()}`,
      undefined, { signal, timeoutMs: 12_000 });
  },
  // The calls tab in conversation view (no tool rows were fetched): pages of
  // compact calls, newest first (each page chronological).
  getSessionToolCalls: (id: string, q?: { before?: number; limit?: number }, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (q?.before != null) p.set('before', String(q.before));
    if (q?.limit != null) p.set('limit', String(q.limit));
    const qs = p.toString();
    return send<AgentSessionToolCallsResponse>('GET', `/api/sessions/${id}/tool-calls${qs ? '?' + qs : ''}`,
      undefined, { signal });
  },
  // Lazily fetch the latest before/after diff content per modified file. The
  // main session GET strips edit_snapshot content (it's re-fetched in a 5s
  // loop — cf. CLAUDE.md §14 gotcha 41); this serves the diff content on
  // demand, once per session view. Called by useSessionStream's
  // auto-load effect when the edits Map has files with stripped content.
  getSessionEdits: (id: string, signal?: AbortSignal) =>
    send<AgentSessionEditsResponse>('GET', `/api/sessions/${id}/edits`, undefined, { signal }),
  createSession: (data: CreateAgentSessionBody) =>
    send<CreateAgentSessionResponse>('POST', '/api/sessions', data),
  importSession: (data: ImportAgentSessionBody) =>
    send<ImportAgentSessionResponse>('POST', '/api/sessions/import', data),
  // Permanent deletion: kill agent + DB cascade. No more soft-kill.
  // The caller must have confirmed on the UI side (`confirm()`) — no
  // shortcut button without a warning.
  // Action routes answer `sync` (§3.5 of the sync refonte): the revision an
  // optimistic overlay waits for (app/sync/summaryStore.ts § addOverlay).
  deleteAgentSession: (id: string) =>
    send<DeleteAgentSessionResponse & ActionSyncStamp>('DELETE', `/api/sessions/${id}`),
  archiveSession: (id: string) =>
    send<OkResponse & ActionSyncStamp>('POST', `/api/sessions/${id}/archive`),
  unarchiveSession: (id: string) =>
    send<OkResponse & ActionSyncStamp>('DELETE', `/api/sessions/${id}/archive`),
  renameAgentSession: (id: string, name: string | null) =>
    send<AgentSession & ActionSyncStamp>('PATCH', `/api/sessions/${id}`, { name } as RenameAgentSessionBody),
  updateSessionHandle: (id: string, handle: string) =>
    send<AgentSession & ActionSyncStamp>('PATCH', `/api/sessions/${id}`, { handle } as RenameAgentSessionBody),
  /** Any PATCH of the session row (name, color, cwd). */
  patchAgentSession: (id: string, body: { name?: string | null; color?: string | null; cwd?: string }) =>
    send<AgentSession & ActionSyncStamp>('PATCH', `/api/sessions/${id}`, body),
  // Sleep / resume / input / interrupt / force-stop: all return { ok: true }
  sleepSession: (id: string) =>
    send<OkResponse & ActionSyncStamp>('POST', `/api/sessions/${id}/sleep`),
  resumeSession: (id: string) =>
    send<ResumeAgentSessionResponse & ActionSyncStamp>('POST', `/api/sessions/${id}/resume`),
  // In-place SDK restart (awaited sleep + resume) — applies a deferred
  // model/effort change immediately (§14.35). The agent drains the in-flight
  // turn before answering the sleep (≤~5s) and the resume awaits the fresh
  // client's ready — give it a generous timeout.
  restartSession: (id: string) =>
    send<ResumeAgentSessionResponse>('POST', `/api/sessions/${id}/restart`, undefined, { timeoutMs: 60_000 }),
  sendSessionInput: (id: string, content: string, clientMessageId?: string) =>
    // A message is the one request that must outlive the agent RPC's 60s
    // bound. Inspector traffic is isolated separately, but a real VPS/network
    // stall should still produce a precise error rather than Chrome's opaque
    // "signal is aborted without reason".
    // `clientMessageId`: the optimistic bubble's id, the agent's idempotency
    // key, echoed on `user_echo` (an older hub answers a bare `{ok}`).
    send<SendAgentInputResponse>('POST', `/api/sessions/${id}/input`, {
      content, ...(clientMessageId ? { clientMessageId } : {}),
    } satisfies SendAgentInputBody, {
      timeoutMs: 90_000,
      timeoutMessage: 'Sending the message timed out after 90s. It may already have been accepted; the transcript will reconcile automatically.',
    }),
  // ── Session attachments (drag & drop / paperclip) ───────────────────────
  // Upload is the ONE call that can't go through `send()`: that helper always
  // sets `content-type: application/json`, and a multipart body needs the
  // browser to generate its own boundary — so it has a bespoke fetch below.
  listSessionAttachments: (id: string, opts?: { signal?: AbortSignal }) =>
    send<SessionAttachmentsResponse>('GET', `/api/sessions/${id}/attachments`, undefined, opts),
  uploadSessionAttachment: async (
    id: string,
    file: File,
    opts?: { signal?: AbortSignal },
  ): Promise<UploadSessionAttachmentResponse> => {
    const fd = new FormData();
    fd.append('file', file);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (opts?.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    // Generous, size-aware timeout: 25 MB over a slow uplink plus the hub's own
    // ssh push to the VPS can legitimately take minutes. The default 30s of
    // `send()` would abort a perfectly healthy upload — and unlike a GET, a
    // retry here is expensive and user-visible.
    const timeoutMs = 120_000 + Math.ceil(file.size / (1024 * 1024)) * 8_000;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`/api/sessions/${id}/attachments`, {
        method: 'POST',
        // NO content-type header: the browser must set it WITH the multipart
        // boundary. Setting it by hand yields an unparseable body server-side.
        body: fd,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
      if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const txt = await res.text();
        try { detail = JSON.parse(txt)?.error || txt; } catch { detail = txt; }
      } catch { /* body already consumed or unreadable */ }
      throw new Error(detail || `upload failed → ${res.status}`);
    }
    return res.json() as Promise<UploadSessionAttachmentResponse>;
  },
  deleteSessionAttachment: (id: string, attId: string) =>
    send<OkResponse>('DELETE', `/api/sessions/${id}/attachments/${attId}`),
  // `inline` opens the file in a browser tab (images / PDF / audio / video /
  // text); without it the response is an opaque download. The server decides
  // what inline actually means — this flag only asks.
  sessionAttachmentUrl: (id: string, attId: string, opts?: { inline?: boolean }) =>
    `/api/sessions/${id}/attachments/${attId}${opts?.inline ? '?inline=1' : ''}`,
  interruptSession: (id: string) =>
    send<OkResponse>('POST', `/api/sessions/${id}/input`, { type: 'interrupt' }),
  forceStop: (id: string) =>
    send<OkResponse>('POST', `/api/sessions/${id}/force-stop`),
  // Kill one BACKGROUND task, not the session (§14.91). The bar clears on the
  // terminal bg_task event the CLI sends back, not on this ack.
  stopSessionBgTask: (id: string, taskId: string) =>
    send<OkResponse>('POST', `/api/sessions/${id}/bg-tasks/${encodeURIComponent(taskId)}/stop`),
  // Responses to interactions
  respondPermission: (id: string, permId: string, allow: boolean, always = false, suggestion?: number) =>
    send<OkResponse>('POST', `/api/sessions/${id}/permission`, {
      id: permId, allow, always, ...(suggestion != null ? { suggestion } : {}),
    } as RespondPermissionBody),
  respondSessionQuestion: (id: string, qid: string, answers: Record<string, string> | null) =>
    send<OkResponse>('POST', `/api/sessions/${id}/question`, { id: qid, answers } as RespondQuestionBody),
  respondSessionExitPlan: (id: string, qid: string, decision: 'approve' | 'reject', feedback?: string) =>
    send<OkResponse>('POST', `/api/sessions/${id}/exit-plan`, { id: qid, decision, feedback } as RespondExitPlanBody),
  setAgentMode: (id: string, mode: import('@/lib/sessionCapabilities').SessionMode) =>
    send<SetAgentModeResponse>('POST', `/api/sessions/${id}/mode`, { mode }),
  // Per-session model / effort. Both take effect on next sleep+resume — the
  // UI should label "applied at next start" until then. Passing null clears
  // back to the global default (cf. SettingsModal § Claude defaults).
  setSessionModel: (id: string, model: string | null, fallbackModel: string | null = null) =>
    send<SetSessionModelResponse>('POST', `/api/sessions/${id}/model`,
      { model, fallbackModel } as SetSessionModelBody),
  setSessionEffort: (id: string, effort: string | null) =>
    send<SetSessionEffortResponse>('POST', `/api/sessions/${id}/effort`,
      { effort } as SetSessionEffortBody),
  // Codex model catalog for a VPS (account-driven, per-VPS). Mirrors
  // getClaudeModels but sourced from the agent's list_codex_models RPC.
  getCodexModels: (vpsId: string, profile = "default") =>
    send<import('@/lib/types/api').CodexModelsResponse>('GET', `/api/codex/models?vpsId=${encodeURIComponent(vpsId)}&profile=${encodeURIComponent(profile)}`),
  // Short aliases + API catalog, cached per tab in app/modelsCache.ts.
  getClaudeModels: () =>
    send<ClaudeModelsResponse>('GET', '/api/claude/models'),
  refreshClaudeModels: () =>
    send<ClaudeModelsRefreshResponse>('POST', '/api/claude/models/refresh'),
  revertSessionEdit: (id: string, filePath: string) =>
    send<RevertEditResponse>('POST', `/api/sessions/${id}/revert`, { filePath }),
  searchSessions: (q: string) =>
    send<SessionSearchResponse>('GET', `/api/search?q=${encodeURIComponent(q)}`),

  getModelNotices: () =>
    send<import('@/lib/types/api').ModelNoticesResponse>('GET', '/api/models/notices'),
  markModelsSeen: (body: import('@/lib/types/api').MarkModelsSeenBody) =>
    send<import('@/lib/types/api').ModelNoticesResponse>('POST', '/api/models/notices', body),

  // ── Settings & push ───────────────────────────────────────────────────────
  // `sync` (a non-string key of the flat map): the bus revision it reflects —
  // app/sync/revResource.ts compares it with `settings_changed`.
  getSettings: () =>
    send<AppSettingsMap>('GET', '/api/settings'),
  // updateSettings accepts arbitrary key/value pairs (filtered on the
  // server side by ALLOWED_KEYS). We stay free on the client side.
  updateSettings: (data: Record<string, string>) =>
    send<AppSettingsMap>('POST', '/api/settings', data),
  testTelegram: () =>
    send<OkOrErrorResponse>('POST', '/api/telegram/test'),
  notificationSessions: () => send<import('@/lib/notificationPreferences').NotificationSession[]>('GET', '/api/session-notifications'),
  sessionNotifications: (id: string) => send<import('@/lib/notificationPreferences').SessionNotificationSettings>('GET', `/api/sessions/${id}/notifications`),
  updateSessionNotifications: (id: string, telegram: import('@/lib/notificationPreferences').ChannelNotificationPreferences | null) =>
    send<import('@/lib/notificationPreferences').SessionNotificationSettings>('PUT', `/api/sessions/${id}/notifications`, { telegram }),
  pushVapidKey: () =>
    send<PushVapidKeyResponse>('GET', '/api/push/key'),
  pushSubscribe: (data: PushSubscribeBody) =>
    send<PushSubscribeResponse>('POST', '/api/push/subscribe', data),
  pushUnsubscribe: (endpoint: string) =>
    send<OkResponse>('POST', '/api/push/unsubscribe', { endpoint }),
};

/**
 * Canonical provider-neutral session client for new code.
 *
 * The HTTP paths and the original `api.*Claude*` members intentionally stay
 * stable: third-party callers and old dashboard code already depend on them.
 * Keeping this as a thin reference-only facade gives Claude and Codex one
 * vocabulary without duplicating requests or creating a flag-day rename.
 */
export const sessionApi = {
  list: api.listSessions,
  get: api.getAgentSession,
  loadOlder: api.loadOlderMessages,
  probe: api.probeSession,
  toolCalls: api.getSessionToolCalls,
  getEdits: api.getSessionEdits,
  create: api.createSession,
  import: api.importSession,
  remove: api.deleteAgentSession,
  archive: api.archiveSession,
  unarchive: api.unarchiveSession,
  rename: api.renameAgentSession,
  updateHandle: api.updateSessionHandle,
  sleep: api.sleepSession,
  resume: api.resumeSession,
  restart: api.restartSession,
  sendInput: api.sendSessionInput,
  interrupt: api.interruptSession,
  forceStop: api.forceStop,
  stopBackgroundTask: api.stopSessionBgTask,
  respondPermission: api.respondPermission,
  respondQuestion: api.respondSessionQuestion,
  respondExitPlan: api.respondSessionExitPlan,
  setMode: api.setAgentMode,
  setModel: api.setSessionModel,
  setEffort: api.setSessionEffort,
} as const;
