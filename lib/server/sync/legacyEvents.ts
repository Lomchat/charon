import 'server-only';
import { eq } from 'drizzle-orm';
import { db, agentSessions, sessionPendingPermissions, sessionPendingQuestions } from '@/lib/db';
import { getModelNotices } from '@/lib/server/hub/modelNotices';
import { peekStream, sweepExpiredInteractions } from '@/lib/server/agent/sessionOps';
import type { GlobalSessionEvent } from '@/lib/server/agent/sessionOps';
import { listVpsRuntimeSnapshots } from '@/lib/server/agent/vpsRuntimeSnapshot';
import { pickVpsRuntimeFields } from '@/lib/vpsRuntimeFields';
import { listInstalls } from '@/lib/server/install/installSession';
import { parseSuggestions, type PermissionSuggestion } from '@/lib/permissionSuggestions';

// The LEGACY connect snapshot of GET /api/events (no `proto=2`): the
// body every pre-sync-refonte bundle expects, verbatim (Step-2 additions
// included). Kept for rolling deploys (G11): an old tab reconnecting to a new
// hub still gets statuses, unread + bg counts, pendings + ONE
// `pending_snapshot`, installs and the derived VPS keys, then live bus
// frames. Snapshot frames are per-connection and carry NO `id:` (bus frames
// carry theirs). The caller registered the connection NOT live and marks it
// live right after this returns, in the same synchronous tick.
//
// A throw outside the three independent sections propagates: the route then
// closes the stream and unregisters it (never a stream without its end).
export function writeLegacySnapshot(sendNow: (ev: GlobalSessionEvent | Record<string, unknown>) => void): void {
  sendNow({ type: 'model_notices', notices: getModelNotices() });

  // Initial snapshot: status of all sessions + pendings. This lets the
  // client populate its sidebar immediately without depending on
  // GET /api/sessions (which will also be called in parallel but
  // these status events cover it partially).
  //
  // Historical note: we used to filter `status='killed'` sessions here.
  // Since the kill->delete refactor (cf. CLAUDE.md §10), this status is
  // no longer persisted. The filter is kept as an idempotent safeguard
  // in case pre-migration data resurfaces, but should never match.
  // Three independent sections: a failure in one must not starve the
  // others (a VPS read error used to swallow every session status).
  try {
    // VPS runtime state is live-only after this point, so replay a full,
    // browser-safe snapshot on EVERY EventSource connection (including
    // reconnects). The connection goes live in this same tick, so a newer
    // update always reaches it after this snapshot. The key
    // set is DERIVED (§14.52): a hand list dropped the cursor columns.
    for (const v of listVpsRuntimeSnapshots()) {
      sendNow({
        ...pickVpsRuntimeFields(v as unknown as Record<string, unknown>),
        type: 'vps_status',
        sessionId: v.id,
        agentStatus: v.agentStatus as 'unknown' | 'ok' | 'missing' | 'error',
      } as GlobalSessionEvent);
    }
  } catch {}

  try {
    const rows = db.select({
      id: agentSessions.id, status: agentSessions.status,
      archived: agentSessions.archived, unreadStop: agentSessions.unreadStop,
    }).from(agentSessions).all();
    // Archived sessions are out of every list: no status for them.
    const listed = rows.filter((row) => !row.archived && row.status !== 'killed');
    for (const row of listed) {
      // Prefer the live (in-memory) status over the DB one if available.
      const live = peekStream(row.id);
      const effective = live ? live.status : row.status;
      sendNow({ type: 'status', sessionId: row.id, status: effective as any });
    }
    // The other two per-session facts a list row shows. A reconnect used to
    // carry statuses only, so a finish (or a bg-task count change) during
    // the gap stayed invisible until the next list poll (§14.47/§14.91).
    for (const row of listed) {
      if (row.unreadStop === 1) sendNow({ type: 'session_unread', sessionId: row.id, unread: true });
    }
    for (const row of listed) {
      const running = peekStream(row.id)?.runningBgTaskCount() ?? 0;
      if (running > 0) sendNow({ type: 'session_bg_tasks', sessionId: row.id, running });
    }
  } catch {}

  try {
    // Pendings: provider deadlines continue while the browser/hub is
    // disconnected. Repair expired rows before rebuilding the queues; the
    // sweep publishes each expiry (not to this conn, not live yet: the
    // snapshot below already omits the expired gate).
    sweepExpiredInteractions();
    // Replay live ones once to repopulate the client queues
    // (the cross-session popup + the focused session need them).
    const perms = db.select().from(sessionPendingPermissions).where(
      eq(sessionPendingPermissions.status, 'pending'),
    ).all();
    const snapshot: Extract<GlobalSessionEvent, { type: 'pending_snapshot' }> = {
      type: 'pending_snapshot', sessionId: 'pending',
      permissions: [], questions: [], exitPlans: [],
    };
    for (const p of perms) {
      snapshot.permissions.push({ id: p.id, sessionId: p.sessionId });
      let input: any = {};
      try { input = JSON.parse(p.toolInput); } catch {}
      const suggestions = parseSuggestions(p.suggestions);
      sendNow({
        type: 'permission_request', sessionId: p.sessionId, id: p.id,
        tool: p.toolName, input, expiresAt: p.expiresAt ?? undefined,
        ...(p.reason ? { reason: p.reason } : {}),
        ...(suggestions.length ? { suggestions: suggestions as PermissionSuggestion[] } : {}),
      });
    }
    const qs = db.select().from(sessionPendingQuestions).where(
      eq(sessionPendingQuestions.status, 'pending'),
    ).all();
    for (const q of qs) {
      let payload: any = {};
      try { payload = JSON.parse(q.payload); } catch {}
      if (q.kind === 'question' || q.kind === 'async_question') {
        snapshot.questions.push({
          id: q.id, sessionId: q.sessionId,
          ...(q.kind === 'async_question' ? { delivery: 'async' as const } : {}),
        });
        sendNow({
          type: 'user_question', sessionId: q.sessionId, id: q.id,
          questions: payload, expiresAt: q.expiresAt ?? undefined,
          delivery: q.kind === 'async_question' ? 'async' : undefined,
          createdAt: q.createdAt,
          snapshot: true,
        });
      } else if (q.kind === 'exit_plan') {
        snapshot.exitPlans.push({ id: q.id, sessionId: q.sessionId });
        sendNow({
          type: 'exit_plan_request', sessionId: q.sessionId, id: q.id,
          plan: payload?.plan ?? '', expiresAt: q.expiresAt ?? undefined,
        });
      }
    }
    // ONE complete list of what is pending, after the replays: a consumer
    // drops any queued gate it does not name (a resolution it missed while
    // disconnected). Sent only when every pending read succeeded.
    sendNow(snapshot);
  } catch {}

  // Initial snapshot of installs: sends an install_started for each
  // install still active. Lets the client (Sidebar / popup) update
  // at mount without depending on a separate GET.
  try {
    for (const inst of listInstalls()) {
      if (inst.status === 'running') {
        sendNow({
          type: 'install_started',
          installId: inst.id, vpsId: inst.vpsId, vpsName: inst.vpsName,
          status: 'running',
        });
      }
    }
  } catch {}
}
