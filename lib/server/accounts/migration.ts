import 'server-only';
import { and, eq, gt, ne } from 'drizzle-orm';
import { db, agentSessions, sessionMessages, sessionPendingPermissions, sessionPendingQuestions, accountProfiles } from '@/lib/db';
import { asSessionProvider, type SessionProvider } from '@/lib/sessionCapabilities';
import { getSetting } from '@/lib/server/hub/settings';
import { getAgentClientForVpsId } from '@/lib/server/agent/AgentClientPool';
import { emitGlobalSessionListChanged, peekStream, restartSession } from '@/lib/server/agent/sessionOps';
import { runningBgTasksIfWarm, pruneStaleBgTasks } from '@/lib/server/hub/bgTaskState';
import { readScheduledTasks } from '@/lib/server/hub/scheduledTaskState';
import { cursorIdentities } from '@/lib/server/agent/accountProfileState';
import { connectionConfig } from '@/lib/server/customEndpoints';
import { accountKeyFor, getAccountRow, listAccountRows, publicAccounts, type AccountRow } from './store';

/**
 * Moving pre-§14.115 sessions (local per-VPS logins) onto hub-owned accounts.
 *
 * A session moves only when its account EXISTS here (matched by the login
 * identity the agent once verified), never by guess. Order, per session:
 *   1. a Claude session of a legacy extra profile: its history is linked into
 *      the shared home (`accounts_merge_history`) and its transcript checked —
 *      a session whose conversation would not be found is left alone;
 *   2. the account goes into `providerConfig` (a sleeping session is done);
 *   3. a running one restarts ONLY when quiet — idle, no open gate, no
 *      running background task, no recent activity, no scheduled task due
 *      soon — so a resume (which restores its scheduled tasks) never cuts
 *      anything. Not quiet ⇒ retried on the next pass.
 */

const RECENT_ACTIVITY_S = 10 * 60;
const CRON_MARGIN_MS = 5 * 60_000;
const PASS_MS = 2 * 60_000;

type MigrationState = { timer: ReturnType<typeof setTimeout> | null; running: Promise<void> | null; merged: Set<string>; again: boolean };
const g = globalThis as unknown as { _accountsMigration?: MigrationState };
const state: MigrationState = g._accountsMigration ??= { timer: null, running: null, merged: new Set(), again: false };

export function scheduleMigration(delayMs = 10_000): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.running) { state.again = true; return; }
    state.running = runMigration().catch((e) => console.warn('[accounts] migration pass failed:', e))
      .finally(() => {
        state.running = null;
        if (state.again) { state.again = false; scheduleMigration(); }
      });
  }, delayMs);
  state.timer.unref?.();
}

function persistedDefaultKeys(): Record<string, string> {
  try {
    const v = JSON.parse(getSetting('accounts.default_keys') || '{}') as unknown;
    return v && typeof v === 'object' ? v as Record<string, string> : {};
  } catch { return {}; }
}

/** The login a legacy session ran on, as the agent last verified it. */
function legacyIdentity(vpsId: string, provider: SessionProvider, profile: string): string | null {
  if (provider === 'cursor') {
    const email = cursorIdentities.get(vpsId);
    return email ? accountKeyFor('cursor', { email }) : null;
  }
  if (profile === 'default') return persistedDefaultKeys()[`${vpsId}:${provider}:default`] ?? null;
  return db.select({ key: accountProfiles.accountKey }).from(accountProfiles)
    .where(and(eq(accountProfiles.id, profile), eq(accountProfiles.vpsId, vpsId))).get()?.key ?? null;
}

/** Whether restarting this session now would cut anything (see header). */
export function sessionIsQuiet(sessionId: string, status: string, now = Date.now()): boolean {
  if (!['active', 'failed', 'background'].includes(status)) return false;
  const nowS = Math.floor(now / 1000);
  if (db.select({ id: sessionPendingPermissions.id }).from(sessionPendingPermissions)
    .where(and(eq(sessionPendingPermissions.sessionId, sessionId), eq(sessionPendingPermissions.status, 'pending'))).limit(1).all().length) return false;
  if (db.select({ id: sessionPendingQuestions.id }).from(sessionPendingQuestions)
    .where(and(eq(sessionPendingQuestions.sessionId, sessionId), eq(sessionPendingQuestions.status, 'pending'),
      ne(sessionPendingQuestions.kind, 'async_question'))).limit(1).all().length) return false;
  if (db.select({ id: sessionMessages.id }).from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), gt(sessionMessages.createdAt, nowS - RECENT_ACTIVITY_S))).limit(1).all().length) return false;
  const running = runningBgTasksIfWarm(sessionId);
  if (running == null || pruneStaleBgTasks(running, nowS)) return false;
  for (const task of readScheduledTasks(sessionId)?.tasks ?? []) {
    // An unknown next fire (a one-shot gone overdue) counts as due.
    if (task.nextFireAt == null || task.nextFireAt - now < CRON_MARGIN_MS) return false;
  }
  return true;
}

type Candidate = { id: string; vpsId: string; provider: SessionProvider; profile: string; status: string;
  nativeId: string | null; config: Record<string, unknown>; target: AccountRow };

function candidates(): Candidate[] {
  const accounts = listAccountRows().filter((r) => r.status !== 'expired' && r.accountKey);
  if (!accounts.length) return [];
  const ids = new Set(accounts.map((a) => a.id));
  const rows = db.select().from(agentSessions).where(eq(agentSessions.archived, 0)).all();
  const out: Candidate[] = [];
  for (const r of rows) {
    const config = connectionConfig(r.providerConfig) as Record<string, unknown>;
    if (config.customEndpoint) continue;
    const profile = typeof config.accountProfile === 'string' ? config.accountProfile : 'default';
    if (ids.has(profile)) continue;
    const provider = asSessionProvider(r.kind);
    const key = legacyIdentity(r.vpsId, provider, profile);
    const target = key ? accounts.find((a) => a.provider === provider && a.accountKey === key) : undefined;
    if (!target) continue;
    out.push({ id: r.id, vpsId: r.vpsId, provider, profile, status: r.status, nativeId: r.nativeSessionId, config, target });
  }
  return out;
}

/** A box whose agent predates hub accounts would read the account id as an
 *  unknown legacy profile (no login): nothing moves there until it updates. */
export function agentTakesAccounts(vpsId: string): boolean {
  const client = getAgentClientForVpsId(vpsId);
  return client.status === 'connected' && !!client.hello?.global_accounts;
}

async function ensureHistory(c: Candidate): Promise<boolean> {
  if (!agentTakesAccounts(c.vpsId)) return false;
  if (c.provider !== 'claude') return true;
  const client = getAgentClientForVpsId(c.vpsId);
  if (c.profile !== 'default') {
    const key = `${c.vpsId}:${c.profile}`;
    if (!state.merged.has(key)) {
      const r = await client.call<{ ok: boolean; errors?: number }>('accounts_merge_history', { provider: 'claude', profile: c.profile }, { timeoutMs: 10 * 60_000 });
      if (!r?.ok) { console.warn(`[accounts] history merge incomplete for ${key}`, r); return false; }
      state.merged.add(key);
    }
  }
  if (!c.nativeId) return true;
  const r = await client.call<{ found: Record<string, boolean> }>('accounts_transcript_check', { ids: [c.nativeId] });
  return r?.found?.[c.nativeId] === true;
}

export async function runMigration(): Promise<void> {
  const list = candidates();
  if (!list.length) return;
  const numbers = new Map(publicAccounts().map((a) => [a.id, a.number]));
  let pending = false;
  for (const c of list) {
    try {
      if (!(await ensureHistory(c))) { pending = true; continue; }
      const live = ['active', 'thinking', 'starting', 'failed', 'background'].includes(c.status);
      if (live && !sessionIsQuiet(c.id, c.status)) { pending = true; continue; }
      const next = { ...c.config, accountProfile: c.target.id, accountProfileNumber: numbers.get(c.target.id) ?? 1 };
      db.update(agentSessions).set({ providerConfig: JSON.stringify(next) }).where(eq(agentSessions.id, c.id)).run();
      emitGlobalSessionListChanged(c.id);
      console.log(`[accounts] session ${c.id} → account ${c.target.id}${live ? ' (restarting)' : ''}`);
      if (live) await restartSession(c.id);
    } catch (e) {
      pending = true;
      console.warn(`[accounts] could not move session ${c.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (pending) scheduleMigration(PASS_MS);
}

/** What the migration still waits on (Accounts panel). */
export function migrationBacklog(): { waiting: number; unmatched: number } {
  const accounts = listAccountRows();
  const ids = new Set(accounts.map((a) => a.id));
  let unmatched = 0;
  for (const r of db.select().from(agentSessions).where(eq(agentSessions.archived, 0)).all()) {
    const config = connectionConfig(r.providerConfig) as Record<string, unknown>;
    if (config.customEndpoint) continue;
    const profile = typeof config.accountProfile === 'string' ? config.accountProfile : 'default';
    if (!ids.has(profile)) unmatched += 1;
  }
  const waiting = candidates().length;
  return { waiting, unmatched: unmatched - waiting };
}


/**
 * "Répond : <compte> ▾" — run this session on another account of its provider
 * (§14.115). History is shared, so the conversation carries over; the CLI
 * binds the account at start, hence a restart when it runs (refused mid-turn
 * or while background tasks run: the caller retries once they ended).
 */
export async function switchSessionAccount(sessionId: string, accountId: string): Promise<{ restarted: boolean }> {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
  if (!row) throw new Error('Session not found');
  const account = getAccountRow(accountId);
  const provider = asSessionProvider(row.kind);
  if (!account || account.provider !== provider) throw new Error('Pick an account of the same provider');
  if (account.status === 'expired') throw new Error('This account must be signed in again first');
  const config = connectionConfig(row.providerConfig) as Record<string, unknown>;
  if (config.customEndpoint) throw new Error('This session runs on a custom endpoint');
  if (config.accountProfile === accountId) return { restarted: false };
  if (row.status === 'thinking' || row.status === 'starting') throw Object.assign(new Error('Wait for the current turn to finish'), { status: 409 });
  // The restart kills the CLI and the background tasks it runs (§14.91): the
  // live stream's registry, else the persisted one, else the parked status.
  const stream = peekStream(sessionId);
  const bgRunning = stream ? null : runningBgTasksIfWarm(sessionId);
  if (stream ? stream.hasRunningBgTasks()
    : bgRunning ? pruneStaleBgTasks(bgRunning, Math.floor(Date.now() / 1000))
    : row.status === 'background') {
    throw Object.assign(new Error('Wait for the background tasks to finish: the restart would stop them'), { status: 409 });
  }
  if (!agentTakesAccounts(row.vpsId)) throw Object.assign(new Error("Update this VPS's agent first (it predates hub accounts)"), { status: 409 });
  if (provider === 'claude') {
    const c: Candidate = { id: row.id, vpsId: row.vpsId, provider, status: row.status, nativeId: row.nativeSessionId, config, target: account,
      profile: typeof config.accountProfile === 'string' ? config.accountProfile : 'default' };
    if (!getAccountRow(c.profile) && !(await ensureHistory(c))) throw new Error('The conversation could not be found in the shared history on this VPS');
  }
  const number = publicAccounts().find((a) => a.id === accountId)?.number ?? 1;
  db.update(agentSessions).set({ providerConfig: JSON.stringify({ ...config, accountProfile: accountId, accountProfileNumber: number }) })
    .where(eq(agentSessions.id, sessionId)).run();
  emitGlobalSessionListChanged(sessionId);
  const live = ['active', 'failed', 'background'].includes(row.status);
  if (live) await restartSession(sessionId);
  return { restarted: live };
}
