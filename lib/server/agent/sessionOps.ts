import 'server-only';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
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
//   - Broadcast aux SSE sinks attachés (live uniquement — pas de replay côté
//     Charon, la DB est la source de vérité, le client GET au mount)
const g = globalThis as unknown as { _sessionStreams?: Map<string, SessionStream> };
if (!g._sessionStreams) g._sessionStreams = new Map();
const streams: Map<string, SessionStream> = g._sessionStreams;

// Ring buffer côté Charon : SUPPRIMÉ (cf. CLAUDE.md §14 piège 14). La DB
// est désormais la seule source de vérité pour les events persistés ; la
// SSE par-session ne transmet plus que du live, et le client refetch via
// GET /api/claude/sessions/[id] au mount + au reconnect + au retour foreground.

// ── Bus global d'events session-tagged ─────────────────────────────────────
// TOUS les events broadcast par les SessionStreams passent par ce bus, tagués
// avec leur sessionId. Le SSE multiplexé `/api/claude/events` en est l'unique
// consommateur côté HTTP — il filtre par focus de connexion (cf.
// `eventConnections.ts` § filterAndForward).
//
// Avant le refactor : une SSE par session (`/api/claude/sessions/[id]/stream`)
// + une SSE agrégée pour les interactions. Switcher de session = close+open de
// la SSE per-session = ~50-150ms de latence visible + double mécanisme à
// maintenir. Maintenant : UNE seule SSE par browser, focus changé via POST.
export type GlobalSessionEvent = WorkerEvent & { sessionId: string };

const gBus = globalThis as unknown as { _globalSessionSubs?: Set<(ev: GlobalSessionEvent) => void> };
if (!gBus._globalSessionSubs) gBus._globalSessionSubs = new Set();
const globalSessionSubs: Set<(ev: GlobalSessionEvent) => void> = gBus._globalSessionSubs;

export function subscribeGlobalSessionEvents(cb: (ev: GlobalSessionEvent) => void): () => void {
  globalSessionSubs.add(cb);
  return () => { globalSessionSubs.delete(cb); };
}

function emitGlobalSession(ev: GlobalSessionEvent): void {
  for (const cb of globalSessionSubs) {
    try { cb(ev); } catch {}
  }
}

export class SessionStream {
  readonly id: string;
  readonly vpsId: string;
  status: WorkerStatus = 'starting';
  permissionMode: PermissionMode = 'normal';
  claudeSessionId: string | null = null;
  name: string | null = null;
  vpsName: string;

  private currentAssistant = '';
  private agentListener: AgentEventListener | null = null;
  private attached = false;
  private alwaysAllow = new Set<string>();
  // True pendant qu'on traite des events replay-és par l'agent (entre
  // replay_begin et replay_end). Pendant cette fenêtre, on déduplique chaque
  // event contre la DB pour éviter de re-persister du contenu déjà connu.
  // Le but : après un restart Charon (où l'agent VPS a continué à streamer
  // des events qu'on n'a pas vus), récupérer SEULEMENT les events manquants
  // sans dupliquer ce qui est déjà en DB.
  private isReplaying = false;
  // Sets chargés au replay_begin depuis la DB pour dedupe rapide.
  private replayKnownToolUseIds: Set<string> = new Set();
  private replayKnownToolResultIds: Set<string> = new Set();
  private replayKnownAssistantContents: Set<string> = new Set();
  private replayKnownThinkingContents: Set<string> = new Set();
  private replayKnownPendingIds: Set<string> = new Set();

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

  /** Texte assistant en cours d'accumulation (depuis le dernier flush).
   *  Exposé pour que l'API GET puisse le passer au client → permet à
   *  l'UI de reprendre un streaming "en cours" sans avoir à re-écouter
   *  les deltas qui sont déjà passés (et déjà perçus comme "défilage"). */
  getStreamingText(): string {
    return this.currentAssistant;
  }

  /** Idempotent — attache au listener agent. Appelé lazy depuis le code
   * appelant qui crée le SessionStream (autoConnect, startNewSession,
   * resumeSession). N'a plus de lien avec un subscriber HTTP : la SSE
   * écoute le bus global. */
  ensureAttached(): void {
    if (!this.attached) this.attach();
  }

  /**
   * Dispatch d'un event agent : persistance DB + broadcast SSE.
   * Garde la sémantique de SessionWorker.handleBridgeEvent.
   */
  private _onAgentEvent(ev: AgentEvent): void {
    switch (ev.event) {
      case 'replay_begin':
        // On entre dans la fenêtre de replay : les events qui suivent peuvent
        // être des doublons (déjà persistés) OU des events manqués (par ex.
        // après un restart Charon, l'agent VPS a continué à streamer pendant
        // qu'on était down). On charge les "déjà connus" et on traite chaque
        // event normalement avec dedup par event-type.
        this.isReplaying = true;
        this._loadReplayDedup();
        return;
      case 'replay_end':
        this.isReplaying = false;
        this.replayKnownToolUseIds.clear();
        this.replayKnownToolResultIds.clear();
        this.replayKnownAssistantContents.clear();
        this.replayKnownThinkingContents.clear();
        this.replayKnownPendingIds.clear();
        return;
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
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownThinkingContents.has(ev.text)) break;
        this._persist('event', { type: 'thinking', text: ev.text });
        this._broadcast({ type: 'thinking', text: ev.text });
        if (this.isReplaying) this.replayKnownThinkingContents.add(ev.text);
        break;
      case 'tool_use':
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownToolUseIds.has(String(ev.id))) break;
        this._persist('tool_use', { type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        this._broadcast({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        if (this.isReplaying) this.replayKnownToolUseIds.add(String(ev.id));
        break;
      case 'tool_result':
        if (this.isReplaying && this.replayKnownToolResultIds.has(String(ev.tool_use_id))) break;
        this._persist('tool_result', { type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        this._broadcast({ type: 'tool_result', tool_use_id: ev.tool_use_id, content: ev.content, is_error: ev.is_error });
        if (this.isReplaying) this.replayKnownToolResultIds.add(String(ev.tool_use_id));
        break;
      case 'permission_request':
        if (this.alwaysAllow.has(ev.tool)) {
          // Auto-allow : forward au agent immédiatement
          this.respondPermission(ev.id, true).catch(() => {});
          return;
        }
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
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
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
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
        this._flushAssistant();
        if (this.isReplaying && this.replayKnownPendingIds.has(ev.id)) break;
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
        this._flushAssistant();
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

  async forceStop(): Promise<void> {
    // Force le SDK à lâcher : la session passe 'sleeping' immédiatement
    // côté agent, on peut resume juste après. Utilisé quand `interrupt`
    // (soft) ne fait rien parce qu'un tool est stuck.
    const client = getAgentClientForVpsId(this.vpsId);
    await client.call('force_stop', { session_id: this.id });
    this.status = 'sleeping';
    this._broadcast({ type: 'status', status: 'sleeping' });
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
    // Push tous les events sur le bus global — le SSE multiplexé /events
    // se charge du fan-out + filtre par focus de connexion. Tag sessionId
    // pour que les consommateurs sachent de quelle session ça vient.
    emitGlobalSession({ ...ev, sessionId: this.id } as GlobalSessionEvent);
  }

  /**
   * Flush du texte assistant en cours d'accumulation (currentAssistant) :
   * persiste un message 'assistant' en DB et reset le buffer. À appeler
   * avant tout event qui interrompt le texte assistant (tool_use, thinking,
   * permission_request, etc.) — sinon le texte écrit AVANT le tool serait
   * concaténé avec le texte d'APRÈS et inséré en bloc à la fin (à `stop`),
   * ce qui casse l'ordre chronologique au reload.
   *
   * Pendant un replay, on est plus prudent :
   *  - Si le contenu accumulé existe déjà en DB → skip (déjà persisté).
   *  - Si la DERNIÈRE ligne assistant en DB est un préfixe du contenu accumulé
   *    → c'est un partial flushé par SIGTERM, on étend la ligne au lieu d'en
   *    insérer une nouvelle (sinon on aurait un partial + un complet en DB).
   *  - Sinon → insert normal.
   */
  private _flushAssistant(): void {
    if (!this.currentAssistant) return;
    const finalContent = this.currentAssistant;
    this.currentAssistant = '';

    if (this.isReplaying) {
      // Exact match → déjà en DB
      if (this.replayKnownAssistantContents.has(finalContent)) return;
      // Préfixe → étend le partial existant
      try {
        const lastRows = db.select().from(claudeSessionMessages)
          .where(and(
            eq(claudeSessionMessages.sessionId, this.id),
            eq(claudeSessionMessages.role, 'assistant'),
          ))
          .orderBy(desc(claudeSessionMessages.id))
          .limit(1).all();
        if (lastRows.length > 0 &&
            finalContent.startsWith(lastRows[0].content) &&
            finalContent.length > lastRows[0].content.length) {
          db.update(claudeSessionMessages)
            .set({ content: finalContent })
            .where(eq(claudeSessionMessages.id, lastRows[0].id))
            .run();
          this.replayKnownAssistantContents.delete(lastRows[0].content);
          this.replayKnownAssistantContents.add(finalContent);
          return;
        }
      } catch {}
    }

    this._persist('assistant', finalContent);
    if (this.isReplaying) this.replayKnownAssistantContents.add(finalContent);
  }

  /** Variante publique pour le graceful shutdown : persiste sans broadcast. */
  flushPendingAssistant(): void {
    this._flushAssistant();
  }

  /**
   * Au replay_begin : charge depuis la DB les IDs/contenus déjà connus pour
   * dedupe chaque event pendant la fenêtre de replay.
   */
  private _loadReplayDedup(): void {
    this.replayKnownToolUseIds.clear();
    this.replayKnownToolResultIds.clear();
    this.replayKnownAssistantContents.clear();
    this.replayKnownThinkingContents.clear();
    this.replayKnownPendingIds.clear();
    try {
      const rows = db.select().from(claudeSessionMessages)
        .where(eq(claudeSessionMessages.sessionId, this.id))
        .all();
      for (const r of rows) {
        try {
          if (r.role === 'tool_use') {
            const p = JSON.parse(r.content);
            if (p?.id) this.replayKnownToolUseIds.add(String(p.id));
          } else if (r.role === 'tool_result') {
            const p = JSON.parse(r.content);
            if (p?.tool_use_id) this.replayKnownToolResultIds.add(String(p.tool_use_id));
          } else if (r.role === 'assistant') {
            this.replayKnownAssistantContents.add(r.content);
          } else if (r.role === 'thinking') {
            this.replayKnownThinkingContents.add(r.content);
          } else if (r.role === 'event') {
            // events 'thinking' anciens (avant le rôle dédié) sont parfois stockés ici
            try {
              const p = JSON.parse(r.content);
              if (p?.type === 'thinking' && typeof p.text === 'string') {
                this.replayKnownThinkingContents.add(p.text);
              }
            } catch {}
          }
        } catch {}
      }
      const perms = db.select({ id: claudePendingPermissions.id })
        .from(claudePendingPermissions)
        .where(eq(claudePendingPermissions.sessionId, this.id))
        .all();
      for (const p of perms) this.replayKnownPendingIds.add(p.id);
      const qs = db.select({ id: claudePendingQuestions.id })
        .from(claudePendingQuestions)
        .where(eq(claudePendingQuestions.sessionId, this.id))
        .all();
      for (const q of qs) this.replayKnownPendingIds.add(q.id);
    } catch {}
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
    name: opts.name ?? null,
    status: 'starting',
    permissionMode: opts.permissionMode ?? 'normal',
    lastUsedAt: Math.floor(Date.now() / 1000),
  }).run();

  const stream = new SessionStream({
    id: sessionId, vpsId: opts.vpsId, vpsName: vps.name,
    name: opts.name ?? null, status: 'starting',
    permissionMode: opts.permissionMode ?? 'normal',
    claudeSessionId: null,
  });
  streams.set(sessionId, stream);

  // ORDRE IMPORTANT : start_session AVANT subscribe.
  // Le subscribe agent-side throw si la session n'existe pas encore.
  // Les events émis pendant start_session (`status=starting`) restent dans le
  // ring buffer côté agent et sont rejoués au moment du subscribe (replay=300).
  try {
    const client = getAgentClientForVpsId(opts.vpsId);
    await client.call('start_session', {
      session_id: sessionId,
      cwd: opts.cwd,
      name: opts.name ?? null,
      permission_mode: opts.permissionMode ?? 'normal',
    });
  } catch (e: any) {
    streams.delete(sessionId);
    db.update(claudeSessions).set({ status: 'error' })
      .where(eq(claudeSessions.id, sessionId)).run();
    throw e;
  }
  stream.attach();
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

  const client = getAgentClientForVpsId(row.vpsId);
  // ORDRE : on s'assure que la session existe côté agent AVANT de subscribe
  // (sinon le subscribe RPC throw session_not_found).
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
  stream.attach();
  // Si l'utilisateur avait déjà ouvert l'SSE avant le resume, attach() a déjà
  // tenté un subscribe côté agent qui a failed (session pas encore existante).
  // On force un nouveau subscribe maintenant qu'elle existe.
  client.resubscribe(sessionId);
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

export async function forceStopSession(sessionId: string): Promise<void> {
  const [row] = db.select().from(claudeSessions).where(eq(claudeSessions.id, sessionId)).all();
  if (!row) return;
  db.update(claudeSessions).set({ status: 'sleeping' })
    .where(eq(claudeSessions.id, sessionId)).run();
  const stream = streams.get(sessionId);
  if (stream) {
    await stream.forceStop();
  } else {
    // Pas de stream en mémoire — on essaye quand même de joindre l'agent
    try {
      const client = getAgentClientForVpsId(row.vpsId);
      await client.call('force_stop', { session_id: sessionId });
    } catch {
      // Agent down : la DB est déjà 'sleeping', l'user peut resume plus tard
    }
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
    streams.delete(sessionId);
  }
  // Émet manuellement un status=killed sur le bus pour notifier les SSE
  // actives (puisque le stream a été retiré, son _broadcast ne tournera plus).
  // Le client traitera ça comme un kill normal et fera son cleanup local.
  emitGlobalSession({ type: 'status', sessionId, status: 'killed' } as GlobalSessionEvent);
  try {
    const client = getAgentClientForVpsId(row.vpsId);
    await client.call('kill_session', { session_id: sessionId });
  } catch (e) {
    // Agent down : ce n'est pas grave, on a déjà cleanup local
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
// Quand systemd / l'utilisateur tue le process Next (SIGTERM ou SIGINT), on
// flush en DB le texte assistant en cours d'accumulation dans chaque
// SessionStream. Sans ça, tout texte assistant streamé avant le prochain
// `stop` est perdu (cf. bug constaté quand l'app a été restartée pendant
// que Claude était encore en train d'écrire).
//
// On utilise un flag module-level pour éviter une double-registration en cas
// de hot-reload Next.
declare global {
  // eslint-disable-next-line no-var
  var __charon_shutdownRegistered: boolean | undefined;
}
// Skip pendant `next build` : le module est importé par les workers de build
// (analyse SSR), qui reçoivent un SIGINT/SIGTERM en fin de phase. Si on
// enregistre le handler, on `process.exit(0)` prématurément et ça peut
// fausser le build (cf. logs `graceful flush done on SIGINT` pendant build).
const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build';
if (!isBuildPhase && !globalThis.__charon_shutdownRegistered) {
  globalThis.__charon_shutdownRegistered = true;
  const onSignal = (sig: NodeJS.Signals) => {
    try {
      for (const s of streams.values()) {
        try { s.flushPendingAssistant(); } catch {}
      }
      // eslint-disable-next-line no-console
      console.log(`[charon] graceful flush done on ${sig} — exiting`);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
