import 'server-only';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, vps as vpsTable } from '@/lib/db';
import type { Vps } from '@/lib/db/schema';
import { bootstrapVps, type BootstrapEvent } from '@/lib/server/claude/bootstrap';
import { sendPushToAll } from '@/lib/server/claude/webPush';

// ── Install sessions — éphémères, mémoire seulement ─────────────────────────
// Pattern emprunté à shellSession.ts : pool global, ring buffer, subscribers
// SSE. Une fois Charon redémarré, toutes les installs en cours sont perdues —
// l'user devra relancer manuellement. C'est volontaire (cf. choix de design
// validé : cohérent avec les shells, simple, pas de migration DB nécessaire).
//
// Au max UNE install par VPS à la fois : si l'user clique "Installer" alors
// qu'une install est déjà active pour ce VPS, on retourne l'existante (focus).

export type InstallStatus = 'running' | 'success' | 'error';

export type InstallInfo = {
  id: string;
  vpsId: string;
  vpsName: string;
  status: InstallStatus;
  startedAt: number;
  endedAt: number | null;
  currentPhase: BootstrapEvent['phase'] | null;
  eventCount: number;
};

// Messages envoyés au client SSE per-install. `replay_begin`/`replay_end`
// encadrent le replay du ring buffer (envoyé au subscribe). Ensuite, du live.
export type InstallStreamMessage =
  | { kind: 'event'; ev: BootstrapEvent }
  | { kind: 'status'; status: InstallStatus; endedAt: number | null }
  | { kind: 'replay_begin'; count: number }
  | { kind: 'replay_end' };

type Sink = {
  id: string;
  send: (msg: InstallStreamMessage) => void;
  close: () => void;
};

const RING_MAX = 200;

class InstallSession {
  readonly id: string;
  readonly vpsId: string;
  readonly vpsName: string;
  status: InstallStatus = 'running';
  startedAt: number;
  endedAt: number | null = null;
  currentPhase: BootstrapEvent['phase'] | null = null;
  ring: BootstrapEvent[] = [];
  private subs = new Map<string, Sink>();
  // Marque la session comme stoppée — `start()` interrompt le for-await dès
  // qu'il voit ce flag. bootstrapVps n'accepte pas (encore) un signal, donc on
  // ne peut pas annuler proprement le RPC SSH en cours, mais on évite au moins
  // de continuer à traiter les yields suivants.
  private aborted = false;
  // Listeners "fin du run courant" — utilisé par retry() qui doit attendre que
  // le run en cours se termine avant d'en lancer un nouveau (cas rare mais
  // possible si le user spam le bouton).
  private doneListeners = new Set<() => void>();

  constructor(id: string, vps: Vps) {
    this.id = id;
    this.vpsId = vps.id;
    this.vpsName = vps.name;
    this.startedAt = Date.now();
  }

  info(): InstallInfo {
    return {
      id: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
      status: this.status, startedAt: this.startedAt, endedAt: this.endedAt,
      currentPhase: this.currentPhase, eventCount: this.ring.length,
    };
  }

  /** Lance bootstrapVps, broadcast les events, met à jour le status à la fin. */
  async run(vps: Vps): Promise<void> {
    if (this.aborted) return;
    this.status = 'running';
    this.endedAt = null;
    this._broadcastStatus();
    // Notifie le bus global : install démarrée
    emitInstallBusEvent({
      type: 'install_started',
      installId: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
      status: 'running',
    });
    try {
      for await (const ev of bootstrapVps(vps)) {
        if (this.aborted) break;
        this.currentPhase = ev.phase;
        this._addEvent(ev);
        if (ev.phase === 'done') {
          this.status = ev.status === 'ok' ? 'success' : 'error';
          this.endedAt = Date.now();
          this._broadcastStatus();
        }
      }
    } catch (e: any) {
      const errEv: BootstrapEvent = { phase: 'done', status: 'error', detail: String(e?.message ?? e) };
      this._addEvent(errEv);
      this.status = 'error';
      this.endedAt = Date.now();
      this._broadcastStatus();
    } finally {
      // Si bootstrapVps a return-é mid-phase sur erreur (sans yield 'done'),
      // on marque manuellement comme erreur.
      if (this.status === 'running' && !this.aborted) {
        this.status = 'error';
        this.endedAt = Date.now();
        const errEv: BootstrapEvent = { phase: 'done', status: 'error', detail: 'bootstrap interrompu sans phase done' };
        this._addEvent(errEv);
        this._broadcastStatus();
      }
      // Notif "fin du run" pour les retry()-eurs en attente.
      for (const cb of this.doneListeners) { try { cb(); } catch {} }
      this.doneListeners.clear();
      // Notif globale (push + bus) si on est terminé.
      if (this.status !== 'running') {
        emitInstallBusEvent({
          type: 'install_finished',
          installId: this.id, vpsId: this.vpsId, vpsName: this.vpsName,
          status: this.status,
        });
        this._sendPush().catch(() => {});
      }
    }
  }

  /** Relance bootstrap. Si un run est encore en cours, attend qu'il finisse. */
  async retry(): Promise<void> {
    if (this.status === 'running') {
      await new Promise<void>((res) => this.doneListeners.add(res));
    }
    // Marque visuel "── retry ──" pour que l'user comprenne dans le log que
    // c'est une nouvelle tentative et pas la suite de la précédente.
    this._addEvent({ phase: 'verify', status: 'running', detail: '── retry ──' });
    const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, this.vpsId)).all();
    if (!v) {
      this._addEvent({ phase: 'done', status: 'error', detail: 'vps introuvable (supprimé ?)' });
      this.status = 'error';
      this.endedAt = Date.now();
      this._broadcastStatus();
      return;
    }
    await this.run(v);
  }

  /** Stop : ferme les subscribers, marque aborted. Le run en cours ne sera
   *  pas vraiment annulé (le SSH en cours continue jusqu'à son timeout) mais
   *  on n'émet plus rien. */
  stop(): void {
    this.aborted = true;
    for (const s of this.subs.values()) {
      try { s.close(); } catch {}
    }
    this.subs.clear();
  }

  subscribe(sink: Sink): void {
    this.subs.set(sink.id, sink);
    try {
      sink.send({ kind: 'replay_begin', count: this.ring.length });
      for (const ev of this.ring) {
        sink.send({ kind: 'event', ev });
      }
      sink.send({ kind: 'replay_end' });
      sink.send({ kind: 'status', status: this.status, endedAt: this.endedAt });
    } catch {}
  }

  unsubscribe(id: string): void {
    this.subs.delete(id);
  }

  private _addEvent(ev: BootstrapEvent): void {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    for (const s of this.subs.values()) {
      try { s.send({ kind: 'event', ev }); } catch {}
    }
  }

  private _broadcastStatus(): void {
    for (const s of this.subs.values()) {
      try { s.send({ kind: 'status', status: this.status, endedAt: this.endedAt }); } catch {}
    }
  }

  private async _sendPush(): Promise<void> {
    const success = this.status === 'success';
    try {
      await sendPushToAll({
        title: success ? '✓ installation OK' : '✗ installation échouée',
        body: `${this.vpsName} — ${success ? 'agent installé et opérationnel' : 'voir le log'}`,
        // L'URL contient l'installId pour que le service worker (sw.js) puisse
        // ouvrir la bonne session via ?install=<id> au clic.
        url: '/?install=' + this.id,
        tag: 'install:' + this.vpsId,
      });
    } catch {}
  }
}

// ── Bus global pour les events install (notifs cross-session) ───────────────
// Bus séparé du bus session-tagged (sessionOps.ts § subscribeGlobalSessionEvents)
// parce que les installs n'ont pas de Claude sessionId. Le SSE multiplexé
// `/api/claude/events` s'y abonne en plus du bus session, et forward les
// events à toutes les connexions (low-volume, broadcast).

export type InstallBusEvent =
  | { type: 'install_started'; installId: string; vpsId: string; vpsName: string; status: InstallStatus }
  | { type: 'install_finished'; installId: string; vpsId: string; vpsName: string; status: InstallStatus };

const gBus = globalThis as unknown as { _installBusSubs?: Set<(ev: InstallBusEvent) => void> };
if (!gBus._installBusSubs) gBus._installBusSubs = new Set();
const installBusSubs: Set<(ev: InstallBusEvent) => void> = gBus._installBusSubs;

export function subscribeInstallBus(cb: (ev: InstallBusEvent) => void): () => void {
  installBusSubs.add(cb);
  return () => { installBusSubs.delete(cb); };
}

function emitInstallBusEvent(ev: InstallBusEvent): void {
  for (const cb of installBusSubs) {
    try { cb(ev); } catch {}
  }
}

// ── Pool global keyed par installId ─────────────────────────────────────────
const gPool = globalThis as unknown as { _installSessions?: Map<string, InstallSession> };
if (!gPool._installSessions) gPool._installSessions = new Map();
const pool: Map<string, InstallSession> = gPool._installSessions;

/** Démarre une nouvelle install pour ce VPS. Si une install est déjà en cours
 *  pour ce VPS, retourne l'existante (focus, pas double-run). */
export function startInstall(vpsId: string): InstallSession {
  const [v] = db.select().from(vpsTable).where(eq(vpsTable.id, vpsId)).all();
  if (!v) throw new Error('vps not found');
  for (const s of pool.values()) {
    if (s.vpsId === vpsId && s.status === 'running') {
      return s;
    }
  }
  const id = crypto.randomBytes(8).toString('hex');
  const sess = new InstallSession(id, v);
  pool.set(id, sess);
  // Lance en arrière-plan — la promise est dropée volontairement, on suit la
  // progression via le ring buffer.
  sess.run(v).catch(() => {});
  return sess;
}

export function getInstall(id: string): InstallSession | null {
  return pool.get(id) ?? null;
}

export function getInstallByVps(vpsId: string): InstallSession | null {
  for (const s of pool.values()) {
    if (s.vpsId === vpsId) return s;
  }
  return null;
}

export function listInstalls(): InstallSession[] {
  return Array.from(pool.values());
}

export function stopInstall(id: string): boolean {
  const s = pool.get(id);
  if (!s) return false;
  s.stop();
  pool.delete(id);
  return true;
}

export function retryInstall(id: string): InstallSession | null {
  const s = pool.get(id);
  if (!s) return null;
  s.retry().catch(() => {});
  return s;
}

export { InstallSession };
