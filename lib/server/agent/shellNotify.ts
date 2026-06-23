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

function handleShellIdle(ev: Extract<AgentEvent, { event: 'shell_idle' }>): void {
  // `shell.notify_idle` is the shell-specific master for BOTH channels. The
  // per-channel gating below keeps browser push and Telegram INDEPENDENT
  // (CLAUDE.md §7 / §14.42): push → notif.global_enabled; Telegram → its own
  // telegram.enabled (checked inside sendPlainToTelegram→configured()).
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

  // Web push (browser channel): gated by the browser/push master. `url` is the
  // service-worker openWindow fallback (no sessionId — this is a shell,
  // deep-linked via `?shell=`; ClaudePanel selects it).
  if (getSettingBool('notif.global_enabled')) {
    sendPushToAll({
      title,
      body,
      url: `/?shell=${shellId}`,
      tag: `shell-idle-${shellId}`,
    }).catch(() => {});
  }

  // Telegram (independent channel): plain text, no buttons. Self-gated by
  // telegram.enabled inside sendPlainToTelegram→configured(). The deep-link
  // path mirrors the push `url` (`?shell=` → ClaudePanel selects the shell).
  sendPlainToTelegram(`${title}\n${body}`, `/?shell=${shellId}`).catch(() => {});
}
