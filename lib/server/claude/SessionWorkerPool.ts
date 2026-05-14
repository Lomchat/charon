import 'server-only';
import { eq } from 'drizzle-orm';
import { db, claudeSessions } from '@/lib/db';
import { SessionWorker, vpsById, newWorkerId } from './SessionWorker';
import type { PermissionMode } from './types';

const g = globalThis as unknown as { _claudePool?: Map<string, SessionWorker> };
if (!g._claudePool) g._claudePool = new Map();
const pool: Map<string, SessionWorker> = g._claudePool;

export function getWorker(sessionId: string): SessionWorker | undefined {
  return pool.get(sessionId);
}

export function listWorkers(): SessionWorker[] {
  return Array.from(pool.values());
}

export async function startNew(opts: {
  vpsId: string;
  cwd: string;
  name?: string | null;
  projectId?: string | null;
  permissionMode?: PermissionMode;
}): Promise<SessionWorker> {
  const vps = vpsById(opts.vpsId);
  if (!vps) throw new Error('vps not found');
  const id = newWorkerId();
  db.insert(claudeSessions).values({
    id,
    vpsId: opts.vpsId,
    cwd: opts.cwd,
    projectId: opts.projectId ?? null,
    name: opts.name ?? null,
    status: 'active',
    permissionMode: opts.permissionMode ?? 'normal',
    lastUsedAt: Math.floor(Date.now() / 1000),
  }).run();
  const w = new SessionWorker({
    id, vps,
    cwd: opts.cwd,
    name: opts.name,
    permissionMode: opts.permissionMode,
  });
  pool.set(id, w);
  await w.start();
  return w;
}

export async function importExisting(opts: {
  vpsId: string;
  cwd: string;
  claudeSessionId: string;
  name?: string | null;
  projectId?: string | null;
  permissionMode?: PermissionMode;
}): Promise<string> {
  const vps = vpsById(opts.vpsId);
  if (!vps) throw new Error('vps not found');
  const id = newWorkerId();
  db.insert(claudeSessions).values({
    id,
    vpsId: opts.vpsId,
    claudeSessionId: opts.claudeSessionId,
    cwd: opts.cwd,
    projectId: opts.projectId ?? null,
    name: opts.name ?? null,
    status: 'sleeping',
    permissionMode: opts.permissionMode ?? 'normal',
  }).run();
  return id;
}

export async function resume(sessionId: string): Promise<SessionWorker> {
  let w = pool.get(sessionId);
  if (w && w.status !== 'sleeping' && w.status !== 'killed' && w.status !== 'error') return w;
  // Lire la DB
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) throw new Error('session not found in DB');
  if (row.status === 'killed') throw new Error('session killed (cannot resume)');
  const vps = vpsById(row.vpsId);
  if (!vps) throw new Error('vps no longer exists');
  w = new SessionWorker({
    id: row.id,
    vps,
    cwd: row.cwd,
    name: row.name,
    permissionMode: (
      row.permissionMode === 'bypass' ? 'bypass'
      : row.permissionMode === 'plan' ? 'plan'
      : row.permissionMode === 'acceptEdits' ? 'acceptEdits'
      : 'normal'
    ),
    claudeSessionId: row.claudeSessionId,
  });
  pool.set(sessionId, w);
  db.update(claudeSessions).set({ status: 'active' }).where(eq(claudeSessions.id, sessionId)).run();
  await w.start();
  return w;
}

export async function sleep(sessionId: string): Promise<void> {
  const w = pool.get(sessionId);
  if (w) {
    await w.sleep();
    pool.delete(sessionId);
  } else {
    db.update(claudeSessions).set({ status: 'sleeping' }).where(eq(claudeSessions.id, sessionId)).run();
  }
}

export async function kill(sessionId: string): Promise<void> {
  const w = pool.get(sessionId);
  if (w) {
    await w.kill();
    pool.delete(sessionId);
  } else {
    db.update(claudeSessions).set({ status: 'killed' }).where(eq(claudeSessions.id, sessionId)).run();
  }
}
