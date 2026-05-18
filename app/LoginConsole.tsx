'use client';
import { useEffect, useRef, useState } from 'react';
import type { Vps } from '@/lib/db/schema';

type Props = {
  vps: Vps;
  onClose: () => void;
};

/**
 * Console interactive pour `claude login` distant.
 *
 * Utilise xterm.js (vrai émulateur VT100) pour rendre le TUI de `claude login`
 * correctement — sinon le repositionnement curseur ANSI casse l'affichage.
 *
 * Flux :
 *   1. POST /api/vps/<id>/login → spawn `ssh -tt host claude login`
 *   2. SSE /api/vps/<id>/login/stream → terminal.write(text)
 *   3. terminal.onData (clavier user) → POST /api/vps/<id>/login/input
 *
 * Donc tout marche comme un vrai terminal : ↑↓ navigation menus,
 * URLs cliquables (addon-web-links), copier-coller, etc.
 */
export default function LoginConsole({ vps, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const esRef = useRef<EventSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  // Échap (au niveau window) ferme la modale uniquement si le terminal n'a pas
  // le focus — sinon Échap est envoyé au TUI distant.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !termRef.current?.element?.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let term: any = null;
    let fit: any = null;

    (async () => {
      // Lazy import xterm (côté client uniquement)
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // Le CSS de xterm — chargé dynamiquement pour ne pas le mettre dans le
      // bundle principal (la modale est ouverte à la demande)
      // @ts-ignore — pas de typing pour import sans default
      await import('@xterm/xterm/css/xterm.css');

      if (cancelled || !containerRef.current) return;

      term = new Terminal({
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.15,
        theme: {
          background: '#0e0e0e',
          foreground: '#dcdcdc',
          cursor: '#dcdcdc',
          black: '#000', red: '#d97a6b', green: '#6cbf6c', yellow: '#d8a85a',
          blue: '#6a9bd8', magenta: '#c8a2c8', cyan: '#7ac4c4', white: '#dcdcdc',
          brightBlack: '#555', brightRed: '#e69088', brightGreen: '#8acf8a',
          brightYellow: '#e8bf7a', brightBlue: '#8ab0d8', brightMagenta: '#d8b8d8',
          brightCyan: '#9cd0d0', brightWhite: '#fff',
        },
        cursorBlink: true,
        scrollback: 2000,
        convertEol: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      // Premier fit avant ouverture du stream
      try { fit.fit(); } catch {}
      termRef.current = term;
      fitRef.current = fit;
      term.focus();

      // Stdin user → POST vers le PTY remote
      term.onData((data: string) => {
        fetch(`/api/vps/${vps.id}/login/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: data }),
        }).catch(() => {});
      });

      // Démarre la session SSH côté serveur
      try {
        const res = await fetch(`/api/vps/${vps.id}/login`, { method: 'POST' });
        if (!res.ok) throw new Error(`start: HTTP ${res.status}`);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
        return;
      }
      if (cancelled) return;

      // Stream stdout/stderr/meta → terminal.write
      const es = new EventSource(`/api/vps/${vps.id}/login/stream`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const ev: { kind: string; text: string } = JSON.parse(e.data);
          if (ev.kind === 'meta') {
            // Les meta-events charon sont injectés en jaune doux, sans CR/LF supplémentaire
            term.write(`\x1b[2m\x1b[33m${ev.text}\x1b[0m\r\n`);
            if (/closed|exited/.test(ev.text)) setClosed(true);
          } else {
            term.write(ev.text);
          }
        } catch {}
      };
      es.onerror = () => { /* connexion fermée, OK si session terminée */ };

      // Refit on resize
      const onResize = () => { try { fit.fit(); } catch {} };
      window.addEventListener('resize', onResize);
      // Cleanup local pour ce subscriber
      (term as any)._charonCleanup = () => window.removeEventListener('resize', onResize);
    })();

    return () => {
      cancelled = true;
      if (esRef.current) esRef.current.close();
      fetch(`/api/vps/${vps.id}/login`, { method: 'DELETE' }).catch(() => {});
      const t = termRef.current;
      if (t) {
        try { (t as any)._charonCleanup?.(); } catch {}
        try { t.dispose(); } catch {}
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [vps.id]);

  return (
    <div className="login-console-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="login-console-card">
        <header>
          <span className="title">claude login — {vps.name}</span>
          <span className="hint">vrai terminal · ↑↓ Enter pour menus · URL = clic · code OAuth = colle puis Enter</span>
          {closed && <span className="closed-badge">terminé</span>}
          <button onClick={onClose} className="dismiss">✕</button>
        </header>
        {error && <div className="login-error">{error}</div>}
        <div ref={containerRef} className="login-xterm" />
      </div>
    </div>
  );
}
