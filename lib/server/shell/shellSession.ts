import 'server-only';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, shells as shellsTable, vps as vpsTable } from '@/lib/db';
import type { Shell } from '@/lib/db/schema';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import type { AgentShellInfo } from '@/lib/server/agent/types';

// ── Persistent SSH shells, hosted by a detached holder on the VPS ───────────
//
// The PTY (bash) runs in a DETACHED holder process (agent >= 0.10.0, cf.
// agent/charon_agent/holder.py); the agent is a client of the holder and
// streams output via the standard `_emit` pipeline (durable per-shell event
// log under ~/.charon/shells/ + live broadcast). This file is a THIN
// coordinator on the Charon side:
//
//   - DB row CRUD (`shells` table) — the index of known shells per VPS.
//   - Lifecycle RPC: `shell_start`, `shell_kill`.
//   - Boot reconcile: `shell_list` per VPS; drop DB rows the agent doesn't know.
//   - PATCH metadata (name / color).
//
// The live data path (input bytes from the browser, output bytes to the
// browser, resize) is HANDLED ELSEWHERE: server.js opens a WebSocket per
// shell with its own ssh proxy and pipes bytes both ways, replaying the
// durable-log TAIL on every (re)connect (after_seq:0 + tail_bytes — no
// cursor; the vestigial `shells.last_seen_seq` was dropped in 0016).
//
// Persistence semantics (agent >= 0.10.0):
//   - Survives Charon restart ✓ (bash keeps running; the WS replays the tail).
//   - Survives AGENT restart ✓ (bash lives in the holder; the new agent
//     re-attaches via ~/.charon/shells/<id>.sock and ingests the offline
//     spool — no scrollback hole).
//   - Does NOT survive a VPS reboot ✗ — that's what the prune paths are for:
//     reconcileShellsOnBoot here, the shell_watch snapshot reconcile in
//     shellNotify.ts, and server.js's failed-subscribe prune.

export type ShellInfo = {
  id: string;
  vpsId: string;
  vpsName: string;
  cwd: string | null;
  name: string | null;
  color: string | null;
  startedAt: number;
  // The "exited" field is kept in the type for backward compatibility with
  // existing consumers (ClaudePanel filters by it). With the agent-hosted
  // design the source of truth lives on the agent — `shell_list` returns
  // the live status — but we materialise the DB-only view as exited=false
  // until the user explicitly closes the shell. Truly-dead shells are
  // pruned by `reconcileShellsOnBoot`.
  exited: boolean;
  exitCode: number | null;
  // Live activity status fed by the agent's `shell_status` busy/active
  // events (agent >= 0.9.0) over the global SSE bus — NOT persisted in DB
  // (the row only knows the shell EXISTS, not whether it's streaming). The
  // DB-backed producers below leave it undefined; ClaudePanel fills it from
  // the bus. undefined = unknown → treat as idle/at-prompt. 'busy' = the PTY
  // is streaming output → the UI paints the tab/dot like a "thinking" Claude
  // session (blue). See §14 gotcha 42.
  liveStatus?: 'active' | 'busy';
};

function vpsNameOf(vpsId: string): string {
  const [v] = db.select({ name: vpsTable.name }).from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  return v?.name ?? '?';
}

function rowToInfo(row: Shell, vpsName: string): ShellInfo {
  return {
    id: row.id,
    vpsId: row.vpsId,
    vpsName,
    cwd: row.cwd,
    name: row.name,
    color: row.color,
    startedAt: row.createdAt * 1000,
    exited: false,
    exitCode: null,
  };
}

// ── Public API consumed by the /api/shells* routes ───────────────────────────

export async function startShell(
  vpsId: string,
  cwd: string | null,
  opts: { name?: string | null; cols?: number; rows?: number } = {},
): Promise<ShellInfo> {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) throw new Error('vps not found');
  const id = crypto.randomBytes(8).toString('hex');
  const cleanCwd = cwd && cwd.trim() ? cwd.trim() : null;
  const client = getAgentClientForVpsId(vpsId);
  // The agent spawns the PTY. We pass our chosen id so the agent + DB stay
  // in sync without a separate echo step. cols/rows are a sensible default
  // until the browser sends a resize once the xterm fit happens.
  await client.call('shell_start', {
    shell_id: id,
    cwd: cleanCwd,
    name: opts.name ?? null,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
  });
  db.insert(shellsTable).values({
    id, vpsId, cwd: cleanCwd, name: opts.name ?? null, color: null,
  }).run();
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, id)).all();
  return rowToInfo(row!, v.name);
}

export function getShell(id: string): ShellInfo | null {
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, id)).all();
  if (!row) return null;
  return rowToInfo(row, vpsNameOf(row.vpsId));
}

export function listShells(): ShellInfo[] {
  const rows = db.select().from(shellsTable).all();
  return rows.map((r) => rowToInfo(r, vpsNameOf(r.vpsId)));
}

export async function stopShell(id: string): Promise<boolean> {
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, id)).all();
  if (!row) return false;
  // Best-effort: tell the agent to kill the PTY. If the agent is
  // unreachable we still drop the DB row — the bash will die with the
  // agent eventually, and the user expected the shell to be gone.
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    await client.call('shell_kill', { shell_id: id });
  } catch {}
  db.delete(shellsTable).where(eq(shellsTable.id, id)).run();
  return true;
}

export function updateShellMeta(
  id: string,
  patch: { name?: string | null; color?: string | null },
): ShellInfo | null {
  const fields: Partial<Pick<Shell, 'name' | 'color'>> = {};
  if ('name' in patch) fields.name = patch.name ?? null;
  if ('color' in patch) fields.color = patch.color ?? null;
  if (Object.keys(fields).length > 0) {
    db.update(shellsTable).set(fields).where(eq(shellsTable.id, id)).run();
  }
  return getShell(id);
}

// ── Boot reconcile ───────────────────────────────────────────────────────────
// For each VPS with shell rows in DB, ask the agent `shell_list`. Any DB
// row whose shell_id is NOT in the live list gets pruned — typically this
// happens after an agent restart (the bash children died with the agent
// process, the new agent has an empty shells map). Best-effort and per-VPS:
// if the agent is unreachable we leave the rows untouched (might be a
// transient SSH drop). Called from seed.ts via `seedInitialData`.
export async function reconcileShellsOnBoot(): Promise<void> {
  let rows: Shell[];
  try {
    rows = db.select().from(shellsTable).all();
  } catch { return; }
  if (rows.length === 0) return;
  const byVps = new Map<string, Shell[]>();
  for (const r of rows) {
    const arr = byVps.get(r.vpsId) ?? [];
    arr.push(r); byVps.set(r.vpsId, arr);
  }
  await Promise.all(Array.from(byVps.entries()).map(async ([vpsId, vpsRows]) => {
    try {
      const client = getAgentClientForVpsId(vpsId);
      const list = await client.call<AgentShellInfo[]>('shell_list', {});
      const live = new Set((list ?? []).map((s) => s.shell_id));
      for (const r of vpsRows) {
        if (!live.has(r.id)) {
          try { db.delete(shellsTable).where(eq(shellsTable.id, r.id)).run(); } catch {}
        }
      }
    } catch {
      // VPS unreachable / agent not responding → leave rows as-is.
    }
  }));
}
