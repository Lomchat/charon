'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { InstallStatus } from '@/lib/types/api';
import { IconTools, IconRobot } from './icons';

// Mirroir local de BootstrapEvent (défini server-side dans
// `lib/server/claude/bootstrap.ts`). On le redéclare pour éviter d'importer un
// module 'server-only' côté client.
export type BootstrapEvent = {
  phase: 'verify' | 'detect_os' | 'install_python' | 'install_sdk'
       | 'install_claude_cli'
       | 'install_agent' | 'install_service' | 'ping_agent'
       | 'check_login' | 'done';
  status: 'running' | 'ok' | 'error' | 'warn';
  detail?: string;
};

type Props = {
  installId: string;
  vpsId: string;
  vpsName: string;
  onClosed: () => void;
  /** Callback quand l'install se termine OK et qu'il faut proposer "Setup login".
   *  Le composant ne sait pas comment ouvrir la LoginConsole — c'est le rôle du
   *  ClaudePanel parent. */
  onSetupLogin?: () => void;
  /** Callback quand l'agent est OK, pour signaler que le user veut "fermer +
   *  ouvrir une session Claude" (UX agréable post-install). */
  onInstallSuccess?: () => void;
};

const PHASE_LABEL: Record<BootstrapEvent['phase'], string> = {
  verify:             'vérification python + SDK',
  detect_os:          'détection de l\'OS',
  install_python:     'installation de python',
  install_sdk:        'installation de claude-agent-sdk',
  install_claude_cli: 'installation de la CLI claude',
  install_agent:      'dépôt du charon-agent',
  install_service:    'service systemd-user',
  ping_agent:         'ping du daemon',
  check_login:        'vérification claude login',
  done:               'terminé',
};

const STATUS_GLYPH: Record<BootstrapEvent['status'], string> = {
  running: '▸',
  ok:      '✓',
  warn:    '⚠',
  error:   '✗',
};

/**
 * Plein-écran (occupe `claude-main`) qui affiche le log d'une session
 * d'installation d'agent. Stream SSE depuis `/api/installs/[id]/stream`,
 * ring buffer replay-é au mount, puis live.
 *
 * Diffère de l'ancien BootstrapBanner :
 *  - Plein-écran (pas un bandeau en haut)
 *  - Le state est porté côté serveur (ring buffer) ; le client reconnecte
 *    sans perdre l'historique
 *  - Bouton Retry / Setup Login en fonction du status final
 */
export default function InstallSessionView({
  installId, vpsId, vpsName, onClosed, onSetupLogin, onInstallSuccess,
}: Props) {
  const [events, setEvents] = useState<BootstrapEvent[]>([]);
  const [status, setStatus] = useState<InstallStatus>('running');
  const [busy, setBusy] = useState<null | 'retry' | 'close'>(null);
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLUListElement>(null);
  // Marqueur "replay en cours" : pendant cette fenêtre, on remplace plutôt que
  // d'append (sinon double affichage). Mis à false sur replay_end.
  const replayingRef = useRef(false);
  // Tracker pour appeler onInstallSuccess UNE SEULE FOIS quand le status
  // transitions running → success.
  const lastStatusRef = useRef<InstallStatus>('running');

  useEffect(() => {
    const es = new EventSource(`/api/installs/${installId}/stream`);
    esRef.current = es;
    let aborted = false;

    es.onmessage = (e) => {
      if (aborted) return;
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.kind === 'replay_begin') {
        replayingRef.current = true;
        // Reset l'historique local — on va le réhydrater depuis le ring server
        setEvents([]);
        return;
      }
      if (msg.kind === 'replay_end') {
        replayingRef.current = false;
        return;
      }
      if (msg.kind === 'event') {
        const ev: BootstrapEvent = msg.ev;
        setEvents((prev) => {
          // Heuristique de coalescing : si la dernière entrée a la même phase
          // et était `running`, on la remplace (mise à jour de statut intra-
          // phase). Sinon append. Vient direct de BootstrapBanner.
          const last = prev[prev.length - 1];
          if (last && last.phase === ev.phase && last.status === 'running') {
            return [...prev.slice(0, -1), ev];
          }
          return [...prev, ev];
        });
        return;
      }
      if (msg.kind === 'status') {
        const next: InstallStatus = msg.status;
        setStatus(next);
        if (lastStatusRef.current === 'running' && next === 'success') {
          onInstallSuccess?.();
        }
        lastStatusRef.current = next;
        return;
      }
    };
    es.onerror = () => {
      // EventSource reconnecte automatiquement. On ne ferme PAS — c'est l'user
      // qui ferme via la X dans le header, le clic-droit Fermer, ou en
      // re-démontant le composant. Le ring server-side survit aux drops.
    };
    return () => {
      aborted = true;
      try { es.close(); } catch {}
    };
  }, [installId, onInstallSuccess]);

  // Auto-scroll en bas quand de nouveaux events arrivent
  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events]);

  async function doRetry() {
    if (busy) return;
    setBusy('retry');
    try {
      await api.retryInstall(installId);
    } catch (e: any) {
      setEvents((prev) => [...prev, { phase: 'done', status: 'error', detail: 'retry failed: ' + (e?.message ?? e) }]);
    } finally {
      setBusy(null);
    }
  }

  async function doClose() {
    if (busy) return;
    setBusy('close');
    try {
      await api.closeInstall(installId);
    } catch {}
    onClosed();
  }

  // Détecte si la phase check_login a warn (= pas de claude login fait) pour
  // proposer le bouton "Setup login" quand l'install est success.
  const checkLoginEvent = events.find((ev) => ev.phase === 'check_login');
  const needsLogin = status === 'success' && checkLoginEvent?.status === 'warn';

  return (
    <main className="claude-main install-main">
      <header className={`install-head install-status-${status}`}>
        <span className="install-icon"><IconTools /></span>
        <div className="install-titles">
          <span className="install-title">installation de l'agent</span>
          <span className="install-sub">{vpsName}</span>
        </div>
        <span className={`install-pill pill-${status}`}>
          {status === 'running' ? <><span className="dot" /> en cours…</>
            : status === 'success' ? '✓ terminé'
            : '✗ échec'}
        </span>
        <div className="install-head-actions">
          {status === 'error' && (
            <button
              className="install-btn primary"
              onClick={doRetry}
              disabled={busy !== null}
              title="relancer l'installation depuis le début"
            >{busy === 'retry' ? '⟳ retry…' : '⟳ retry'}</button>
          )}
          {needsLogin && onSetupLogin && (
            <button
              className="install-btn primary"
              onClick={onSetupLogin}
              title="ouvrir le terminal claude login pour ce VPS"
            ><IconRobot /> setup claude login</button>
          )}
          <button
            className="install-btn"
            onClick={doClose}
            disabled={busy !== null}
            title="fermer cette session install (l'install elle-même n'est pas annulée)"
          >{busy === 'close' ? '⟳' : '✕'} fermer</button>
        </div>
      </header>
      <ul className="install-steps" ref={logRef}>
        {events.length === 0 && (
          <li className="install-step status-running">
            <span className="glyph">▸</span>
            <span className="label">connexion au stream…</span>
          </li>
        )}
        {events.map((ev, i) => (
          <li key={i} className={`install-step status-${ev.status}`}>
            <span className="glyph">{STATUS_GLYPH[ev.status]}</span>
            <span className="label">{PHASE_LABEL[ev.phase]}</span>
            {ev.detail && <span className="detail">{ev.detail}</span>}
          </li>
        ))}
        {status === 'success' && (
          <li className="install-footer-msg ok">
            ✓ l'agent est installé et opérationnel sur <strong>{vpsName}</strong>.
            {needsLogin
              ? <> Termine en faisant <em>claude login</em> via le bouton ci-dessus.</>
              : <> Tu peux maintenant ouvrir une session Claude depuis la sidebar.</>}
          </li>
        )}
        {status === 'error' && (
          <li className="install-footer-msg err">
            ✗ l'installation a échoué. Relis le log ci-dessus, corrige le problème,
            puis clique <strong>retry</strong>.
          </li>
        )}
      </ul>
    </main>
  );
}
