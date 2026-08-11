import 'server-only';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError } from '@/lib/server/agent/types';
import type {
  LspDiagnosticsResponse, LspOpenResponse, LspRequestResponse, LspStatusResponse,
} from '@/lib/types/api';

/**
 * Hub side of the language servers (§14.89).
 *
 * A thin pass-through, on purpose: the correlation, the framing and the
 * diagnostics accumulation all live agent-side, next to the process. What
 * belongs here is exactly what belongs here — degrading legibly when the agent
 * is old or offline, so the editor says "no language server on this VPS"
 * instead of throwing.
 *
 * No cache. Diagnostics are long-polled and everything else is a question
 * about a cursor position that moved a moment ago; a cached answer would be a
 * wrong answer.
 */
type Fail = { ok: false; error: string; reason: 'offline' | 'unsupported' | 'timeout' | 'error' };

async function rpc<T>(vpsId: string, method: string, params: Record<string, unknown>): Promise<T | Fail> {
  let client;
  try {
    client = getAgentClientForVpsId(vpsId);
  } catch {
    return { ok: false, error: 'no agent for this VPS', reason: 'offline' };
  }
  // Checked BEFORE calling: `AgentClient.call` waits up to 30s for a
  // connection, and an editor keystroke must not hang on a dead box.
  if (!client || client.status !== 'connected') {
    return { ok: false, error: 'the agent is not connected', reason: 'offline' };
  }
  try {
    return await client.call<T>(method, params);
  } catch (e: unknown) {
    // -32601 = an agent older than 0.33.0. Detected from the error rather than
    // compared against vps.agentVersion, which lags a rollout.
    if (e instanceof AgentRpcError && e.code === -32601) {
      return {
        ok: false, reason: 'unsupported',
        error: 'this VPS runs an agent older than 0.33.0 — update it for code intelligence',
      };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/unknown method/i.test(msg)) {
      return { ok: false, reason: 'unsupported', error: 'agent too old for code intelligence' };
    }
    return { ok: false, reason: /timeout/i.test(msg) ? 'timeout' : 'error', error: msg.slice(0, 300) };
  }
}

const snake = (o: Record<string, unknown>) => o;

export async function lspStatus(vpsId: string, root: string, path: string): Promise<LspStatusResponse> {
  const r = await rpc<Record<string, unknown>>(vpsId, 'lsp_status', snake({ root, path }));
  if ((r as Fail).ok === false && 'reason' in r) {
    const f = r as Fail;
    return { ok: false, error: f.error, reason: f.reason, available: false, running: false };
  }
  const x = r as Record<string, unknown>;
  return {
    ok: true,
    language: (x.language as string) ?? null,
    available: x.available === true,
    running: x.running === true,
    server: (x.server as string) ?? null,
    install: (x.install as string) ?? null,
  };
}

export async function lspOpen(
  vpsId: string, root: string, path: string, text: string,
): Promise<LspOpenResponse> {
  const r = await rpc<Record<string, unknown>>(vpsId, 'lsp_open', snake({ root, path, text }));
  const x = r as Record<string, unknown>;
  if (x.ok === false) {
    return {
      ok: false, error: (x.error as string) ?? 'could not open', reason: (x.reason as string) ?? 'error',
      install: (x.install as string) ?? null, diagnostics: [], diagVersion: 0,
    };
  }
  return {
    ok: true,
    version: (x.version as number) ?? 1,
    diagnostics: (x.diagnostics as LspOpenResponse['diagnostics']) ?? [],
    diagVersion: (x.diag_version as number) ?? 0,
    server: (x.server as string) ?? null,
  };
}

export async function lspClose(vpsId: string, root: string, path: string): Promise<{ ok: boolean }> {
  const r = await rpc<Record<string, unknown>>(vpsId, 'lsp_close', snake({ root, path }));
  return { ok: (r as Record<string, unknown>).ok !== false };
}

export async function lspDiagnostics(
  vpsId: string, root: string, path: string, since: number, wait: number,
): Promise<LspDiagnosticsResponse> {
  const r = await rpc<Record<string, unknown>>(vpsId, 'lsp_diagnostics', snake({ root, path, since, wait }));
  const x = r as Record<string, unknown>;
  if (x.ok === false) {
    return {
      ok: false, error: (x.error as string) ?? 'failed', reason: (x.reason as string) ?? 'error',
      diagnostics: [], diagVersion: since, changed: false, running: false,
    };
  }
  return {
    ok: true,
    diagnostics: (x.diagnostics as LspDiagnosticsResponse['diagnostics']) ?? [],
    diagVersion: (x.diag_version as number) ?? since,
    changed: x.changed === true,
    running: x.running === true,
  };
}

export async function lspRequest(
  vpsId: string, body: { root: string; path: string; method: string; position?: unknown; extra?: unknown; item?: unknown },
): Promise<LspRequestResponse> {
  const r = await rpc<Record<string, unknown>>(vpsId, 'lsp_request', snake({
    root: body.root, path: body.path, method: body.method,
    position: body.position ?? null, extra: body.extra ?? null, item: body.item ?? null,
  }));
  const x = r as Record<string, unknown>;
  if (x.ok === false) {
    return { ok: false, error: (x.error as string) ?? 'failed', reason: (x.reason as string) ?? 'error' };
  }
  return { ok: true, result: x.result };
}
