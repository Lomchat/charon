import 'server-only';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  db, claudeSessions, claudeSessionMessages,
  claudePendingPermissions, claudePendingQuestions, claudeSessionLogs,
  vps as vpsTable,
} from '@/lib/db';
import type { PermissionMode } from '@/lib/server/claude/types';
import type { WorkerEvent, WorkerStatus } from '@/lib/server/claude/types';
import { getAgentClientForVpsId } from './AgentClientPool';
import { sendPushToAll } from '@/lib/server/claude/webPush';
import {
  sendPermissionToTelegram, sendQuestionToTelegram, markInteractionResolvedInTelegram,
} from '@/lib/server/claude/telegram';
import { getSettingBool } from '@/lib/server/claude/settings';
import type { AgentEvent } from './types';
import type { EventListener as AgentEventListener } from './AgentClient';

const newId = () => crypto.randomBytes(8).toString('hex');

// ── Pool de dispatcher par session ──────────────────────────────────────────
// Chaque session active a un SessionStream (= un dispatcher entre l'agent et
// les SSE consumers). Le SessionStream :
//   - Est créé lazily à la 1re subscribe SSE ou au boot (autoResume)
//   - Sub à l'agent et persiste tous les events en DB (msgs/permissions/etc.)
//   - Broadcast aux SSE sinks attachés
//   - Garde un ring buffer pour les late subscribers (qui ouvrent une page)
const g = globalThis as unknown as { _sessionStreams?: Map<string, SessionStream> };
if (!g._sessionStreams) g._sessionStreams = new Map();
const streams: Map<string, SessionStream> = g._sessionStreams;

const RING_MAX = 200;

export type SseSink = {
  id: string;
  send: (ev: WorkerEvent) => void;
  close: () => void;
};

export class SessionStream {
  readonly id: string;
  readonly vpsId: string;
  status: WorkerStatus = 'starting';
  permissionMode: PermissionMode = 'normal';
  claudeSessionId: string | null = null;
  name: string | null = null;
  vpsName: string;

  private ring: WorkerEvent[] = [];
  private subs = new Map<string, SseSink>();
  private currentAssistant = '';
  private agentListener: AgentEventListener | null = null;
  private attached = false;
  private alwaysAllow = new Set<string>();

  constructor(opts: {
    id: string; vpsId: string; vpsName: string; name: string | null;
    status: WorkerStatus; permissionMode: PermissionMode;
    claudeSessionId: string | null;
  }) {
    this.id = opts.id;
    this.vpsId = opts.vpsId;
    this.vpsName = opts.vpsName;
    this.name = opts.name;
    this.status = opts.status;
    this.permissionMode = opts.permissionMode;
    this.claudeSessionId = opts.claudeSessionId;
  }

  /** Branche le listener sur l'agent (idempotent). */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const client = getAgentClientForVpsId(this.vpsId);
    this.agentListener = (ev) => this._onAgentEvent(ev);
    client.subscribe(this.id, this.agentListener);
  }

  /** Détache du listener (utilisé sur kill définitif). */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    try {
      const client = getAgentClientForVpsId(this.vpsId);
      if (this.agentListener) client.unsubscribe(this.id, this.agentListener);
    } catch {}
    this.agentListener = null;
  }

  subscribersCount(): number {
    return this.subs.size;
  }

  subscribe(sub: SseSink): void {
    if (!this.attached) this.attach();
    this.subs.set(sub.id, sub);
    try {
      sub.send({ type: 'history_begin' });
      // Re-emit pendings (DB) AVANT le ring (UI les affichera dans la popup)
      const perms = db.select().from(claudePendingPermissions).where(and(
        eq(claudePendingPermissions.sessionId, this.id),
        eq(claudePendingPermissions.status, 'pending'),
      )).all();
      for (const p of perms) {
        let input: any = {};
        try { input = JSON.parse(p.toolInput); } catch {}
        sub.send({ type: 'permission_request', id: p.id, tool: p.toolName, input });
      }
      const qs = db.select().from(claudePendingQuestions).where(and(
        eq(claudePendingQuestions.sessionId, this.id),
        eq(claudePendingQuestions.status, 'pending'),
      )).all();
      for (const q of qs) {
        let payload: any = {};
        try { payload = JSON.parse(q.payload); } catch {}
        if (q.kind === 'question') {
          sub.send({ type: 'user_question', id: q.id, questions: payload });
        } else if (q.kind === 'exit_plan') {
          sub.send({ type: 'exit_plan_request', id: q.id, plan: payload?.plan ?? '' });
        }
      }
      for (const ev of this.ring) {
        try { sub.send(ev); } catch {}
      }
      sub.send({ type: 'history_end' });
      sub.send({ type: 'status', status: this.status });
    } catch {}
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  /**
   * Dispatch d'un event agent : persistance DB + broadcast SSE.
   * Garde la sémantique de SessionWorker.handleBridgeEvent.
   */
  private _onAgentEvent(ev: AgentEvent): void {
    switch (ev.event) {
      case 'status':
        this.status = ev.status as WorkerStatus;
        this._broadcast({ type: 'status', status: this.status });
        try {
          db.update(claudeSessions).set({ status: ev.status })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        break;
      case 'ready':
        this._broadcast({ type: 'ready' });
        break;
      case 'session_id':
        this.claudeSessionId = ev.claude_session_id;
        try {
          db.update(claudeSessions).set({ claudeSessionId: ev.claude_session_id })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'session_id', id: ev.claude_session_id });
        break;
      case 'assistant_text':
        this.currentAssistant += ev.delta;
        this._broadcast({ type: 'assistant_text', delta: ev.delta });
        break;
      case 'thinking':
        this._persist('event', { type: 'thinking', text: ev.text });
        this._broadcast({ type: 'thinking', text: ev.text });
        break;
      case 'tool_use':
        this._persist('tool_use', { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        this._broadcast({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        break;
      case 'tool_result':
        this._persist('tool_result', { type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        this._broadcast({ type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        break;
      case 'permission_request':
        if (this.alwaysAllow.has(ev.tool)) {
          // Auto-allow : forward au agent immédiatement
          this.respondPermission(ev.id, true).catch(() => {});
          return;
        }
        try {
          db.insert(claudePendingPermissions).values({
            id: ev.id,
            sessionId: this.id,
            toolName: ev.tool,
            toolInput: JSON.stringify(ev.input ?? {}),
            status: 'pending',
          }).run();
        } catch {}
        this._broadcast({ type: 'permission_request', id: ev.id, tool: ev.tool, input: ev.input });
        this._log('info', 'permission', { id: ev.id, tool: ev.tool });
        this._maybePush({
          title: `🔒 ${this.vpsName} · ${this.name ?? this.id.slice(0, 6)} : permission`,
          body: `outil ${ev.tool} — clique pour valider`,
          tag: `perm-${this.id}`,
        });
        sendPermissionToTelegram(this.id, ev.id, ev.tool, ev.input).catch(() => {});
        break;
      case 'user_question':
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id, sessionId: this.id, kind: 'question',
            payload: JSON.stringify(ev.questions ?? []), status: 'pending',
          }).run();
        } catch {}
        this._persist('user_question', { type: 'user_question', id: ev.id, questions: ev.questions });
        this._broadcast({ type: 'user_question', id: ev.id, questions: ev.questions });
        this._maybePush({
          title: `❓ ${this.vpsName} · ${this.name ?? this.id.slice(0, 6)} : question`,
          body: `${ev.questions[0]?.question ?? 'question utilisateur'}`,
          tag: `q-${this.id}`,
        });
        sendQuestionToTelegram(this.id, ev.id, ev.questions ?? []).catch(() => {});
        break;
      case 'exit_plan_request':
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id, sessionId: this.id, kind: 'exit_plan',
            payload: JSON.stringify({ plan: ev.plan ?? '' }), status: 'pending',
          }).run();
        } catch {}
        this._persist('exit_plan_request', { type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        this._broadcast({ type: 'exit_plan_request', id: ev.id, plan: ev.plan });
        this._maybePush({
          title: `📋 ${this.vpsName} · ${this.name ?? this.id.slice(0, 6)} : plan prêt`,
          body: 'Claude a fini de planifier — clique pour valider',
          tag: `plan-${this.id}`,
        });
        break;
      case 'todo_update':
        this._persist('event', { type: 'todo_update', todos: ev.todos });
        this._broadcast({ type: 'todo_update', todos: ev.todos });
        break;
      case 'edit_snapshot':
        this._persist('edit_snapshot', { type: 'edit_snapshot', phase: ev.phase, tool_use_id: ev.tool_use_id, file_path: ev.file_path, content: ev.content, size: ev.size, truncated: ev.truncated });
        this._broadcast({ type: 'edit_snapshot', phase: ev.phase, tool_use_id: ev.tool_use_id, file_path: ev.file_path, content: ev.content, size: ev.size, truncated: ev.truncated });
        break;
      case 'mode_changed':
        this.permissionMode = ev.mode as PermissionMode;
        try {
          db.update(claudeSessions).set({ permissionMode: ev.mode })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'mode_changed', mode: this.permissionMode });
        break;
      case 'stop':
        if (this.currentAssistant) {
          this._persist('assistant', this.currentAssistant);
          this.currentAssistant = '';
        }
        try {
          db.update(claudeSessions).set({ lastUsedAt: Math.floor(Date.now() / 1000) })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this._broadcast({ type: 'stop', subtype: ev.subtype });
        this._maybePush({
          title: `✓ ${this.vpsName} · ${this.name ?? this.id.slice(0, 6)}`,
          body: 'Claude a fini sa réponse',
          tag: `stop-${this.id}`,
        });
        break;
      case 'interrupted':
        this._broadcast({ type: 'mode_changed', mode: this.permissionMode }); // forme libre
        break;
      case 'error':
        this._log('error', 'sdk_error', { msg: ev.msg, fatal: !!ev.fatal });
        this._broadcast({ type: 'error', msg: ev.msg, fatal: ev.fatal });
        break;
    }
  }

  // ── Actions (forwardées à l'agent) ───────────────────────────────────────
  async sendUserMessage(content: string): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    this._persist('user', content);
    const now = Math.floor(Date.now() / 1000);
    this._broadcast({ type: 'user_echo', content, createdAt: now });
    this.status = 'thinking';
    this._broadcast({ type: 'status', status: 'thinking' });
    await client.call('send_input', { session_id: this.id, content });
  }

  async sendInterrupt(): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('interrupt', { session_id: this.id });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('set_permission_mode', { session_id: this.id, mode });
    // Le mode_changed event reviendra et fera le sync DB
  }

  async respondPermission(permId: string, allow: boolean, always = false): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    try {
      const [row] = db.select().from(claudePendingPermissions)
        .where(eq(claudePendingPermissions.id, permId)).all();
      if (row && always && allow) this.alwaysAllow.add(row.toolName);
      db.update(claudePendingPermissions)
        .set({ status: allow ? 'allowed' : 'denied', respondedAt: Math.floor(Date.now() / 1000) })
        .where(eq(claudePendingPermissions.id, permId)).run();
    } catch {}
    await client.call('respond_permission', { session_id: this.id, perm_id: permId, allow });
    this._broadcast({ type: 'interaction_resolved', kind: 'permission', id: permId });
    markInteractionResolvedInTelegram('permission', permId);
  }

  async respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    try {
      db.update(claudePendingQuestions).set({
        status: answers ? 'answered' : 'cancelled',
        answers: answers ? JSON.stringify(answers) : null,
        respondedAt: Math.floor(Date.now() / 1000),
      }).where(eq(claudePendingQuestions.id, qid)).run();
    } catch {}
    await client.call('respond_question', { session_id: this.id, q_id: qid, answers });
    this._broadcast({ type: 'interaction_resolved', kind: 'question', id: qid });
    markInteractionResolvedInTelegram('question', qid);
  }

  async respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback = ''): Promise<void> {
    const client = getAgentClientForVpsId(this.vpsId);
    try {
      db.update(claudePendingQuestions).set({
        status: 'answered',
        answers: JSON.stringify({ decision, feedback }),
        respondedAt: Math.floor(Date.now() / 1000),
      }).where(eq(claudePendingQuestions.id, qid)).run();
    } catch {}
    await client.call('respond_exit_plan', { session_id: this.id, q_id: qid, decision, feedback });
    this._broadcast({ type: 'interaction_resolved', kind: 'exit_plan', id: qid });
  }

  // ── Privates ─────────────────────────────────────────────────────────────
  private _broadcast(ev: WorkerEvent): void {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    for (const sub of this.subs.values()) {
      try { sub.send(ev); } catch {}
    }
  }

  private _persist(role: string, content: any): void {
    try {
      db.insert(claudeSessionMessages).values({
        sessionId: this.id, role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      }).run();
    } catch (e: any) {
      this._log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
    }
  }

  private _log(level: 'info' | 'warn' | 'error', event: string, detail?: any): void {
    try {
      db.insert(claudeSessionLogs).values({
        sessionId: this.id, level, event,
        detail: detail ? JSON.stringify(detail) : null,
      }).run();
    } catch {}
  }

  private _maybePush(payload: { title: string; body: string; tag?: string }): void {
    if (!getSettingBool('notif.global_enabled')) return;
    sendPushToAll({
      ...payload,
      sessionId: this.id,
      url: `/claude?session=${this.id}`,
    }).catch(() => {});
  }
}

// ── Helpers : ouverture/fermeture des streams ───────────────────────────────
function _vpsName(vpsId: string): string {
  const [row] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  return row?.name ?? vpsId.slice(0, 6);
}

function _loadOrCreateStream(sessionId: string): SessionStream | null {
  let s = streams.get(sessionId);
  if (s) return s;
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return null;
  s = new SessionStream({
    id: row.id, vpsId: row.vpsId, vpsName: _vpsName(row.vpsId),
    name: row.name, status: row.status as WorkerStatus,
    permissionMode: row.permissionMode as PermissionMode,
    claudeSessionId: row.claudeSessionId,
  });
  streams.set(sessionId, s);
  return s;
}

export function getStream(sessionId: string): SessionStream | null {
  return _loadOrCreateStream(sessionId);
}

export function listStreams(): SessionStream[] {
  return Array.from(streams.values());
}

// ── Lifecycle des sessions (create/resume/sleep/kill/import) ────────────────

/**
 * Crée un row DB pour une session Claude qui existe déjà côté SDK (ex : trouvée
 * par /api/vps/[id]/claude/scan). La session naît 'sleeping' avec son
 * claude_session_id ; un resume ultérieur la matérialise côté agent via
 * start_session(claude_session_id=...).
 */
export async function importExistingSession(opts: {
  vpsId: string;
  cwd: string;
  claudeSessionId: string;
  name?: string | null;
  projectId?: string | null;
  permissionMode?: PermissionMode;
}): Promise<string> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);
  const sessionId = newId();
  db.insert(claudeSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    claudeSessionId: opts.claudeSessionId,
    cwd: opts.cwd,
    projectId: opts.projectId ?? null,
    name: opts.name ?? null,
    status: 'sleeping',
    permissionMode: opts.permissionMode ?? 'normal',
  }).run();
  return sessionId;
}

export async function startNewSession(opts: {
  vpsId: string;
  cwd: string;
  name?: string | null;
  projectId?: string | null;
  permissionMode?: PermissionMode;
}): Promise<SessionStream> {
  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, opts.vpsId)).all();
  if (!vps) throw new Error(`vps ${opts.vpsId} not found`);

  const sessionId = newId();
  // Insert en DB d'abord (statut 'starting' jusqu'à confirmation agent)
  db.insert(claudeSessions).values({
    id: sessionId,
    vpsId: opts.vpsId,
    cwd: opts.cwd,
    projectId: opts.projectId ?? null,
    name: opts.name ?? null,
    status: 'starting',
    permissionMode: opts.permissionMode ?? 'normal',
    lastUsedAt: Math.floor(Date.now() / 1000),
  }).run();

  // Crée le stream en mémoire AVANT de subscribe (sinon les premiers events sont perdus)
  const stream = new SessionStream({
    id: sessionId, vpsId: opts.vpsId, vpsName: vps.name,
    name: opts.name ?? null, status: 'starting',
    permissionMode: opts.permissionMode ?? 'normal',
    claudeSessionId: null,
  });
  streams.set(sessionId, stream);
  stream.attach();

  // Demande à l'agent de créer la session
  try {
    const client = getAgentClientForVpsId(opts.vpsId);
    await client.call('start_session', {
      session_id: sessionId,
      cwd: opts.cwd,
      name: opts.name ?? null,
      permission_mode: opts.permissionMode ?? 'normal',
    });
  } catch (e: any) {
    // Cleanup
    streams.delete(sessionId);
    stream.detach();
    db.update(claudeSessions).set({ status: 'error' })
      .where(eq(claudeSessions.id, sessionId)).run();
    throw e;
  }
  return stream;
}

/**
 * Resume : tente la séquence (resume_session si la session existe côté agent,
 * sinon start_session avec le claude_session_id sauvegardé). Idempotent côté
 * DB : laisse le statut à 'active' une fois l'agent confirme.
 */
export async function resumeSession(sessionId: string): Promise<SessionStream> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) throw new Error(`session ${sessionId} not found`);
  if (row.status === 'killed') throw new Error('session killed (cannot resume)');

  const [vps] = db.select().from(vpsTable).where(eq(vpsTable.id, row.vpsId)).all();
  if (!vps) throw new Error('vps no longer exists');

  let stream = streams.get(sessionId);
  if (!stream) {
    stream = new SessionStream({
      id: row.id, vpsId: row.vpsId, vpsName: vps.name,
      name: row.name, status: row.status as WorkerStatus,
      permissionMode: row.permissionMode as PermissionMode,
      claudeSessionId: row.claudeSessionId,
    });
    streams.set(sessionId, stream);
  }
  stream.attach();

  const client = getAgentClientForVpsId(row.vpsId);
  // Essaie resume_session ; si ça retourne ERR_SESSION_NOT_FOUND, on fait start_session
  try {
    await client.call('resume_session', { session_id: sessionId });
  } catch (e: any) {
    const isNotFound = /not found/i.test(e?.message ?? '') || e?.code === -32000;
    if (!isNotFound) throw e;
    // Recreate from scratch (l'agent ne connaît pas cette session)
    await client.call('start_session', {
      session_id: sessionId,
      cwd: row.cwd,
      name: row.name,
      permission_mode: row.permissionMode,
      claude_session_id: row.claudeSessionId,
    });
  }
  db.update(claudeSessions).set({ status: 'active' })
    .where(eq(claudeSessions.id, sessionId)).run();
  return stream;
}

export async function sleepSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  db.update(claudeSessions).set({ status: 'sleeping' })
    .where(eq(claudeSessions.id, sessionId)).run();
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    await client.call('sleep_session', { session_id: sessionId });
  } catch (e) {
    // Agent peut être down — on a déjà mis 'sleeping' en DB, on log
    console.warn(`[sessionOps] sleep ${sessionId}: agent unreachable, DB marked anyway`);
  }
}

export async function killSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  db.update(claudeSessions).set({ status: 'killed' })
    .where(eq(claudeSessions.id, sessionId)).run();
  const stream = streams.get(sessionId);
  if (stream) {
    stream.detach();
    for (const sub of (stream as any).subs.values()) {
      try { sub.close(); } catch {}
    }
    streams.delete(sessionId);
  }
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    await client.call('kill_session', { session_id: sessionId });
  } catch (e) {
    // Agent down : ce n'est pas grave, on a déjà cleanup local
  }
}
