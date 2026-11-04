import 'server-only';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, vps } from '@/lib/db';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { AgentRpcError, type AgentMethodName } from '@/lib/server/agent/types';

/** First agent with the file viewers' RPCs (filetools.py, §14.112). */
export const FILETOOLS_AGENT_VERSION = '0.108.0';

/**
 * One viewer RPC, answered as JSON with the failure as a `reason` the pane can
 * act on (§14.95): `offline`, `unsupported` (an older agent, from -32601 —
 * never guessed from `vps.agentVersion`), or the agent's own refusal.
 */
export async function fileToolCall(
  vpsId: string,
  method: AgentMethodName,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number; map?: (r: Record<string, unknown>) => Record<string, unknown> } = {},
): Promise<NextResponse> {
  const [v] = db.select({ id: vps.id }).from(vps).where(eq(vps.id, vpsId)).all();
  if (!v) return NextResponse.json({ ok: false, error: 'vps not found' }, { status: 404 });
  const client = getAgentClientForVpsId(vpsId);
  if (!client || client.status !== 'connected') {
    return NextResponse.json({ ok: false, reason: 'offline', error: 'the agent is not connected' });
  }
  try {
    const r = await client.call<Record<string, unknown>>(method, params, { timeoutMs: opts.timeoutMs });
    return NextResponse.json(opts.map ? opts.map(r) : r);
  } catch (e: unknown) {
    if (e instanceof AgentRpcError && e.code === -32601) {
      return NextResponse.json({
        ok: false, reason: 'unsupported',
        error: `update this VPS agent to ${FILETOOLS_AGENT_VERSION} or newer to open this file here`,
      });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, reason: 'error', error: msg.slice(0, 300) });
  }
}

/** The common body check: an absolute root and a relative path. */
export function rootAndPath(body: unknown): { root: string; path: string } | null {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const root = typeof o.root === 'string' ? o.root : '';
  const path = typeof o.path === 'string' ? o.path : '';
  if (!root.startsWith('/') || !path || root.length > 4096 || path.length > 4096) return null;
  return { root, path };
}
