'use client';
import { useEffect, useRef, useState } from 'react';
import { useTerminalUrlOverlay } from './useTerminalUrlOverlay';
import TerminalUrlOverlay from './TerminalUrlOverlay';

type Props = {
  shellId: string;
  vpsName: string;
  cwd: string | null;
  onKilled: () => void;
  // When false, this terminal is mounted but hidden (its slot has
  // display:none in ClaudePanel — see §14 gotcha 37). xterm gets 0
  // dimensions while hidden so the FitAddon can't measure; we skip
  // fitting and re-fit + focus on the rAF after `active` flips back
  // to true. Defaults to true (mobile + standalone callers).
  active?: boolean;
};

/**
 * Full-screen xterm.js terminal connected to an agent-hosted PTY over a
 * WebSocket (`/api/shells/[id]/ws`). The PTY itself lives inside the
 * charon-agent on the VPS (cf. agent/charon_agent/shell.py); the
 * server.js bridge subscribes to the agent's durable shell event log
 * (with `after_seq` cursor persisted in DB) and pipes bytes both ways.
 *
 * Wire protocol on the WS:
 *   Server → Browser:
 *     · binary frame  = raw shell output bytes (utf-8) → term.write
 *     · text frame    = JSON control: {type:'status'|'exit', ...}
 *   Browser → Server:
 *     · binary frame  = raw input bytes (keystrokes)
 *     · text frame    = JSON: {type:'resize', cols, rows}
 *
 * Reconnect: on close (non-1000), reconnect with exponential backoff. The
 * agent replays missed events via the durable log + `last_seen_seq` so
 * the user sees seamless continuation (no manual page refresh needed).
 */
export default function ShellTerminal({ shellId, vpsName, cwd, onKilled, active = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const closedByUserRef = useRef(false);
  // Mirror of the `active` prop readable from inside the (shellId-scoped)
  // effect closure, plus a ref to the effect's re-fit routine so the
  // separate `active` effect can trigger a fit+focus without re-running
  // the whole connect/setup effect.
  const activeRef = useRef(active);
  const refitRef = useRef<(() => void) | null>(null);
  const [exited, setExited] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const { ingest: urlIngest, dismiss: urlDismiss, visibleUrl } = useTerminalUrlOverlay();

  useEffect(() => {
    let cancelled = false;
    let term: any = null;
    let fit: any = null;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder('utf-8');

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
        scrollback: 10_000,  // generous local scrollback: with agent-hosted
        convertEol: false,   // PTYs we get the full raw stream → real history.
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);
      // Only fit when visible: a hidden slot (display:none) reports 0×0,
      // and FitAddon would either throw or snap the PTY to a 1-col size.
      if (activeRef.current) { try { fit.fit(); } catch {} }
      termRef.current = term;
      fitRef.current = fit;
      if (activeRef.current) term.focus();

      let lastSize = '';
      const pushResize = () => {
        const cols = term.cols, rows = term.rows;
        const key = `${cols}x${rows}`;
        if (key === lastSize || !cols || !rows) return;
        lastSize = key;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {}
        }
      };
      term.onResize(() => pushResize());

      // Called by the `active` effect when this terminal becomes visible
      // again after a session switch: the slot regained real dimensions,
      // so re-fit (which fires onResize → pushResize to sync the PTY) and
      // refocus. Stored in a ref so the `active` effect doesn't need to
      // re-run this whole setup effect.
      refitRef.current = () => {
        try { fit.fit(); } catch {}
        pushResize();
        try { term.focus(); } catch {}
      };

      // Keystrokes → binary frame (no JSON parse on the hot path).
      term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(encoder.encode(data)); } catch {}
        }
      });

      const writeMeta = (text: string) => {
        try { term.write(`\x1b[2m\x1b[33m${text}\x1b[0m`); } catch {}
      };

      const connect = () => {
        if (closedByUserRef.current) return;
        setConnection('connecting');
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${window.location.host}/api/shells/${shellId}/ws`;
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttemptsRef.current = 0;
          setConnection('open');
          // Force a resize push on (re)open so the agent's window size
          // matches the current browser fit (cursor moves, agent state
          // are otherwise replayed by the durable log).
          lastSize = '';
          pushResize();
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            // JSON control frame.
            let m: any;
            try { m = JSON.parse(ev.data); } catch { return; }
            if (m?.type === 'replay_begin') {
              // The server is about to replay the FULL durable log
              // (after_seq:0). Wipe the xterm first so an in-place
              // reconnect rebuilds the whole scrollback from scratch
              // instead of doubling it. See CLAUDE.md §14 gotcha 37.
              try { term.reset(); } catch {}
              return;
            }
            if (m?.type === 'replay_end') {
              // Nothing to do — the replayed bytes already painted the
              // scrollback. Marker kept for symmetry / future use.
              return;
            }
            if (m?.type === 'exit') {
              setExited(true);
              writeMeta(`\r\n[charon] shell exited (code=${m.code ?? '?'})\r\n`);
            } else if (m?.type === 'status' && m.status === 'exited') {
              setExited(true);
            }
            // status (active) → silent, nothing to render
          } else {
            // Binary frame = raw shell output bytes.
            try {
              const u8 = new Uint8Array(ev.data as ArrayBuffer);
              term.write(u8);
              urlIngest(decoder.decode(u8));
            } catch {}
          }
        };

        ws.onerror = () => { /* close handler does the cleanup */ };

        ws.onclose = (ev) => {
          wsRef.current = null;
          if (closedByUserRef.current) return;
          if (ev.code === 1000) {
            // Clean close (shell exited). No reconnect — the shell is gone.
            setConnection('closed');
            setExited(true);
            return;
          }
          // Anything else: backoff + reconnect. The agent replays missed
          // events via the durable log + last_seen_seq cursor.
          setConnection('closed');
          reconnectAttemptsRef.current++;
          const delay = Math.min(500 * 2 ** (reconnectAttemptsRef.current - 1), 8000);
          writeMeta(`\r\n[charon] reconnecting in ${Math.round(delay / 1000) || 1}s…\r\n`);
          reconnectTimerRef.current = window.setTimeout(connect, delay) as unknown as number;
        };
      };

      connect();

      const onWinResize = () => { if (activeRef.current) { try { fit.fit(); } catch {} } };
      window.addEventListener('resize', onWinResize);
      (term as any)._charonCleanup = () => window.removeEventListener('resize', onWinResize);
    })();

    return () => {
      cancelled = true;
      closedByUserRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        try { ws.close(1000, 'unmount'); } catch {}
      }
      wsRef.current = null;
      const t = termRef.current;
      if (t) {
        try { (t as any)._charonCleanup?.(); } catch {}
        try { t.dispose(); } catch {}
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [shellId]);

  // React to visibility changes WITHOUT tearing down the WS/xterm. When the
  // slot becomes visible again (session switch back to this shell), the
  // container regains real dimensions only after the browser applies the
  // style change, so we re-fit on the next animation frame. The WebSocket
  // and xterm scrollback stayed alive the whole time — switching tabs never
  // disconnects the shell (see §14 gotcha 37).
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const id = requestAnimationFrame(() => { refitRef.current?.(); });
    return () => cancelAnimationFrame(id);
  }, [active]);

  const killShell = async () => {
    closedByUserRef.current = true;
    if (wsRef.current) { try { wsRef.current.close(1000, 'user closed'); } catch {} }
    try { await fetch(`/api/shells/${shellId}`, { method: 'DELETE' }); } catch {}
    onKilled();
  };

  return (
    <div className="shell-terminal-pane">
      <header className="shell-term-head">
        <span className="title">⌨ shell · {vpsName}</span>
        {cwd && <span className="cwd">{cwd}</span>}
        {connection === 'connecting' && !exited && <span className="exit-badge" style={{ background: '#7a6a3a', color: '#fff' }}>reconnecting…</span>}
        {exited && <span className="exit-badge">ended</span>}
        <button className="kill-btn" onClick={killShell} title="close the shell">
          {exited ? 'close' : 'kill'}
        </button>
      </header>
      <div className="shell-xterm-wrap">
        <div ref={containerRef} className="shell-xterm" />
        {visibleUrl && (
          <TerminalUrlOverlay url={visibleUrl} onDismiss={urlDismiss} />
        )}
      </div>
    </div>
  );
}
