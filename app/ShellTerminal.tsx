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
 * Full-screen xterm.js terminal connected to a holder-hosted PTY over a
 * WebSocket (`/api/shells/[id]/ws`). The PTY itself lives in a detached
 * holder process on the VPS (cf. agent/charon_agent/holder.py, agent >=
 * 0.10.0 — it survives agent restarts); the server.js bridge subscribes to
 * the agent's durable shell event log and pipes bytes both ways.
 *
 * Wire protocol on the WS:
 *   Server → Browser:
 *     · binary frame  = raw shell output bytes (utf-8) → term.write
 *     · text frame    = JSON control: {type:'status'|'exit'|'gone'|'idle'
 *                       |'replay_begin'|'replay_end', ...}
 *   Browser → Server:
 *     · binary frame  = raw input bytes (keystrokes)
 *     · text frame    = JSON: {type:'resize', cols, rows}
 *
 * Reconnect: on close (non-1000), reconnect with exponential backoff. Every
 * (re)connect replays the durable-log TAIL (after_seq:0 + tail_bytes) and
 * the terminal resets on `replay_begin`, so the user sees the latest screen
 * with no duplication. 1000 = terminal (shell ended / 'gone') → no reconnect.
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
  // D1: while the agent is replaying the durable shell log on (re)connect we
  // show a "restoring…" overlay so the user doesn't watch the tail scroll up
  // from the top. Cleared on `replay_end` (or a safety watchdog if that
  // marker never arrives — e.g. an old agent or a mid-replay drop).
  const restoreWatchdogRef = useRef<number | null>(null);
  const [restoring, setRestoring] = useState(false);
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

      // Re-fit + RE-ASSERT our window size to the agent (force-resend even
      // if our own grid didn't change). Stored in a ref so the `active`
      // effect can trigger it without re-running this whole setup effect.
      //
      // The force-resend (lastSize='') is the fix for the cross-device
      // shrink bug: there is ONE shared PTY per shell, and a SECOND client
      // (e.g. the same shell opened on a phone) resizes it to ITS own, often
      // much smaller, dimensions. Our xterm grid is unchanged, so
      // term.onResize never fires and the normal dedup in pushResize would
      // swallow a re-send — leaving this terminal rendering at the other
      // device's narrow width ("writings tiny on the left") until a full
      // reconnect. Clearing lastSize lets us reclaim the PTY size whenever we
      // regain focus/visibility (last-active-wins). The agent's resize() does
      // NOT emit a shell_status event, so this can never ping-pong with the
      // other client — each side only re-asserts on its OWN user-focus
      // transition. See §14 gotcha 37 (shared single-size PTY).
      const reassertSize = () => {
        try { fit.fit(); } catch {}
        lastSize = '';
        pushResize();
      };
      refitRef.current = () => {
        reassertSize();
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
              // The server is about to replay the durable log (tail_bytes on
              // agent >= 0.9.0, else the full log). Wipe the xterm first so an
              // in-place reconnect rebuilds the scrollback from scratch
              // instead of doubling it. See CLAUDE.md §14 gotcha 37. Raise the
              // "restoring…" overlay so the user doesn't watch the tail paint.
              try { term.reset(); } catch {}
              setRestoring(true);
              if (restoreWatchdogRef.current) clearTimeout(restoreWatchdogRef.current);
              // Safety net: if `replay_end` never arrives (old agent, dropped
              // mid-replay), reveal anyway after 4s so the overlay can't stick.
              restoreWatchdogRef.current = window.setTimeout(() => {
                restoreWatchdogRef.current = null;
                setRestoring(false);
                try { term.scrollToBottom(); } catch {}
              }, 4000) as unknown as number;
              return;
            }
            if (m?.type === 'replay_end') {
              // Replay done. Drop the overlay and jump straight to the bottom
              // (the live prompt) — the whole point of D1: a reopened shell
              // shows the bottom instantly instead of scrolling up from the
              // top of the replayed tail.
              if (restoreWatchdogRef.current) {
                clearTimeout(restoreWatchdogRef.current);
                restoreWatchdogRef.current = null;
              }
              setRestoring(false);
              try { term.scrollToBottom(); } catch {}
              return;
            }
            if (m?.type === 'exit') {
              setExited(true);
              writeMeta(`\r\n[charon] shell exited (code=${m.code ?? '?'})\r\n`);
            } else if (m?.type === 'gone') {
              // The shell no longer exists anywhere (agent doesn't know it,
              // DB row pruned server-side). Terminal state — the server
              // closes with 1000 right after, so no reconnect loop.
              setExited(true);
              setRestoring(false);
              writeMeta(`\r\n[charon] this shell no longer exists (it ended while disconnected) — close the tab\r\n`);
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
          // Anything else: backoff + reconnect. The agent replays the
          // durable-log tail on the next subscribe (after_seq:0 + tail_bytes).
          setConnection('closed');
          reconnectAttemptsRef.current++;
          const delay = Math.min(500 * 2 ** (reconnectAttemptsRef.current - 1), 8000);
          writeMeta(`\r\n[charon] reconnecting in ${Math.round(delay / 1000) || 1}s…\r\n`);
          reconnectTimerRef.current = window.setTimeout(connect, delay) as unknown as number;
        };
      };

      connect();

      const onWinResize = () => { if (activeRef.current) { try { fit.fit(); } catch {} } };
      // Reclaim the shared PTY's size when this terminal regains focus or
      // visibility (the user came back to this device / window / tab after
      // another client shrank it). Gated on `active` so a hidden background
      // slot never fights for the PTY, and on the document being visible. No
      // term.focus() here on purpose: a bare visibility change must not steal
      // focus or pop the mobile soft keyboard — only an explicit session
      // switch (the `active` effect, via refitRef) refocuses.
      const onReclaim = () => {
        if (activeRef.current && document.visibilityState === 'visible') reassertSize();
      };
      window.addEventListener('resize', onWinResize);
      window.addEventListener('focus', onReclaim);
      document.addEventListener('visibilitychange', onReclaim);
      (term as any)._charonCleanup = () => {
        window.removeEventListener('resize', onWinResize);
        window.removeEventListener('focus', onReclaim);
        document.removeEventListener('visibilitychange', onReclaim);
      };
    })();

    return () => {
      cancelled = true;
      closedByUserRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (restoreWatchdogRef.current) {
        clearTimeout(restoreWatchdogRef.current);
        restoreWatchdogRef.current = null;
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
        {restoring && (
          <div className="shell-restoring" aria-hidden>
            <span className="spin" /> restoring…
          </div>
        )}
        {visibleUrl && (
          <TerminalUrlOverlay url={visibleUrl} onDismiss={urlDismiss} />
        )}
      </div>
    </div>
  );
}
