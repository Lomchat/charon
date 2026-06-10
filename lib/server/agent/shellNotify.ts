import 'server-only';
import { eq } from 'drizzle-orm';
import { db, shells as shellsTable, vps as vpsTable } from '@/lib/db';
import { getSettingBool } from '@/lib/server/claude/settings';
import { sendPushToAll } from '@/lib/server/claude/webPush';
import { sendPlainToTelegram } from '@/lib/server/claude/telegram';
import { emitGlobalShellStatus } from './sessionOps';
import type { AgentClient } from './AgentClient';
import type { AgentEvent } from './types';

// ── Shell-idle "finished something" notifications (agent >= 0.8.0) ───────────
//
// The agent emits a transient `shell_idle` event when a persistent shell goes
// active→idle after a "consequential" output burst (see the heuristic in
// agent/charon_agent/shell.py). This is the shell counterpart of the Claude
// session "stop" push: it lets the user open `codex`/`claude`/a long build in
// a shell, walk away, and get pinged when the output settles.
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
// registers its own watcher.
const watched = new WeakSet<AgentClient>();

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
  if (watched.has(client)) return;
  watched.add(client);
  client.watchShells((ev) => {
    try {
      if (ev.event === 'shell_status') {
        emitGlobalShellStatus(ev.shell_id, ev.status);
      } else if (ev.event === 'shell_exit') {
        emitGlobalShellStatus(ev.shell_id, 'exited');
      } else if (ev.event === 'shell_idle') {
        handleShellIdle(ev);
      }
    } catch (e: any) {
      console.warn('[shellNotify] watch:', e?.message ?? e);
    }
  });
}

function handleShellIdle(ev: Extract<AgentEvent, { event: 'shell_idle' }>): void {
  // Global notif switch AND the shell-specific switch must both be on.
  if (!getSettingBool('notif.global_enabled')) return;
  if (!getSettingBool('shell.notify_idle')) return;

  const shellId = ev.shell_id;
  const [row] = db.select().from(shellsTable).where(eq(shellsTable.id, shellId)).all();
  if (!row) return; // unknown shell (not in our DB) → nothing to label/link

  const [v] = db
    .select({ name: vpsTable.name })
    .from(vpsTable)
    .where(eq(vpsTable.id, row.vpsId))
    .all();
  const vpsName = v?.name ?? '?';

  const cwdLeaf = row.cwd ? row.cwd.split('/').filter(Boolean).slice(-1)[0] : '';
  const label = row.name || cwdLeaf || shellId.slice(0, 6);
  const secs = Math.max(1, Math.round(ev.burst_seconds));

  const title = `⌨ ${vpsName} · ${label}`;
  const body = `The shell went quiet after ${secs}s of output — finished something`;

  // Web push: `url` is the service-worker openWindow fallback (no sessionId —
  // this is a shell, deep-linked via `?shell=`; ClaudePanel selects it).
  sendPushToAll({
    title,
    body,
    url: `/?shell=${shellId}`,
    tag: `shell-idle-${shellId}`,
  }).catch(() => {});

  // Telegram: plain text, no buttons (nothing to respond to).
  sendPlainToTelegram(`${title}\n${body}`).catch(() => {});
}
