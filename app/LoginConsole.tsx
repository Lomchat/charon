'use client';
import { useEffect, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';

type Props = {
  vps: Vps;
  onClose: () => void;
};

type ConsoleEvent = { kind: 'stdout' | 'stderr' | 'meta'; text: string };

/**
 * Console interactive pour `claude login` distant.
 *
 * Flux UX :
 *   1. À l'ouverture, POST /api/vps/<id>/login (kill ancien + start)
 *   2. SSE /api/vps/<id>/login/stream affiche stdout/stderr
 *   3. Quand claude login demande une URL, l'utilisateur la voit dans la sortie
 *      (lien cliquable) — il l'ouvre dans son navigateur local
 *   4. Le navigateur lui donne un code OAuth ; il le colle dans le champ "input"
 *      → POST /login/input écrit dans stdin du process distant
 *   5. claude login confirme + exit ; la console reste affichée pour relecture
 */
export default function LoginConsole({ vps, onClose }: Props) {
  const [events, setEvents] = useState<ConsoleEvent[]>([]);
  const [input, setInput] = useState('');
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Auto-scroll
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [events]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/vps/${vps.id}/login`, { method: 'POST' });
        if (!res.ok) throw new Error(`start: HTTP ${res.status}`);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
        return;
      }
      if (cancelled) return;
      // Stream
      const es = new EventSource(`/api/vps/${vps.id}/login/stream`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const ev: ConsoleEvent = JSON.parse(e.data);
          setEvents((p) => [...p, ev]);
          if (ev.kind === 'meta' && /closed|exited/.test(ev.text)) {
            setClosed(true);
          }
        } catch {}
      };
      es.onerror = () => {
        // Connexion fermée — c'est OK si la session a terminé
      };
    })();
    return () => {
      cancelled = true;
      if (esRef.current) esRef.current.close();
      // Stop la session côté serveur si on ferme la modal
      fetch(`/api/vps/${vps.id}/login`, { method: 'DELETE' }).catch(() => {});
    };
  }, [vps.id]);

  const send = async () => {
    if (closed) return;
    const text = input;
    setInput('');
    // Append au log local pour le feedback visuel
    setEvents((p) => [...p, { kind: 'meta', text: `> ${text}` }]);
    try {
      const res = await fetch(`/api/vps/${vps.id}/login/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text + '\n' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setEvents((p) => [...p, { kind: 'meta', text: `[charon] envoi échoué : ${err?.error ?? res.status}` }]);
      }
    } catch (e: any) {
      setEvents((p) => [...p, { kind: 'meta', text: `[charon] erreur réseau : ${e?.message ?? e}` }]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  };

  // Rendu : extrait les URLs cliquables, garde le reste en mono
  const renderLine = (text: string, key: number, kind: string) => {
    const urlRe = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRe);
    return (
      <div key={key} className={`login-line kind-${kind}`}>
        {parts.map((p, i) => {
          if (urlRe.test(p)) {
            return <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>;
          }
          return <span key={i}>{p}</span>;
        })}
      </div>
    );
  };

  return (
    <div className="login-console-modal">
      <div className="login-console-card">
        <header>
          <span className="title">claude login — {vps.name}</span>
          <span className="hint">copie le code OAuth depuis ton navigateur et colle-le ici</span>
          <button onClick={onClose} className="dismiss">✕</button>
        </header>
        {error && <div className="login-error">{error}</div>}
        <div ref={consoleRef} className="login-console">
          {events.length === 0 && !error && (
            <div className="login-line kind-meta">[charon] démarrage de la session SSH…</div>
          )}
          {events.map((ev, i) => renderLine(ev.text, i, ev.kind))}
        </div>
        <div className="login-input-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={closed}
            placeholder={closed ? 'session terminée' : 'colle le code OAuth puis Enter'}
            autoFocus
            spellCheck={false}
          />
          <button onClick={send} disabled={closed || !input.trim()}>envoyer</button>
        </div>
      </div>
    </div>
  );
}
