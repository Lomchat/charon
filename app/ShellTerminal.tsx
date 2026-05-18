'use client';
import { useEffect, useRef, useState } from 'react';

type Props = {
  shellId: string;
  vpsName: string;
  cwd: string | null;
  onKilled: () => void;
};

/**
 * Terminal xterm.js plein-écran qui s'attache à un shell SSH créé par
 * /api/vps/[id]/shells. Pas de resume : si on perd la connexion, on perd
 * le shell. Pas de DB. Fermer l'onglet = killer le shell.
 */
export default function ShellTerminal({ shellId, vpsName, cwd, onKilled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const esRef = useRef<EventSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let term: any = null;
    let fit: any = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);
      // @ts-ignore - CSS import
      await import('@xterm/xterm/css/xterm.css');

      if (cancelled || !containerRef.current) return;

      term = new Terminal({
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.2,
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
        scrollback: 5000,
        convertEol: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      try { fit.fit(); } catch {}
      termRef.current = term;
      fitRef.current = fit;
      term.focus();

      // Input user → POST
      term.onData((data: string) => {
        fetch(`/api/shells/${shellId}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: data }),
        }).catch(() => {});
      });

      // Stream SSE → terminal.write
      const es = new EventSource(`/api/shells/${shellId}/stream`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const ev: { kind: string; text: string } = JSON.parse(e.data);
          if (ev.kind === 'meta') {
            term.write(`\x1b[2m\x1b[33m${ev.text}\x1b[0m`);
            if (/exited/.test(ev.text)) setExited(true);
          } else {
            term.write(ev.text);
          }
        } catch {}
      };
      es.onerror = () => { /* le shell est peut-être fini, OK */ };

      const onResize = () => { try { fit.fit(); } catch {} };
      window.addEventListener('resize', onResize);
      (term as any)._charonCleanup = () => window.removeEventListener('resize', onResize);
    })();

    return () => {
      cancelled = true;
      if (esRef.current) esRef.current.close();
      const t = termRef.current;
      if (t) {
        try { (t as any)._charonCleanup?.(); } catch {}
        try { t.dispose(); } catch {}
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [shellId]);

  const killShell = async () => {
    try { await fetch(`/api/shells/${shellId}`, { method: 'DELETE' }); } catch {}
    onKilled();
  };

  return (
    <div className="shell-terminal-pane">
      <header className="shell-term-head">
        <span className="title">⌨ shell · {vpsName}</span>
        {cwd && <span className="cwd">{cwd}</span>}
        {exited && <span className="exit-badge">terminé</span>}
        <button className="kill-btn" onClick={killShell} title="fermer le shell">
          {exited ? 'fermer' : 'kill'}
        </button>
      </header>
      {error && <div className="shell-error">{error}</div>}
      <div ref={containerRef} className="shell-xterm" />
    </div>
  );
}
