// Sub-sessions: an agent's charon_peer `start_sub_session` reaches the hub as the
// transient `peer_spawn_request` event; the hub creates the child and answers
// the daemon with `peer_spawn_resolve`, which then delivers the task over the
// peer ledger. Limits and the mode ceiling are enforced on BOTH sides.
import { posix } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { db, agentSessions, vps as vpsTable } from '@/lib/db';
import type { AgentEvent, SessionMode } from '@/lib/server/agent/types';
import type { AgentKind, ClaudeSessionConfig, CodexSessionConfig, CursorSessionConfig, ProviderSessionConfig } from '@/lib/types/api';
import {
  PROVIDERS, asSessionProvider, isSessionMode, providerBackendState, sessionModes,
} from '@/lib/sessionCapabilities';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { isBackendEnabled } from './settings';

export const MAX_SUBSESSION_DEPTH = 3;
export const MAX_LIVE_SUBSESSIONS = 6;
/** Child statuses that still count against the parent's budget. */
export const LIVE_CHILD_STATUSES = ['starting', 'active', 'thinking', 'background', 'failed'] as const;

const REQUEST_TTL_MS = 5 * 60_000;
const MAX_ANCESTOR_WALK = 16;

// Process-wide (§14.106): Next may load this module more than once.
const g = globalThis as unknown as { __charonSpawnSeen?: Map<string, number> };
const seen = (g.__charonSpawnSeen ??= new Map<string, number>());
// Spawns past their limit check but without a child row yet: counted with the
// live children so parallel requests cannot all pass before any row exists.
const gp = globalThis as unknown as { __charonSpawnPending?: Map<string, number> };
const pending = (gp.__charonSpawnPending ??= new Map<string, number>());

function normalizedRank(modes: readonly string[], mode: string): number {
  const i = modes.indexOf(mode);
  return modes.length > 1 ? i / (modes.length - 1) : 0;
}

/**
 * The child's mode under its parent's ceiling. Each list runs least -> most
 * permissive; ranks are normalized to index/(len-1) so providers compare.
 * Requested + valid + within the ceiling => as asked; requested but higher =>
 * the highest allowed (clamped); not requested => the parent's mode (same
 * provider) or the highest child mode within the ceiling.
 */
export function childSpawnMode(opts: {
  parentKind: AgentKind; parentMode: string; childKind: AgentKind; requested?: string | null;
}): { mode: SessionMode; clamped: boolean } {
  const parentModes = sessionModes(opts.parentKind) as readonly string[];
  const childModes = sessionModes(opts.childKind) as readonly string[];
  // An unknown parent mode is treated as the least permissive.
  const ceiling = parentModes.includes(opts.parentMode)
    ? normalizedRank(parentModes, opts.parentMode) : 0;
  const highestAllowed = (): SessionMode => {
    let best = childModes[0];
    for (const m of childModes) if (normalizedRank(childModes, m) <= ceiling + 1e-9) best = m;
    return best as SessionMode;
  };
  const requested = opts.requested;
  if (requested && isSessionMode(opts.childKind, requested)) {
    if (normalizedRank(childModes, requested) <= ceiling + 1e-9) {
      return { mode: requested as SessionMode, clamped: false };
    }
    return { mode: highestAllowed(), clamped: true };
  }
  if (opts.childKind === opts.parentKind && childModes.includes(opts.parentMode)) {
    return { mode: opts.parentMode as SessionMode, clamped: false };
  }
  return { mode: highestAllowed(), clamped: false };
}

/** Number of ancestors above `parentId`'s chain plus the parent itself = the
 *  depth the NEW child would have (a root parent => 1). Bounded walk; a cycle
 *  or an over-long chain reads as too deep. */
export function newChildDepth(
  parentId: string, parentOf: (id: string) => string | null | undefined,
): number {
  let depth = 1;
  let cur: string | null | undefined = parentOf(parentId);
  const visited = new Set<string>([parentId]);
  while (cur) {
    if (visited.has(cur) || depth >= MAX_ANCESTOR_WALK) return MAX_ANCESTOR_WALK;
    visited.add(cur);
    depth++;
    cur = parentOf(cur);
  }
  return depth;
}

export function liveChildCount(parentId: string): number {
  return db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(
      eq(agentSessions.parentSessionId, parentId),
      eq(agentSessions.archived, 0),
      inArray(agentSessions.status, [...LIVE_CHILD_STATUSES]),
    )).all().length;
}

/** null = allowed, else the refusal. */
export function spawnLimitError(parentId: string): string | null {
  const depth = newChildDepth(parentId, (id) =>
    db.select({ p: agentSessions.parentSessionId }).from(agentSessions)
      .where(eq(agentSessions.id, id)).get()?.p);
  if (depth > MAX_SUBSESSION_DEPTH) {
    return `sub-session depth limit reached (max ${MAX_SUBSESSION_DEPTH} levels)`;
  }
  if (liveChildCount(parentId) + (pending.get(parentId) ?? 0) >= MAX_LIVE_SUBSESSIONS) {
    return `too many live sub-sessions for this session (max ${MAX_LIVE_SUBSESSIONS})`;
  }
  return null;
}

/** Re-root the children of a deleted session; returns their ids. */
export function reparentChildren(parentId: string): string[] {
  const ids = db.select({ id: agentSessions.id }).from(agentSessions)
    .where(eq(agentSessions.parentSessionId, parentId)).all().map((r) => r.id);
  if (ids.length) {
    db.update(agentSessions).set({ parentSessionId: null })
      .where(eq(agentSessions.parentSessionId, parentId)).run();
  }
  return ids;
}

/** The parent's USER-CHOSEN construction keys only: never runtime/boot state
 *  (Cursor's persisted keys, remembered rules, account numbers). */
export function inheritableConfig(kind: AgentKind, raw: ProviderSessionConfig | null): ProviderSessionConfig | null {
  if (!raw) return null;
  const pick = <T extends object>(src: T, keys: readonly (keyof T)[]): Partial<T> => {
    const out: Partial<T> = {};
    for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
    return out;
  };
  const shared = ['accountProfile', 'customEndpoint', 'baseInstructions', 'developerInstructions'] as const;
  switch (kind) {
    case 'claude':
      return pick(raw as ClaudeSessionConfig, [...shared, 'skills', 'settingSources']);
    case 'codex':
      return pick(raw as CodexSessionConfig, [
        ...shared, 'configOverrides', 'summary', 'personality', 'serviceTier',
        'modelProvider', 'approvalsReviewer', 'permissionProfile',
      ]);
    case 'cursor':
      return pick(raw as CursorSessionConfig, [
        ...shared, 'settingSources', 'autoReview', 'tools', 'disallowedTools',
      ]);
    default:
      return null;
  }
}

function pruneSeen(now: number) {
  for (const [k, t] of seen) if (now - t > REQUEST_TTL_MS) seen.delete(k);
}

function nameFromTask(task: string): string {
  const line = task.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

type SpawnRequest = Extract<AgentEvent, { event: 'peer_spawn_request' }>;

async function resolveRequest(parentId: string, ev: SpawnRequest) {
  const parent = db.select().from(agentSessions).where(eq(agentSessions.id, parentId)).get();
  if (!parent) throw new Error('parent session not found');
  if (parent.archived) throw new Error('parent session is archived');
  const client = getAgentClientForVpsId(parent.vpsId);
  if (client.status !== 'connected') throw new Error('the VPS agent is not connected');
  if (typeof ev.task !== 'string' || !ev.task.trim()) throw new Error('empty task');
  const limit = spawnLimitError(parent.id);
  if (limit) throw new Error(limit);
  pending.set(parent.id, (pending.get(parent.id) ?? 0) + 1);
  try {
    return await createChild(parent, ev, client);
  } finally {
    const left = (pending.get(parent.id) ?? 1) - 1;
    if (left > 0) pending.set(parent.id, left); else pending.delete(parent.id);
  }
}

async function createChild(
  parent: typeof agentSessions.$inferSelect, ev: SpawnRequest, client: ReturnType<typeof getAgentClientForVpsId>,
) {
  const kind: AgentKind = ev.provider ? asSessionProvider(ev.provider) : asSessionProvider(parent.kind);
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, parent.vpsId)).all();
  if (!v) throw new Error('vps not found');
  const backend = PROVIDERS[kind].backend;
  if (!isBackendEnabled(kind)) throw new Error(`${PROVIDERS[kind].label} is disabled`);
  if (backend.availability.blocksLaunch && providerBackendState(v as any, kind).available !== 1) {
    throw new Error(`${PROVIDERS[kind].label} is not available on this VPS`);
  }

  // A child stays inside the parent's workspace: a mode's scope is relative to cwd.
  const parentCwd = posix.normalize(parent.cwd);
  const cwd = ev.cwd ? posix.resolve('/', ev.cwd) : parentCwd;
  if (!cwd.startsWith('/') || cwd.length > 4096 || cwd.includes('\0')) throw new Error('invalid cwd');
  if (cwd !== parentCwd && !cwd.startsWith(parentCwd.replace(/\/+$/, '') + '/')) {
    throw new Error("cwd must be the parent's directory or inside it");
  }

  const same = kind === parent.kind;
  const { mode, clamped } = childSpawnMode({
    parentKind: asSessionProvider(parent.kind), parentMode: parent.permissionMode,
    childKind: kind, requested: ev.mode,
  });
  const model = ev.model || (same ? parent.model : null) || null;
  const effort = ev.effort || (same ? parent.effort : null) || null;
  const parentConfig = same
    ? inheritableConfig(kind, JSON.parse(parent.providerConfig || 'null')) : null;

  const { startNewSession } = await import('@/lib/server/agent/sessionOps');
  const stream = await startNewSession({
    vpsId: parent.vpsId, cwd, name: ev.name?.trim() || nameFromTask(ev.task), kind,
    permissionMode: mode, model, effort, sessionConfig: parentConfig,
    parentSessionId: parent.id,
    // A hidden session's children are born hidden (§14.118).
    hidden: parent.hidden === 1,
  });
  const handle = db.select({ h: agentSessions.handle }).from(agentSessions)
    .where(eq(agentSessions.id, stream.id)).get()?.h ?? null;
  return { session_id: stream.id, handle, provider: kind, mode, mode_clamped: clamped, client };
}

export async function handlePeerSpawnRequest(parentId: string, ev: SpawnRequest): Promise<void> {
  const now = Date.now();
  pruneSeen(now);
  if (!ev.request_id || seen.has(ev.request_id)) return;
  seen.set(ev.request_id, now);
  const client = (() => {
    try {
      const p = db.select({ vpsId: agentSessions.vpsId }).from(agentSessions)
        .where(eq(agentSessions.id, parentId)).get();
      return p ? getAgentClientForVpsId(p.vpsId) : null;
    } catch { return null; }
  })();
  let params: Record<string, unknown>;
  let createdId: string | null = null;
  try {
    const r = await resolveRequest(parentId, ev);
    const { client: _c, ...rest } = r;
    createdId = r.session_id;
    params = { request_id: ev.request_id, ok: true, ...rest };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn(`[sub-sessions] spawn from ${parentId} refused: ${msg}`);
    params = { request_id: ev.request_id, ok: false, error: msg.slice(0, 300) };
  }
  // A created child nobody will task (daemon gave up, resolve failed) is removed.
  let delivered = false;
  try {
    if (client) {
      const r = await client.call<{ known?: boolean }>('peer_spawn_resolve', params);
      delivered = r?.known !== false;
    }
  } catch (e) {
    console.warn(`[sub-sessions] peer_spawn_resolve failed: ${(e as Error)?.message ?? e}`);
  }
  if (createdId && !delivered) {
    try {
      const { deleteSession } = await import('@/lib/server/agent/sessionOps');
      await deleteSession(createdId);
    } catch (e) {
      console.warn(`[sub-sessions] orphan child ${createdId} cleanup failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
