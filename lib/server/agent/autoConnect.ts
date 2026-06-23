import 'server-only';
import { eq, inArray } from 'drizzle-orm';
import { db, claudeSessions, vps as vpsTable, claudeSessionLogs } from '@/lib/db';
import { getAgentClient, getAgentClientForVpsId } from './AgentClientPool';
import { reconcileVpsAgentState, resumeSession } from './sessionOps';
import { refreshClaudeLoginStatusIfStale } from './claudeLoginCheck';
import { ensureShellIdleWatch } from './shellNotify';
import { refreshModelsIfStale } from '@/lib/server/claude/modelSync';
import type { Vps } from '@/lib/db/schema';

const g = globalThis as unknown as { _agentBooted?: boolean };

/**
 * On Charon boot: for each VPS in DB, start the connection to its agent
 * in the background and wire a hook that reconciles state as soon as the
 * SSH is established (on every (re)connection, not just at boot).
 *
 * The `onStatus('connected')` hook is what makes the system self-healing
 * after a `systemctl restart charon`: we read `hello.sessions` (sessions
 * that are REALLY alive on the agent side) and (re)attach the SessionStreams
 * + resync the DB status. Cf. `reconcileVpsAgentState` for the details.
 *
 * In parallel we attempt an opportunistic resume for DB sessions in
 * 'active'/'thinking'/'starting' — useful when the agent is reachable
 * immediately (common case), or as a fallback if the onStatus hook already
 * fired before we subscribed (HMR dev).
 *
 * Idempotent (guard `_agentBooted`).
 */
export function autoConnectAgentsIfNeeded(): void {
  if (g._agentBooted) return;
  g._agentBooted = true;
  // Opt-out for local dev / CI / demos (CHARON_DISABLE_AUTOCONNECT=1): skip the
  // boot-time fan-out that connects to every VPS agent + arms the
  // reconcile/auto-resume hook. On-demand connections (opening a shell, a
  // lifecycle action via getAgentClientForVpsId) still work. Leave UNSET in
  // production — setting it means sessions won't live-update until a tab acts.
  if (process.env.CHARON_DISABLE_AUTOCONNECT === '1') return;
  // Hub-global, key-gated, 24h-throttled refresh of the Claude model catalog
  // from GET /v1/models (no-op without `claude.api_key`). Not per-VPS — the
  // model list is an Anthropic-side concept. Cf. lib/server/claude/modelSync.ts.
  refreshModelsIfStale();
  setImmediate(() => {
    let vpses: Vps[] = [];
    try {
      vpses = db.select().from(vpsTable).all();
    } catch {
      return;
    }
    for (const v of vpses) {
      try {
        const client = getAgentClient(v);
        // Self-healing hook: on every (re)connection of the SSH, reconcile.
        client.onStatus((status) => {
          if (status !== 'connected') return;
          const hello = client.hello;
          if (!hello) return;
          reconcileVpsAgentState(v.id, hello.sessions).catch(() => {});
          // Register the global shell-idle watcher (idempotent per client) so
          // a shell going quiet after a consequential output burst pushes a
          // "finished" notification. Cheap, output-free — see shellNotify.ts.
          ensureShellIdleWatch(client);
          // Auto-check `claude login` if we've never checked or if the
          // last check is too old (TTL 24h). Re-query the row to get an
          // up-to-date `claudeLoggedInCheckedAt` (otherwise the closure
          // `v` is stale and we'd re-check on every SSH reconnect).
          // Cf. `claudeLoginCheck.ts` for the logic.
          try {
            const [fresh] = db.select().from(vpsTable).where(eq(vpsTable.id, v.id)).all();
            if (fresh) refreshClaudeLoginStatusIfStale(fresh).catch(() => {});
          } catch {}
        });
        // Case where the client is already connected when we register the
        // hook (can happen in dev HMR — otherwise unlikely at cold boot).
        if (client.status === 'connected' && client.hello) {
          reconcileVpsAgentState(v.id, client.hello.sessions).catch(() => {});
          ensureShellIdleWatch(client);
          try {
            const [fresh] = db.select().from(vpsTable).where(eq(vpsTable.id, v.id)).all();
            if (fresh) refreshClaudeLoginStatusIfStale(fresh).catch(() => {});
          } catch {}
        }
      } catch {}
    }

    // Best-effort: attempt a direct resume for DB sessions currently
    // running. The reconcile-on-hello below will cleanly handle the case
    // where the agent takes time to connect; but this first direct shot
    // makes chats usable as soon as the connection succeeds, without
    // waiting for a status event. Extended from 'active' only to
    // 'active'/'thinking'/'starting' (bug observed: after SIGTERM during
    // a query, the session stayed 'thinking' in DB and was ignored here).
    let active: { id: string; vpsId: string }[] = [];
    try {
      active = db.select({ id: claudeSessions.id, vpsId: claudeSessions.vpsId })
        .from(claudeSessions)
        .where(inArray(claudeSessions.status, ['active', 'thinking', 'starting']))
        .all();
    } catch {
      return;
    }
    for (const s of active) {
      resumeSession(s.id)
        .then(() => {
          try {
            db.insert(claudeSessionLogs).values({
              sessionId: s.id, level: 'info', event: 'auto_resume', detail: null,
            }).run();
          } catch {}
        })
        .catch((e) => {
          try {
            db.insert(claudeSessionLogs).values({
              sessionId: s.id, level: 'warn', event: 'auto_resume',
              detail: JSON.stringify({ err: e?.message ?? String(e) }),
            }).run();
            // FALSE-SLEEP FIX (CLAUDE.md §14.45, RC3). Only degrade to
            // 'sleeping' if the agent is GENUINELY UNREACHABLE. This
            // opportunistic resume fires from a `setImmediate` at boot, often
            // BEFORE the per-VPS SSH has finished connecting — so a slow
            // connect makes resumeSession reject on its 30s ready() / 60s RPC
            // timeout even though the session is still LIVE on the agent.
            // Writing 'sleeping' there falsely paused a running session ("on
            // dit sleeping, l'agent bosse"). When the agent IS connected, the
            // onStatus('connected') → reconcileVpsAgentState hook reads
            // hello.sessions (ground truth), attaches the stream and sets the
            // real status — so we must NOT overwrite with a guessed 'sleeping'.
            let connected = false;
            try { connected = getAgentClientForVpsId(s.vpsId).status === 'connected'; } catch {}
            if (!connected) {
              db.update(claudeSessions).set({ status: 'sleeping' })
                .where(eq(claudeSessions.id, s.id)).run();
            }
          } catch {}
        });
    }
  });
}
