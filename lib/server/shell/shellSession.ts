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
  try {
    db.insert(shellsTable).values({
      id, vpsId, cwd: cleanCwd, name: opts.name ?? null, color: null,
    }).run();
  } catch (e) {
    // Compensating kill: the remote holder was already spawned; without a DB
    // row it would be an invisible orphan (unfindable and unkillable from
    // the UI). Best-effort — worst case the shell_watch snapshot reconcile
    // has no row to prune and the holder idles until the VPS reboots.
    try { await client.call('shell_kill', { shell_id: id }); } catch {}
    throw e;
  }
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
  if (rows.length === 0) return [];
  // One query for all VPS names instead of one per shell (P2.2).
  const names = new Map(
    db.select({ id: vpsTable.id, name: vpsTable.name }).from(vpsTable).all()
      .map((v) => [v.id, v.name] as const),
  );
  return rows.map((r) => rowToInfo(r, names.get(r.vpsId) ?? '?'));
}

export type StopShellResult =
  | { ok: true; forced?: boolean }
  | { ok: false; notFound?: boolean; error: string };

// "Stop" vs "forget" (P0.6): killing the remote PTY and dropping the DB row
// are two different things. The holder is DETACHED (survives the agent, cf.
// holder.py) — the old "the bash will die with the agent eventually" comment
// was wrong since 0.10.0. So:
//   - default: only drop the DB row once the agent CONFIRMED the kill (an
//     "unknown shell" answer counts — already gone). On RPC failure the row
//     stays and the caller reports the error.
//   - force=true ("forget"): drop the row even if the kill failed — explicit
//     user decision when the VPS is unreachable for good.
export async function stopShell(id: string, opts: { force?: boolean } = {}): Promise<StopShellResult> {
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, id)).all();
  if (!row) return { ok: false, notFound: true, error: 'shell not found' };
  let killed = false;
  let killError = '';
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    await client.call('shell_kill', { shell_id: id });
    killed = true;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // -32000 "session/shell not found" = already gone on the agent side —
    // deleting the row is the CORRECT outcome, not a forced one.
    if (/not found|-32000/i.test(msg)) killed = true;
    else killError = msg;
  }
  if (killed || opts.force) {
    db.delete(shellsTable).where(eq(shellsTable.id, id)).run();
    return killed ? { ok: true } : { ok: true, forced: true };
  }
  return { ok: false, error: killError || 'shell_kill failed' };
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
// ── Periodic BIDIRECTIONAL reconcile (P0.6) ─────────────────────────────────
// The event-driven paths (boot reconcile, shell_watch snapshot, failed
// subscribe prune) are all DB → prune only: an agent-side shell that lost its
// DB row (crashed insert pre-2026-07, manual DB surgery, …) ran forever,
// invisible and unkillable. Every 10 min, per healthy VPS:
//   - DB rows unknown to the agent → prune (catches drift the event paths
//     missed while disconnected);
//   - agent shells with NO DB row → kill, but only when seen orphaned on TWO
//     consecutive ticks (grace: a shell being created legitimately exists
//     between the shell_start RPC and the DB insert).
const gRec = globalThis as unknown as { _shellReconcileTimer?: ReturnType<typeof setInterval>; _shellOrphanSeen?: Set<string> };

export function armShellReconcileLoop(): void {
  if (gRec._shellReconcileTimer) return;
  if (!gRec._shellOrphanSeen) gRec._shellOrphanSeen = new Set();
  const orphanSeen = gRec._shellOrphanSeen;
  const tick = async () => {
    let vpsRows: { id: string; agentStatus: string | null }[];
    try {
      vpsRows = db.select({ id: vpsTable.id, agentStatus: vpsTable.agentStatus }).from(vpsTable).all();
    } catch { return; }
    for (const v of vpsRows) {
      if (v.agentStatus !== 'ok') continue;
      try {
        const client = getAgentClientForVpsId(v.id);
        const list = await client.call<AgentShellInfo[]>('shell_list', {});
        const agentIds = new Set((list ?? []).map((s) => s.shell_id));
        const dbRows = db.select().from(shellsTable).where(eq(shellsTable.vpsId, v.id)).all();
        const dbIds = new Set(dbRows.map((r) => r.id));
        // DB phantom → prune.
        for (const r of dbRows) {
          if (!agentIds.has(r.id)) {
            try { db.delete(shellsTable).where(eq(shellsTable.id, r.id)).run(); } catch {}
          }
        }
        // Agent orphan → kill on the second consecutive sighting.
        for (const id of agentIds) {
          if (dbIds.has(id)) { orphanSeen.delete(id); continue; }
          if (orphanSeen.has(id)) {
            orphanSeen.delete(id);
            console.warn(`[shells] killing orphaned agent-side shell ${id} on ${v.id} (no DB row, 2 ticks)`);
            try { await client.call('shell_kill', { shell_id: id }); } catch {}
          } else {
            orphanSeen.add(id);
          }
        }
      } catch {
        // VPS unreachable this tick — try again next tick.
      }
    }
  };
  gRec._shellReconcileTimer = setInterval(() => { tick().catch(() => {}); }, 10 * 60_000);
  (gRec._shellReconcileTimer as unknown as { unref?: () => void }).unref?.();
}

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
