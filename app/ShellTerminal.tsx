'use client';
import { useEffect, useRef, useState } from 'react';
import { useTerminalUrlOverlay } from './useTerminalUrlOverlay';
import TerminalUrlOverlay from './TerminalUrlOverlay';

type Props = {
  shellId: string;
  vpsName: string;
  cwd: string | null;
  onKilled: () => void;
};

/**
 * Full-screen xterm.js terminal that attaches to an SSH shell created by
 * /api/vps/[id]/shells. No resume: if we lose the connection, we lose
 * the shell. No DB. Closing the tab = killing the shell.
 */
export default function ShellTerminal({ shellId, vpsName, cwd, onKilled }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const esRef = useRef<EventSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  // Long URL detection (typically OAuth) wrapped across multiple lines —
  // copy/open overlay. Same as LoginConsole, factorable someday.
  const { ingest: urlIngest, dismiss: urlDismiss, visibleUrl } = useTerminalUrlOverlay();

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

      // Forward the terminal size to the server so the remote tmux client
      // (and thus htop/vim/…) match the browser. Debounced; deduped on
      // unchanged dimensions.
      let lastSize = '';
      const pushResize = () => {
        const cols = term.cols, rows = term.rows;
        const key = `${cols}x${rows}`;
        if (key === lastSize || !cols || !rows) return;
        lastSize = key;
        fetch(`/api/shells/${shellId}/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cols, rows }),
        }).catch(() => {});
      };
      pushResize();
      term.onResize(() => pushResize());

      // User input → POST
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
            urlIngest(ev.text);
          }
        } catch {}
      };
      es.onerror = () => { /* the shell may be finished, OK */ };

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
        {exited && <span className="exit-badge">ended</span>}
        <button className="kill-btn" onClick={killShell} title="close the shell">
          {exited ? 'close' : 'kill'}
        </button>
      </header>
      {error && <div className="shell-error">{error}</div>}
      <div className="shell-xterm-wrap">
        <div ref={containerRef} className="shell-xterm" />
        {visibleUrl && (
          <TerminalUrlOverlay url={visibleUrl} onDismiss={urlDismiss} />
        )}
      </div>
    </div>
  );
}
