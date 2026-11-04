import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db, shells as shellsTable, vps as vpsTable } from '@/lib/db';
import { sendPushToAll } from '@/lib/server/hub/webPush';
import { sendPlainToTelegram } from '@/lib/server/hub/telegram';
import { emitGlobalShellStatus, emitGlobalShellUnread } from './sessionOps';
import { hubHooks } from './hubHooks';
import type { AgentClient } from './AgentClient';
import type { AgentEvent } from './types';

// ── Shell "finished what you asked" notifications (§14.42) ───────────────────
//
// The agent emits a transient `shell_idle` event when the work started by a
// SUBMIT is over: a command returned to the prompt, or a program typed into
// (claude, codex, a REPL) answered and went quiet — rules in
// agent/charon_agent/shell_activity.py. This is the shell counterpart of the
// Claude session "stop" push: start a build or ask `claude` in a shell, walk
// away, get pinged when it is done.
//
// Transport: Charon's PERSISTENT AgentClient (the pool, one per VPS) registers
// ONE global lifecycle watcher per VPS via `client.watchShells(...)` →
// `shell_watch` RPC. That delivers shell_status / shell_exit / shell_idle for
// ALL shells on the VPS WITHOUT the high-volume shell_output byte stream. This
// is deliberately decoupled from the per-WS output proxies in server.js: we do
// NOT want to stream shell bytes through the Next process a second time (the
// double-egress that got a VPS suspended — see §14 gotcha 41). We only react to
// the lightweight lifecycle signal here.
//
// `shell_idle` is transient on the agent (not written to the durable log, no
// seq) so a full-log replay on reconnect never re-fires a stale "finished" ping.

// Per-client idempotency: a given AgentClient object registers its watcher
// exactly once. A WeakSet (not a Set) so a dropped+recreated client (refresh
// endpoint, credentials change) is GC'd without leaking, and the fresh object
// registers its own watcher. On `hubHooks()` (§14.106): a per-module-copy set
// let a second copy register a second watcher — every alert sent twice.
function watchedClients(): WeakSet<object> {
  return (hubHooks().shellWatchedClients ??= new WeakSet<object>());
}

/**
 * Ensure the given AgentClient is watching shell lifecycle events. This single
 * watcher does double duty:
 *   - `shell_idle` → a push/telegram "finished something" notification.
 *   - `shell_status` / `shell_exit` → fanned onto the global SSE bus
 *     (`emitGlobalShellStatus`) so every browser tab colors the shell's
 *     tab/dot live (blue "thinking" while busy, gray on exit). Agent >= 0.9.0.
 *
 * Idempotent per client object; safe to call on every `connected` transition
 * (the underlying `shell_watch` RPC is re-fired automatically by the client's
 * reconnect path). The watch is output-free (no shell_output) — see the header
 * comment for why we must not re-egress shell bytes here.
 */
export function ensureShellIdleWatch(client: AgentClient): void {
  const watched = watchedClients();
  if (watched.has(client)) return;
  watched.add(client);
  client.watchShells((ev) => {
    try {
      if (ev.event === 'shell_status') {
        emitGlobalShellStatus(ev.shell_id, ev.status, noteShellStatus(ev.shell_id, ev.status) ?? undefined);
      } else if (ev.event === 'shell_exit') {
        hubHooks().busyShells?.delete(ev.shell_id);
        emitGlobalShellStatus(ev.shell_id, 'exited');
      } else if (ev.event === 'shell_idle') {
        // The time rides a status frame carrying the status it already has.
        const at = recordShellActivity(ev.shell_id);
        const busy = hubHooks().busyShells?.has(ev.shell_id) ?? false;
        if (at != null) emitGlobalShellStatus(ev.shell_id, busy ? 'busy' : 'active', at);
        handleShellIdle(ev);
      }
    } catch (e: any) {
      console.warn('[shellNotify] watch:', e?.message ?? e);
    }
  });
  // Reconcile the `shells` DB rows against the live snapshot the agent
  // returns with every (re)armed shell_watch — i.e. on every agent
  // (re)connect, not just at Charon boot (reconcileShellsOnBoot). This is
  // what retires phantom rows when shells died while nobody was looking
  // (VPS reboot, bash exited, holder killed): without it the browser
  // reconnect-loops forever on a WS to a shell the agent doesn't know.
  // With the 0.10.0 holder, agent restarts no longer kill shells, so this
  // fires rarely — but when it does, it's the difference between a clean
  // "ended" tab and an infinite "reconnecting…".
  client.onShellSnapshot((live) => {
    try {
      const liveIds = new Set(live.map((s) => s.shell_id));
      const rows = db.select().from(shellsTable)
        .where(eq(shellsTable.vpsId, client.vps.id)).all();
      for (const row of rows) {
        if (!liveIds.has(row.id)) {
          db.delete(shellsTable).where(eq(shellsTable.id, row.id)).run();
          emitGlobalShellStatus(row.id, 'exited');
          console.warn(`[shellNotify] pruned phantom shell ${row.id} (${client.vps.name})`);
        }
      }
    } catch (e: any) {
      console.warn('[shellNotify] snapshot reconcile:', e?.message ?? e);
    }
  });
}

/**
 * The busy→active edge is activity: a shell that streamed and went quiet.
 * An `active` with no busy before it is not (every holder re-attach announces
 * one). Returns the persisted time to publish, or null when nothing moved.
 */
export function noteShellStatus(shellId: string, status: 'active' | 'busy' | 'exited'): number | null {
  const busy = (hubHooks().busyShells ??= new Set<string>());
  if (status === 'busy') { busy.add(shellId); return null; }
  if (!busy.delete(shellId) || status !== 'active') return null;
  return recordShellActivity(shellId);
}

/** Persist "this shell did something now"; null for an unknown shell. */
export function recordShellActivity(shellId: string, now = Date.now()): number | null {
  const res = db.update(shellsTable).set({ lastActivityMs: now })
    .where(eq(shellsTable.id, shellId)).run();
  return res.changes > 0 ? now : null;
}

/**
 * The shell twin of a session's finished-unread marker (§14.47): a finish
 * nobody ATTENDED lights it — the same `focusChecker` (an attended conn
 * focused on the shell, or one that left it within the grace AFTER its last
 * output). Persist, then publish; before any push.
 */
export function markShellFinished(shellId: string, lastOutputAtMs?: number | null): void {
  if (hubHooks().focusChecker?.(shellId, lastOutputAtMs) ?? false) return;
  const res = db.update(shellsTable).set({ unreadFinish: 1 })
    .where(and(eq(shellsTable.id, shellId), eq(shellsTable.unreadFinish, 0))).run();
  if (res.changes > 0) emitGlobalShellUnread(shellId, true);
}

/** Attended focus on the shell (POST /api/focus): it is read.
 *  Writes and publishes only when it was unread. */
export function markShellRead(shellId: string): void {
  try {
    const res = db.update(shellsTable).set({ unreadFinish: 0 })
      .where(and(eq(shellsTable.id, shellId), eq(shellsTable.unreadFinish, 1))).run();
    if (res.changes > 0) emitGlobalShellUnread(shellId, false);
  } catch {}
}

function handleShellIdle(ev: Extract<AgentEvent, { event: 'shell_idle' }>): void {
  const shellId = ev.shell_id;
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, shellId)).all();
  if (!row) return; // unknown shell (not in our DB) → nothing to label/link
  // The in-app marker never trails the push. `idle_seconds` = time since the
  // output that ended it (agent clock offset is irrelevant: a duration).
  const quietMs = Number.isFinite(ev.idle_seconds) ? Math.max(0, ev.idle_seconds) * 1000 : 0;
  markShellFinished(shellId, Date.now() - quietMs);

  const [v] = db
    .select({ name: vpsTable.name })
    .from(vpsTable)
    .where(eq(vpsTable.id, row.vpsId))
    .all();
  const vpsName = v?.name ?? '?';

  const cwdLeaf = row.cwd ? row.cwd.split('/').filter(Boolean).slice(-1)[0] : '';
  const label = row.name || cwdLeaf || shellId.slice(0, 6);

  const title = `⌨ ${vpsName} · ${label}`;
  const body = shellFinishedBody(ev);

  sendPushToAll({
    event: 'shell_idle', title, body,
    url: `/?shell=${shellId}`, tag: `shell-idle-${shellId}`,
  }).catch(() => {});
  sendPlainToTelegram(`${title}\n${body}`, `/?shell=${shellId}`, 'shell_idle').catch(() => {});
}

/** "npm install finished after 2m 05s" / "claude finished after 45s — waiting
 *  for you". An agent older than 0.106.0 sends no `reason`: its old wording. */
export function shellFinishedBody(ev: Extract<AgentEvent, { event: 'shell_idle' }>): string {
  const seconds = typeof ev.work_seconds === 'number' ? ev.work_seconds : ev.burst_seconds;
  const took = formatWorkDuration(seconds);
  const name = typeof ev.command === 'string'
    ? ev.command.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 32)
    : '';
  if (ev.reason === 'command') return `${name || 'The command'} finished after ${took}`;
  if (ev.reason === 'turn') return `${name || 'The program'} finished after ${took} — waiting for you`;
  return `The shell went quiet after ${took} of output — finished something`;
}

export function formatWorkDuration(seconds: number): string {
  const s = Math.max(1, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
