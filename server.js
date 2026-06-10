/**
 * Custom Next.js server with WebSocket support for persistent shells.
 *
 * Why custom: Next.js App Router doesn't expose raw socket upgrades from
 * route handlers, so a WebSocket endpoint requires wrapping the HTTP
 * server ourselves. Everything else (pages + REST routes) goes through
 * Next's regular request handler.
 *
 * Architecture for `/api/shells/<id>/ws`:
 *   - Auth: direct SQLite read of the `sessions` table (the cookie value
 *     IS the session id, validated against expires_at; same logic as the
 *     middleware, inlined here because middleware doesn't run on upgrades).
 *   - Per WS connection: spawn its own `ssh ... charon-agent.pyz --connect`
 *     line-delimited JSON-RPC pipe to the agent — but all connections to a
 *     given VPS share one SSH ControlMaster (see sshShared.js), so opening
 *     a WS after the persistent AgentClient is up costs ~0 handshakes.
 *     `shell_subscribe` replays the durable-log TAIL (after_seq:0 +
 *     tail_bytes) on every (re)connect. Multiple WS tabs to the same shell
 *     = multiple agent clients, each independently subscribed. Cheap
 *     (~50KB RAM per Python connection agent-side) and isolation-friendly.
 *   - Wire protocol on the WS:
 *       Server → Browser:
 *         · binary frame  = raw shell output bytes (utf-8)
 *         · text frame    = JSON control: {type:'status'|'exit', ...}
 *       Browser → Server:
 *         · binary frame  = raw input bytes (keystrokes)
 *         · text frame    = JSON control: {type:'resize', cols, rows}
 *     Using binary for the high-volume data path avoids any JSON parse
 *     in the hot loop; control messages stay readable for debugging.
 *
 * Deployment: the systemd unit's ExecStart must point at `node server.js`
 * (replacing `next start`). `next build` is still required first to
 * produce .next/.
 */
const { createServer } = require('node:http');
const { parse } = require('node:url');
const { spawn } = require('node:child_process');
const next = require('next');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '10556', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// ── DB (auth + shell metadata) ────────────────────────────────────────────
const dbPath = process.env.DATABASE_URL || './data/charon.db';
const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');
// Prepared statements (hot path: every WS upgrade hits sessionValid).
const STMT_SESSION = db.prepare('SELECT expires_at FROM sessions WHERE id = ?');
const STMT_SHELL = db.prepare('SELECT id, vps_id FROM shells WHERE id = ?');
const STMT_VPS = db.prepare('SELECT id, ip, ssh_user, ssh_port FROM vps WHERE id = ?');
// Phantom-shell retirement: when the agent answers `shell_subscribe` with
// "shell not found", the shell is gone for good (bash exited / VPS rebooted)
// but a stale DB row would keep the sidebar entry alive and the browser
// reconnect-looping. Prune it right here — server.js already owns a SQLite
// handle — and tell the browser via a terminal {type:'gone'} control frame.
const STMT_DELETE_SHELL = db.prepare('DELETE FROM shells WHERE id = ?');
// NOTE: there is deliberately NO replay cursor for shells (the vestigial
// `shells.last_seen_seq` column was dropped in migration 0016). The
// browser's xterm is the ONLY place the rendered scrollback lives — there
// is no Charon-side DB of the output — so on every (re)connect we replay
// the durable-log TAIL (after_seq:0 + tail_bytes) and the browser rebuilds
// its scrollback from scratch. An incremental cursor would replay "only
// what's new since last time", which for a freshly-recreated xterm
// (session switch, F5, reconnect) is nothing → blank terminal. See
// CLAUDE.md §14 gotcha 37.

function parseCookie(header, name) {
  if (!header) return null;
  const m = ('; ' + header).match(new RegExp('; ' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function sessionValid(id) {
  if (!id || typeof id !== 'string') return false;
  const row = STMT_SESSION.get(id);
  if (!row) return false;
  return row.expires_at >= Math.floor(Date.now() / 1000);
}

// SSH plumbing shared with lib/server/agent/AgentClient.ts — single source
// of truth (options, remote python lookup, ControlMaster mux). The per-VPS
// ControlMaster socket means a WS open piggybacks on the persistent
// AgentClient's already-open TCP+handshake (~0ms instead of 200-2000ms).
// ServerAlive here is snappier (3 × 20s) than the AgentClient's (4 × 30s)
// so dead WS links surface fast and the browser can reconnect.
const { buildAgentSshArgs } = require('./lib/server/agent/sshShared.js');

// How many bytes of trailing shell OUTPUT to replay on (re)connect (agent
// >= 0.9.0 `tail_bytes`). 512 KB comfortably fills xterm's 10k-line
// scrollback while making a reopen near-instant (vs. re-streaming the whole
// multi-MB log) and slashing VPS→hub egress. See CLAUDE.md §14 gotcha 37.
const SHELL_REPLAY_TAIL_BYTES = 512 * 1024;

function handleShellWs(ws, shellId) {
  const shellRow = STMT_SHELL.get(shellId);
  if (!shellRow) {
    // No DB row: the shell was already retired (or never existed). `gone` +
    // a CLEAN close (1000) — the browser treats 1000 as terminal, anything
    // else as "transient, reconnect with backoff" (which for a dead shell
    // means looping forever).
    try { ws.send(JSON.stringify({ type: 'gone' })); } catch {}
    try { ws.close(1000, 'shell not found'); } catch {}
    return;
  }
  const vpsRow = STMT_VPS.get(shellRow.vps_id);
  if (!vpsRow) { try { ws.close(1011, 'vps not found'); } catch {} return; }

  const sshArgs = buildAgentSshArgs(
    { ip: vpsRow.ip, sshUser: vpsRow.ssh_user, sshPort: vpsRow.ssh_port },
    { serverAliveInterval: 20, serverAliveCountMax: 3 },
  );
  const ssh = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  let nextRpcId = 1;
  let stdoutBuf = '';
  let alive = true;
  let subscribeRpcId = 0;

  const sendRpc = (method, params) => {
    if (!alive) return 0;
    const id = nextRpcId++;
    try {
      ssh.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    } catch {}
    return id;
  };

  // Replay the TAIL of the durable log (agent >= 0.9.0). Reopening a busy
  // shell used to re-stream the WHOLE log (tens of MB) → the user watched it
  // scroll for seconds before reaching the bottom, AND it re-egressed all
  // those bytes VPS→hub on every (re)connect. `tail_bytes` asks the agent for
  // only the last ~512 KB of OUTPUT (enough to fill xterm's 10k-line
  // scrollback), so a reopen is near-instant. We STILL send `after_seq: 0`:
  // older agents (< 0.9.0) ignore the unknown `tail_bytes` param and fall
  // back to the full-log replay (prior behavior — correct, just slower). The
  // browser wipes its xterm on the `replay_begin` we forward below, then
  // rebuilds the scrollback, so a fresh xterm (session switch, F5) AND an
  // in-place reconnect both end up showing the tail with no duplication.
  // (Contrast with Claude sessions, where SQLite is the source of truth and
  // an incremental after_seq cursor is correct.) See CLAUDE.md §14 gotcha 37.
  subscribeRpcId = sendRpc('shell_subscribe', { shell_id: shellId, after_seq: 0, tail_bytes: SHELL_REPLAY_TAIL_BYTES });

  ssh.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // RPC responses: only the initial shell_subscribe matters — an error
      // there means the agent does NOT know this shell (it died while no
      // one was reconciling: VPS reboot, bash exit, holder killed). Retire
      // the phantom DB row and end cleanly so the browser shows "ended"
      // instead of reconnect-looping. input/resize responses stay ignored.
      if (typeof msg.id === 'number') {
        if (msg.id === subscribeRpcId && msg.error) {
          console.warn(`[charon ws] shell ${shellId} unknown to agent (${msg.error.message ?? msg.error.code}) — pruning`);
          try { STMT_DELETE_SHELL.run(shellId); } catch {}
          try { ws.send(JSON.stringify({ type: 'gone' })); } catch {}
          try { ws.close(1000, 'shell gone'); } catch {}
        }
        continue;
      }
      if (typeof msg.event === 'string') {
        if (msg.event === 'shell_output') {
          // Binary frame = raw bytes (utf-8). No JSON parse cost on the
          // browser side, just term.write().
          try { ws.send(Buffer.from(msg.data, 'utf8')); } catch {}
        } else if (msg.event === 'shell_status') {
          try { ws.send(JSON.stringify({ type: 'status', status: msg.status, cols: msg.cols, rows: msg.rows, pid: msg.pid })); } catch {}
        } else if (msg.event === 'shell_exit') {
          try { ws.send(JSON.stringify({ type: 'exit', code: msg.code })); } catch {}
          try { ws.close(1000, 'shell exited'); } catch {}
        } else if (msg.event === 'shell_idle') {
          // Transient "the shell finished something" signal (agent >= 0.8.0).
          // The push/telegram notification is sent server-side via the
          // persistent AgentClient's shell_watch (see shellNotify.ts); here we
          // just forward it to the browser as a control frame for an optional
          // in-terminal hint. Never replayed (the agent doesn't log it).
          try { ws.send(JSON.stringify({ type: 'idle', idleSeconds: msg.idle_seconds, burstSeconds: msg.burst_seconds, burstBytes: msg.burst_bytes })); } catch {}
        } else if (msg.event === 'replay_begin') {
          // Tell the browser to wipe its xterm before the full-history
          // replay so an in-place reconnect doesn't double the scrollback.
          try { ws.send(JSON.stringify({ type: 'replay_begin' })); } catch {}
        } else if (msg.event === 'replay_end') {
          try { ws.send(JSON.stringify({ type: 'replay_end' })); } catch {}
        }
      }
    }
  });
  ssh.stderr.on('data', () => { /* swallow — agent logs to its own file */ });
  ssh.on('exit', () => {
    alive = false;
    try { ws.close(1011, 'ssh closed'); } catch {}
  });

  ws.on('message', (data, isBinary) => {
    if (!alive) return;
    if (isBinary) {
      // Raw keystroke bytes. Buffer → utf-8 string for the JSON-RPC.
      const txt = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
      sendRpc('shell_input', { shell_id: shellId, data: txt });
      return;
    }
    // Text frame = JSON control.
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m && m.type === 'resize' && Number.isFinite(m.cols) && Number.isFinite(m.rows)) {
      sendRpc('shell_resize', { shell_id: shellId, cols: m.cols, rows: m.rows });
    } else if (m && m.type === 'input' && typeof m.data === 'string') {
      // Convenience fallback: input as text. Same effect as binary.
      sendRpc('shell_input', { shell_id: shellId, data: m.data });
    }
  });

  const teardown = () => {
    if (!alive) return;
    alive = false;
    try { sendRpc('shell_unsubscribe', { shell_id: shellId }); } catch {}
    try { ssh.stdin.end(); } catch {}
    try { ssh.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { ssh.kill('SIGKILL'); } catch {} }, 1500);
  };
  ws.on('close', teardown);
  ws.on('error', teardown);
}

// ── Boot ──────────────────────────────────────────────────────────────────
app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res, parse(req.url, true)));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = parse(req.url || '');
    const m = pathname && pathname.match(/^\/api\/shells\/([a-f0-9]+)\/ws$/);
    if (!m) { socket.destroy(); return; }
    const sid = parseCookie(req.headers.cookie || '', 'charon_session');
    if (!sessionValid(sid)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleShellWs(ws, m[1]));
  });

  server.listen(port, hostname, () => {
    console.log(`[charon] ready on http://${hostname}:${port}  (ws: /api/shells/<id>/ws)`);
  });
}).catch((e) => {
  console.error('[charon] failed to start:', e);
  process.exit(1);
});
