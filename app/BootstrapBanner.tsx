'use client';
import { useEffect, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';

export type BootstrapEvent = {
  phase: 'verify' | 'detect_os' | 'install_python' | 'install_sdk'
       | 'install_agent' | 'install_service' | 'ping_agent'
       | 'check_login' | 'done';
  status: 'running' | 'ok' | 'error' | 'warn';
  detail?: string;
};

type Props = {
  vps: Vps;
  onDone: (success: boolean) => void;
  onCancel: () => void;
};

const PHASE_LABEL: Record<BootstrapEvent['phase'], string> = {
  verify:           'vérification python + SDK',
  detect_os:        'détection de l\'OS',
  install_python:   'installation de python',
  install_sdk:      'installation de claude-agent-sdk',
  install_agent:    'dépôt du charon-agent',
  install_service:  'service systemd-user',
  ping_agent:       'ping du daemon',
  check_login:      'vérification claude login',
  done:             'terminé',
};

const STATUS_GLYPH: Record<BootstrapEvent['status'], string> = {
  running: '▸',
  ok:      '✓',
  warn:    '⚠',
  error:   '✗',
};

export default function BootstrapBanner({ vps, onDone, onCancel }: Props) {
  const [events, setEvents] = useState<BootstrapEvent[]>([]);
  const [finished, setFinished] = useState<null | 'ok' | 'error'>(null);
  const esRef = useRef<EventSource | null>(null);
  // CRITIQUE : onDone est une arrow function inline dans ClaudePanel, donc
  // recréée à CHAQUE render du parent (poll sessions 4s, status updates, etc.).
  // Si on la met dans la dep array du useEffect, l'effet se relance à chaque
  // render → ferme la SSE en cours → en ouvre une nouvelle → le serveur
  // relance bootstrapVps depuis zéro → boucle infinie côté UI.
  // On stocke onDone dans une ref pour avoir toujours la dernière version
  // sans déclencher le useEffect.
  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);

  useEffect(() => {
    const es = new EventSource(`/api/vps/${vps.id}/claude/bootstrap`);
    esRef.current = es;
    es.onmessage = (e) => {
      let ev: BootstrapEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      setEvents((prev) => {
        // Si la dernière entrée a la même phase, on la remplace (mise à jour de statut),
        // sinon on ajoute.
        const last = prev[prev.length - 1];
        if (last && last.phase === ev.phase && last.status === 'running') {
          return [...prev.slice(0, -1), ev];
        }
        return [...prev, ev];
      });
      if (ev.phase === 'done') {
        setFinished(ev.status === 'ok' ? 'ok' : 'error');
        es.close();
        // Léger délai pour que l'utilisateur voie le ✓
        setTimeout(() => onDoneRef.current(ev.status === 'ok'), 600);
      }
      // Tout phase en 'error' sans 'done' → on s'arrête aussi
      if (ev.status === 'error' && ev.phase !== 'done') {
        setFinished('error');
        es.close();
      }
    };
    es.onerror = () => {
      // EventSource reconnecte AUTO par défaut quand le serveur ferme le
      // stream (ce qui arrive à la fin de bootstrapVps, qu'il y ait un 'done'
      // ou pas). Sans close() explicite ici, le browser relance un GET
      // /bootstrap → bootstrapVps re-tourne → boucle infinie côté UI.
      es.close();
      setFinished((prev) => prev ?? 'error');
    };
    return () => { es.close(); };
  }, [vps.id]);

  return (
    <div className={`claude-banner bootstrap ${finished ?? ''}`}>
      <header>
        <span className="title">install Claude sur {vps.name}</span>
        {!finished && <span className="hint">progression streamée — n'interromps pas</span>}
        <button onClick={onCancel} className="dismiss">✕</button>
      </header>
      <ul className="steps">
        {events.map((ev, i) => (
          <li key={i} className={`step status-${ev.status}`}>
            <span className="glyph">{STATUS_GLYPH[ev.status]}</span>
            <span className="label">{PHASE_LABEL[ev.phase]}</span>
            {ev.detail && <span className="detail">{ev.detail}</span>}
          </li>
        ))}
        {events.length === 0 && <li className="step status-running"><span className="glyph">▸</span> connexion…</li>}
      </ul>
    </div>
  );
}
