import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  db, vps as vpsTable, claudeSessions, claudeSessionMessages,
  claudePendingPermissions, claudePendingQuestions, claudeSessionLogs,
} from '@/lib/db';
import { and } from 'drizzle-orm';
import type { Vps } from '@/lib/db/schema';
import type { BridgeEvent, PermissionMode, WorkerEvent, WorkerStatus } from './types';
import { getSetting, getSettingBool } from './settings';
import { sendPushToAll } from './webPush';
import {
  sendPermissionToTelegram, sendQuestionToTelegram, markInteractionResolvedInTelegram,
} from './telegram';

const BRIDGE_PATH = path.join(process.cwd(), 'lib/server/claude/bridge.py');
let BRIDGE_B64: string | null = null;
function getBridgeBase64(): string {
  if (BRIDGE_B64 != null) return BRIDGE_B64;
  const buf = fs.readFileSync(BRIDGE_PATH);
  BRIDGE_B64 = buf.toString('base64');
  return BRIDGE_B64;
}

export type SseSink = {
  id: string;
  send: (ev: WorkerEvent) => void;
  close: () => void;
};

const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=4',
  '-T',
];

const RING_MAX = 200;

export class SessionWorker {
  readonly id: string;
  vps: Vps;
  cwd: string;
  name: string | null;
  permissionMode: PermissionMode;
  claudeSessionId: string | null;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private stderrBuf = '';
  status: WorkerStatus = 'starting';
  private ring: WorkerEvent[] = [];
  private subs = new Map<string, SseSink>();
  private alwaysAllow = new Set<string>();
  private currentAssistant = '';
  private lastError: string | null = null;
  // Pour reconnexion : nb echecs consecutifs
  private failCount = 0;
  // Si la session a été pausée alors qu'une question/permission était en
  // attente : on l'annule en DB+broadcast et on pré-remplit "continue" au
  // resume pour relancer Claude.
  private hadPendingsAtPause = false;
  // Reconnexion auto en cas de drop SSH/bridge : on retry indéfiniment avec
  // backoff jusqu'à ce que l'utilisateur fasse sleep/kill explicite.
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private aborted = false;

  constructor(opts: {
    id: string;
    vps: Vps;
    cwd: string;
    name?: string | null;
    permissionMode?: PermissionMode;
    claudeSessionId?: string | null;
  }) {
    this.id = opts.id;
    this.vps = opts.vps;
    this.cwd = opts.cwd;
    this.name = opts.name ?? null;
    this.permissionMode = opts.permissionMode ?? 'normal';
    this.claudeSessionId = opts.claudeSessionId ?? null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.child) return;
    // Toute interaction marquée 'pending' en DB est orpheline : son bridge
    // Python est mort (server restart, kill, sleep…). On les annule avant de
    // démarrer pour ne PAS les re-poser à l'utilisateur. Le flag déclenche
    // ensuite l'event prefill_input "continue" une fois en active.
    this.cancelPendingInteractionsOnPause();
    this.setStatus('starting');
    this.log('info', 'start', { vps: this.vps.id, cwd: this.cwd });

    const scriptB64 = getBridgeBase64();
    const tmpName = `/tmp/bridge_${this.id}.py`;
    // 1 SSH : deploie le bridge + exec python (3.10+ requis pour claude-agent-sdk).
    // On scanne les pythons disponibles dans l'ordre 3.13 → 3.10 → python3.
    // stdin reservee au protocole JSON entre dashboard et bridge.
    const remoteCmd =
      `mkdir -p /tmp && echo '${scriptB64}' | base64 -d > ${tmpName} && ` +
      `PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3); ` +
      `echo "[bridge: using $PY]" >&2; exec "$PY" -u ${tmpName}`;
    // Cle SSH custom depuis settings (default = /root/.ssh/id_rsa = OpenSSH default)
    const keyPath = getSetting('ssh.private_key_path');
    const keyArgs = keyPath && keyPath !== '/root/.ssh/id_rsa' ? ['-i', keyPath] : [];
    const args = [
      ...SSH_OPTS,
      ...keyArgs,
      '-p', String(this.vps.sshPort),
      `${this.vps.sshUser}@${this.vps.ip}`,
      remoteCmd,
    ];

    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.stdoutBuf = '';
    this.stderrBuf = '';

    child.stdout.on('data', (b) => this.onStdout(b));
    child.stderr.on('data', (b) => {
      const s = b.toString();
      this.stderrBuf += s;
      if (this.stderrBuf.length > 64_000) {
        this.stderrBuf = this.stderrBuf.slice(-32_000);
      }
    });
    child.on('error', (e) => {
      this.lastError = e.message;
      this.log('error', 'ssh_error', { err: e.message });
      this.handleExit(null);
    });
    child.on('close', (code) => this.handleExit(code));

    // Envoyer l'init
    const init = {
      type: 'init',
      cwd: this.cwd,
      session_id: this.claudeSessionId,
      permission_mode: this.permissionMode,
    };
    try {
      child.stdin.write(JSON.stringify(init) + '\n');
    } catch (e: any) {
      this.lastError = 'init write failed: ' + (e?.message ?? e);
      this.log('error', 'sdk_error', { err: this.lastError });
      this.setStatus('error');
    }
  }

  // sleep : tente un exit propre puis kill apres delai
  async sleep(): Promise<void> {
    this.aborted = true;
    this.cancelReconnect();
    this.setStatus('sleeping');
    this.log('info', 'sleep');
    db.update(claudeSessions)
      .set({ status: 'sleeping' })
      .where(eq(claudeSessions.id, this.id)).run();
    await this.terminateChild();
  }

  async kill(): Promise<void> {
    this.aborted = true;
    this.cancelReconnect();
    this.setStatus('killed');
    this.log('info', 'kill');
    db.update(claudeSessions)
      .set({ status: 'killed' })
      .where(eq(claudeSessions.id, this.id)).run();
    await this.terminateChild();
    // Close SSE
    for (const sub of this.subs.values()) {
      try { sub.close(); } catch {}
    }
    this.subs.clear();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { child.stdin.end(); } catch {}
    // Attendre 2s pour exit propre, sinon SIGKILL
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {}; done(); }, 2000);
      child.on('close', () => { clearTimeout(t); done(); });
    });
    this.child = null;
  }

  private handleExit(code: number | null): void {
    if (this.status === 'sleeping' || this.status === 'killed' || this.aborted) {
      // exit attendu
      this.child = null;
      return;
    }
    // exit inattendu
    const stderr = this.stderrBuf.slice(-1200).trim();
    this.log('warn', 'ssh_error', { code, stderr, lastError: this.lastError });
    this.failCount++;
    this.child = null;
    const parts: string[] = [];
    parts.push(`bridge exit code=${code ?? '?'}`);
    if (this.lastError) parts.push(`last error: ${this.lastError}`);
    if (stderr) parts.push(`stderr: ${stderr.slice(-500)}`);
    if (code === 2 && !this.lastError) {
      parts.push('hint: `claude-agent-sdk` non importable sur le VPS — vérifie pip install (POST /api/vps/<id>/claude/setup) et `claude login`');
    }
    const reason = parts.join(' | ');
    // Toujours retry — seul sleep/kill manuel arrête la boucle.
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.aborted) return;
    this.reconnectAttempts++;
    // Backoff progressif, cap à 5min. La session reste vivante côté DB
    // (status='active') tant qu'on retry — la sidebar montre "reconnexion".
    const backoffs = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
    const delay = backoffs[Math.min(this.reconnectAttempts - 1, backoffs.length - 1)];
    this.setStatus('reconnecting');
    this.broadcast({
      type: 'reconnecting',
      attempt: this.reconnectAttempts,
      nextRetryIn: delay,
      reason,
    });
    this.log('warn', 'reconnect', { attempt: this.reconnectAttempts, delay, reason });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.aborted) return;
      try {
        await this.start();
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
        this.scheduleReconnect(this.lastError);
      }
    }, delay);
  }

  // ── I/O bridge ─────────────────────────────────────────────────────────────
  private onStdout(b: Buffer): void {
    this.stdoutBuf += b.toString();
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let ev: BridgeEvent;
      try {
        ev = JSON.parse(line);
      } catch (e: any) {
        this.log('warn', 'sdk_error', { msg: 'bad json from bridge', line: line.slice(0, 200) });
        continue;
      }
      this.handleBridgeEvent(ev);
    }
  }

  private handleBridgeEvent(ev: BridgeEvent): void {
    switch (ev.type) {
      case 'ready':
        this.failCount = 0;
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.setStatus('active');
        this.broadcast(ev);
        break;
      case 'session_id':
        if (ev.id && ev.id !== this.claudeSessionId) {
          this.claudeSessionId = ev.id;
          db.update(claudeSessions)
            .set({ claudeSessionId: ev.id })
            .where(eq(claudeSessions.id, this.id)).run();
        }
        this.broadcast(ev);
        break;
      case 'assistant_text':
        this.currentAssistant += ev.delta;
        this.broadcast(ev);
        break;
      case 'thinking':
        // Persister mais ne pas broadcast par défaut (ou si, c'est un signal utile)
        this.persist('event', { type: 'thinking', text: ev.text });
        this.broadcast(ev);
        break;
      case 'tool_use':
        this.persist('tool_use', ev);
        this.broadcast(ev);
        break;
      case 'tool_result':
        this.persist('tool_result', ev);
        this.broadcast(ev);
        break;
      case 'permission_request':
        // Auto-allow si "always" déjà coché
        if (this.alwaysAllow.has(ev.tool)) {
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
        this.broadcast(ev);
        this.log('info', 'permission', { id: ev.id, tool: ev.tool });
        this.maybePush({
          title: `🔒 ${this.name ?? this.id.slice(0, 6)} : permission`,
          body: `outil ${ev.tool} — clique pour valider`,
          tag: `perm-${this.id}`,
        });
        sendPermissionToTelegram(this.id, ev.id, ev.tool, ev.input).catch(() => {});
        break;
      case 'user_question':
        // Persist en DB (resume-able / multi-onglet) ET en messages (historique chat)
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id,
            sessionId: this.id,
            kind: 'question',
            payload: JSON.stringify(ev.questions ?? []),
            status: 'pending',
          }).run();
        } catch {}
        this.persist('user_question', ev);
        this.broadcast(ev);
        this.maybePush({
          title: `❓ ${this.name ?? this.id.slice(0, 6)} : question`,
          body: `${ev.questions[0]?.question ?? 'question utilisateur'}`,
          tag: `q-${this.id}`,
        });
        sendQuestionToTelegram(this.id, ev.id, ev.questions ?? []).catch(() => {});
        break;
      case 'exit_plan_request':
        try {
          db.insert(claudePendingQuestions).values({
            id: ev.id,
            sessionId: this.id,
            kind: 'exit_plan',
            payload: JSON.stringify({ plan: ev.plan ?? '' }),
            status: 'pending',
          }).run();
        } catch {}
        this.persist('exit_plan_request', ev);
        this.broadcast(ev);
        this.maybePush({
          title: `📋 ${this.name ?? this.id.slice(0, 6)} : plan prêt`,
          body: 'Claude a fini de planifier — clique pour valider',
          tag: `plan-${this.id}`,
        });
        break;
      case 'todo_update':
        this.persist('event', { type: 'todo_update', todos: ev.todos });
        this.broadcast(ev);
        break;
      case 'edit_snapshot':
        this.persist('edit_snapshot', ev);
        this.broadcast(ev);
        break;
      case 'mode_changed':
        // Le bridge confirme le mode appliqué — on synchronise DB + UI
        this.permissionMode = ev.mode;
        try {
          db.update(claudeSessions)
            .set({ permissionMode: ev.mode })
            .where(eq(claudeSessions.id, this.id)).run();
        } catch {}
        this.broadcast(ev);
        break;
      case 'stop':
        if (this.currentAssistant) {
          this.persist('assistant', this.currentAssistant);
          this.currentAssistant = '';
        }
        db.update(claudeSessions)
          .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
          .where(eq(claudeSessions.id, this.id)).run();
        this.setStatus('active');
        this.broadcast(ev);
        // Notification push : Claude a fini sa réponse
        this.maybePush({
          title: `✓ ${this.name ?? this.id.slice(0, 6)}`,
          body: 'Claude a fini sa réponse',
          tag: `stop-${this.id}`,
        });
        break;
      case 'error':
        this.lastError = ev.msg;
        this.log('error', 'sdk_error', { msg: ev.msg, fatal: !!ev.fatal });
        this.broadcast(ev);
        if (ev.fatal) {
          this.setStatus('error');
          // child finira par exit ; on attend handleExit
        }
        break;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async sendUserMessage(content: string): Promise<void> {
    if (!this.child) throw new Error('worker not running');
    this.persist('user', content);
    const now = Math.floor(Date.now() / 1000);
    this.broadcast({ type: 'user_echo', content, createdAt: now });
    this.setStatus('thinking');
    this.child.stdin.write(JSON.stringify({ type: 'user_message', content }) + '\n');
  }

  async sendInterrupt(): Promise<void> {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ type: 'interrupt' }) + '\n');
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.child) throw new Error('worker not running');
    // Le bridge envoie mode_changed apres application — on attend l'echo
    // pour mettre a jour permissionMode/DB.
    this.child.stdin.write(JSON.stringify({ type: 'set_permission_mode', mode }) + '\n');
  }

  async respondPermission(permId: string, allow: boolean, always = false): Promise<void> {
    if (!this.child) throw new Error('worker not running');
    try {
      const [row] = db.select().from(claudePendingPermissions).where(eq(claudePendingPermissions.id, permId)).all();
      if (row && always && allow) this.alwaysAllow.add(row.toolName);
      db.update(claudePendingPermissions)
        .set({ status: allow ? 'allowed' : 'denied', respondedAt: Math.floor(Date.now() / 1000) })
        .where(eq(claudePendingPermissions.id, permId)).run();
    } catch {}
    this.child.stdin.write(JSON.stringify({ type: 'permission_response', id: permId, allow }) + '\n');
    this.broadcast({ type: 'interaction_resolved', kind: 'permission', id: permId });
    markInteractionResolvedInTelegram('permission', permId);
  }

  // Réponse à un AskUserQuestion. `answers` mappe question_text → option_label
  // (ou null pour refuser).
  async respondQuestion(qid: string, answers: Record<string, string> | null): Promise<void> {
    if (!this.child) throw new Error('worker not running');
    try {
      db.update(claudePendingQuestions)
        .set({
          status: answers ? 'answered' : 'cancelled',
          answers: answers ? JSON.stringify(answers) : null,
          respondedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(claudePendingQuestions.id, qid)).run();
    } catch {}
    this.child.stdin.write(JSON.stringify({ type: 'question_response', id: qid, answers }) + '\n');
    this.broadcast({ type: 'interaction_resolved', kind: 'question', id: qid });
    markInteractionResolvedInTelegram('question', qid);
  }

  // Réponse à un ExitPlanMode.
  async respondExitPlan(qid: string, decision: 'approve' | 'reject', feedback?: string): Promise<void> {
    if (!this.child) throw new Error('worker not running');
    const payload = { decision, feedback: feedback ?? '' };
    try {
      db.update(claudePendingQuestions)
        .set({
          status: 'answered',
          answers: JSON.stringify(payload),
          respondedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(claudePendingQuestions.id, qid)).run();
    } catch {}
    this.child.stdin.write(JSON.stringify({ type: 'exit_plan_response', id: qid, decision: payload }) + '\n');
    this.broadcast({ type: 'interaction_resolved', kind: 'exit_plan', id: qid });
  }

  // ── SSE subs ───────────────────────────────────────────────────────────────
  subscribe(sub: SseSink): void {
    this.subs.set(sub.id, sub);
    try {
      sub.send({ type: 'history_begin' });
      // Re-emit permissions encore en attente (DB) AVANT le ring (le UI les
      // affichera dans la popup directement)
      const pendings = db.select().from(claudePendingPermissions)
        .where(and(
          eq(claudePendingPermissions.sessionId, this.id),
          eq(claudePendingPermissions.status, 'pending'),
        )).all();
      for (const p of pendings) {
        let input: any = {};
        try { input = JSON.parse(p.toolInput); } catch {}
        sub.send({ type: 'permission_request', id: p.id, tool: p.toolName, input });
      }
      // Re-emit questions / exit_plan en attente
      const pendingQs = db.select().from(claudePendingQuestions)
        .where(and(
          eq(claudePendingQuestions.sessionId, this.id),
          eq(claudePendingQuestions.status, 'pending'),
        )).all();
      for (const q of pendingQs) {
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

  subscribersCount(): number {
    return this.subs.size;
  }

  // ── Private ────────────────────────────────────────────────────────────────
  private broadcast(ev: WorkerEvent): void {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    for (const sub of this.subs.values()) {
      try { sub.send(ev); } catch {}
    }
  }

  private persist(role: string, content: any): void {
    try {
      db.insert(claudeSessionMessages).values({
        sessionId: this.id,
        role,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      }).run();
    } catch (e: any) {
      this.log('warn', 'sdk_error', { msg: 'persist failed', err: e?.message ?? String(e) });
    }
  }

  private setStatus(s: WorkerStatus): void {
    if (this.status === s) return;
    const prev = this.status;
    this.status = s;
    this.broadcast({ type: 'status', status: s });
    // Si on passe en état "non-actif" (pause/erreur/kill) → annuler les
    // interactions en attente : leur future Python n'existe plus, et au resume
    // Claude n'aura pas leur réponse de toute façon.
    if (s === 'sleeping' || s === 'killed' || s === 'error') {
      this.cancelPendingInteractionsOnPause();
    }
    // Quand on revient en 'active' depuis un état pausé ET qu'on avait des
    // interactions perdues → pré-remplit l'input "continue" pour relancer.
    if (s === 'active' && this.hadPendingsAtPause &&
        (prev === 'starting' || prev === null)) {
      this.broadcast({ type: 'prefill_input', content: 'continue' });
      this.hadPendingsAtPause = false;
    }
  }

  private cancelPendingInteractionsOnPause(): void {
    let cancelled = 0;
    try {
      const perms = db.select().from(claudePendingPermissions)
        .where(and(
          eq(claudePendingPermissions.sessionId, this.id),
          eq(claudePendingPermissions.status, 'pending'),
        )).all();
      for (const p of perms) {
        db.update(claudePendingPermissions)
          .set({ status: 'cancelled', respondedAt: Math.floor(Date.now() / 1000) })
          .where(eq(claudePendingPermissions.id, p.id)).run();
        this.broadcast({ type: 'interaction_resolved', kind: 'permission', id: p.id });
        // Injecter un tool_result synthétique pour que la carte tool_use
        // (Read/Edit/Bash/...) en attente affiche "✗ interrompu" au lieu
        // de "en cours" indéfiniment.
        const toolUseId = p.id.startsWith('perm_') ? p.id.slice(5) : null;
        if (toolUseId) this.emitInterruptedToolResult(toolUseId);
        cancelled++;
      }
      const qs = db.select().from(claudePendingQuestions)
        .where(and(
          eq(claudePendingQuestions.sessionId, this.id),
          eq(claudePendingQuestions.status, 'pending'),
        )).all();
      for (const q of qs) {
        db.update(claudePendingQuestions)
          .set({ status: 'cancelled', respondedAt: Math.floor(Date.now() / 1000) })
          .where(eq(claudePendingQuestions.id, q.id)).run();
        const kind = q.kind === 'exit_plan' ? 'exit_plan' : 'question';
        this.broadcast({ type: 'interaction_resolved', kind, id: q.id });
        const toolUseId =
          q.id.startsWith('q_') ? q.id.slice(2) :
          q.id.startsWith('ep_') ? q.id.slice(3) : null;
        if (toolUseId) this.emitInterruptedToolResult(toolUseId);
        cancelled++;
      }
    } catch {}
    if (cancelled > 0) this.hadPendingsAtPause = true;
  }

  private emitInterruptedToolResult(toolUseId: string): void {
    const synth = {
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: '✗ Interrompu — la session a été pausée avant la réponse',
      is_error: true,
    };
    this.persist('tool_result', synth);
    this.broadcast(synth);
  }

  private maybePush(payload: { title: string; body: string; tag?: string }): void {
    if (!getSettingBool('notif.global_enabled')) return;
    sendPushToAll({
      ...payload,
      sessionId: this.id,
      url: `/claude?session=${this.id}`,
    }).catch(() => {});
  }

  private log(level: 'info' | 'warn' | 'error', event: string, detail?: any): void {
    try {
      db.insert(claudeSessionLogs).values({
        sessionId: this.id,
        level, event,
        detail: detail ? JSON.stringify(detail) : null,
      }).run();
    } catch {}
  }
}

// Util : génère un id court hex
export function newWorkerId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// Util : lookup VPS row
export function vpsById(id: string): Vps | null {
  const [row] = db.select().from(vpsTable).where(eq(vpsTable.id, id)).all();
  return row ?? null;
}
