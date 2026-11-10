import 'server-only';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, agentSessions, vps as vpsTable, sessionLogs } from '@/lib/db';
import { getAgentClient, getAgentClientForVpsId } from './AgentClientPool';
import { reconcileVpsAgentState, resumeSession, setSessionStatusLocal } from './sessionOps';
// Registers the session-summary provider on the sync bus at boot (§14.108).
import '@/lib/server/sync/sessionSummaries';
import { ensureShellIdleWatch } from './shellNotify';
import { armUsageWatch, armCodexUsageWatch } from './usagePoll';
import { armAccountProfileWatch } from './accountProfiles';
import { startInteractionSweeper } from './interactionSweeper';
import { refreshModelsIfStale } from '@/lib/server/hub/modelSync';
import { hubHooks } from './hubHooks';
import { noteHello } from '@/lib/server/hub/sessionRuntimes';
import type { AgentClient } from './AgentClient';
import type { Vps } from '@/lib/db/schema';

const g = globalThis as unknown as { _agentBooted?: boolean };

// Clients whose self-healing hooks are already wired. Keyed by instance so a
// recreated client (dropAgentClient → getAgentClient) re-arms exactly once.
// On `hubHooks()`, not module-level (§14.106): the boot (instrumentation) copy
// arms the boot clients and the vps/refresh/update routes re-arm from the
// route copy — a per-copy set wired a SECOND onStatus hook (double reconcile).
function armedClients(): WeakSet<object> {
  return (hubHooks().armedClients ??= new WeakSet<object>());
}

/**
 * Wire the self-healing `onStatus('connected')` hook on an AgentClient (and
 * fire it once if already connected). On every (re)connection this reconciles
 * the agent's live sessions with the DB + re-attaches the SessionStreams,
 * arms the shell-idle watch, and refreshes the claude-login status.
 *
 * Idempotent per client INSTANCE. CRITICAL after `dropAgentClient` (agent
 * update/refresh/creds-change): the pool builds a FRESH client with an empty
 * subscribers map and NO hook — and `autoConnectAgentsIfNeeded` won't re-run
 * (it's guarded by `_agentBooted`). Without re-arming here, every running
 * session on that VPS would go silent until the next full Charon restart.
 * cf. CLAUDE.md §14.51.
 */
export function armAgentClientHooks(client: AgentClient, vpsId: string): void {
  const armed = armedClients();
  if (armed.has(client)) return;
  armed.add(client);
  const runReconcile = () => {
    const hello = client.hello;
    if (!hello) return;
    // Which sessions still run pre-update code (§14.117); arms the moves.
    noteHello(vpsId, hello);
    // Hub-owned accounts FIRST (§14.115): a session reconcile resumes must
    // find its account's credentials on the box. A failed push is retried by
    // the accounts engine's tick; reconcile never waits on it for long.
    void import('@/lib/server/accounts/engine')
      .then((e) => Promise.race([e.pushAccountsToClient(client), new Promise((r) => setTimeout(r, 15_000))]))
      .catch(() => {})
      .finally(() => { reconcileVpsAgentState(vpsId, hello.sessions).catch(() => {}); });
    void import('@/lib/server/accounts/migration').then((m) => m.scheduleMigration()).catch(() => {});
    // The daemon keeps the hidden set in memory only (§14.118): every connect
    // (restart, hot update) hands it over again.
    void import('@/lib/server/hub/hiddenSessions').then((m) => m.pushPeerHidden(vpsId)).catch(() => {});
    ensureShellIdleWatch(client);
    armAccountProfileWatch(vpsId);
    // Account-usage gauges (§14.58): immediate poll on connect + a steady
    // interval. Idempotent per vpsId; self-gates on claudeLoggedIn.
    armUsageWatch(vpsId);
    // Codex account-usage gauges — only for VPSes that run Codex. We read the
    // agent's LIVE hello (set before the DB persist → correct on the very first
    // connect too), not the DB row. Idempotent per vpsId; the poll self-gates on
    // codex_available + login. cf. CLAUDE.md §14.58 / §14.59.
    if (hello.codex_available) armCodexUsageWatch(vpsId);
    // No stale-login sweeps (loginSweeps.ts): a VPS holds no login of its own
    // any more; the accounts engine owns expiry and the launcher columns.
  };
  client.onStatus((status) => {
    if (status === 'connected') runReconcile();
  });
  // Already connected when we armed (recreated client that connected fast, or
  // dev HMR) → reconcile now, the hook won't fire retroactively.
  if (client.status === 'connected' && client.hello) runReconcile();
}

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
  startInteractionSweeper(); // hub-side gate deadlines (no agent needed, §14.98)
  // Opt-out for local dev / CI / demos (CHARON_DISABLE_AUTOCONNECT=1): skip the
  // boot-time fan-out that connects to every VPS agent + arms the
  // reconcile/auto-resume hook. On-demand connections (opening a shell, a
  // lifecycle action via getAgentClientForVpsId) still work. Leave UNSET in
  // production — setting it means sessions won't live-update until a tab acts.
  if (process.env.CHARON_DISABLE_AUTOCONNECT === '1') return;
  // Hub-global, key-gated, 24h-throttled refresh of the Claude model catalog
  // from GET /v1/models (no-op without `claude.api_key`). Not per-VPS — the
  // model list is an Anthropic-side concept. Cf. lib/server/hub/modelSync.ts.
  refreshModelsIfStale();
  // Hub-owned accounts (§14.115): refresh loop + gauges + launcher columns.
  void import('@/lib/server/accounts/engine').then((e) => { e.ensureAccountsEngine(); e.syncVpsLoginColumns(); }).catch(() => {});
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
        // Self-healing hook: on every (re)connection of the SSH, reconcile +
        // re-attach streams + arm the shell-idle watch + refresh login status.
        // Single source of truth (also re-armed after dropAgentClient). §14.51.
        armAgentClientHooks(client, v.id);
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
      active = db.select({ id: agentSessions.id, vpsId: agentSessions.vpsId })
        .from(agentSessions)
        .where(and(
          eq(agentSessions.archived, 0),
          eq(agentSessions.sleepRequested, 0),
          or(
            inArray(agentSessions.status, ['active', 'thinking', 'starting', 'background']),
            // Durable POST-UPDATE resume intent (§14.62): an agent update put
            // these to sleep and the fire-and-forget resume died with a hub
            // restart — finish the job at boot. (sleepRequested can't coexist
            // with resumePending: both setters clear the other.)
            eq(agentSessions.resumePending, 1),
          ),
        ))
        .all();
    } catch {
      return;
    }
    for (const s of active) {
      resumeSession(s.id)
        .then(() => {
          try {
            db.insert(sessionLogs).values({
              sessionId: s.id, level: 'info', event: 'auto_resume', detail: null,
            }).run();
          } catch {}
        })
        .catch((e) => {
          try {
            db.insert(sessionLogs).values({
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
            // Through the ONE hub status helper (S1): DB, a hydrated stream's
            // memory and every tab agree — the list GET used to keep serving
            // the stale live status.
            if (!connected) setSessionStatusLocal(s.id, 'sleeping');
          } catch {}
        });
    }
  });
}
