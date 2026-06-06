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
 *     line-delimited JSON-RPC pipe to the agent. Send `shell_subscribe`
 *     with the persisted `last_seen_seq` cursor — the agent's durable log
 *     replays exactly what Charon missed (full scrollback survives Charon
 *     restarts). Multiple WS tabs to the same shell = multiple ssh + agent
 *     clients, each independently subscribed. Cheap (one ssh + ~50KB RAM
 *     per Python connection on the agent side) and isolation-friendly.
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
// NOTE: `shells.last_seen_seq` is no longer used as a replay cursor (it is
// left in the schema but vestigial). For shells the browser's xterm is the
// ONLY place the rendered scrollback lives — there is no Charon-side DB of
// the output — so on every (re)connect we replay the FULL durable log
// (after_seq:0) and the browser rebuilds its whole scrollback. An
// incremental cursor would replay "only what's new since last time", which
// for a freshly-recreated xterm (session switch, F5, reconnect) is nothing
// → blank terminal. See CLAUDE.md §14 gotcha 37.

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

// SSH options mirror lib/server/agent/AgentClient.ts SSH_OPTS — keep in sync
// if you change one. ServerAlive is a bit aggressive (3 × 20s) so dead
// connections surface fast and the browser can reconnect.
const SSH_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
  '-T',
];
// Pick the newest Python ≥ 3.10 (the agent uses PEP 604 syntax). Mirrors
// AgentClient.ts's PY constant.
const REMOTE_PY = '$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || echo python3)';
const REMOTE_AGENT_PATH = '~/.charon/charon-agent.pyz';

function handleShellWs(ws, shellId) {
  const shellRow = STMT_SHELL.get(shellId);
  if (!shellRow) { try { ws.close(1008, 'shell not found'); } catch {} return; }
  const vpsRow = STMT_VPS.get(shellRow.vps_id);
  if (!vpsRow) { try { ws.close(1011, 'vps not found'); } catch {} return; }

  const sshArgs = [
    ...SSH_OPTS,
    '-p', String(vpsRow.ssh_port),
    `${vpsRow.ssh_user}@${vpsRow.ip}`,
    `exec ${REMOTE_PY} ${REMOTE_AGENT_PATH} --connect`,
  ];
  const ssh = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  let nextRpcId = 1;
  let stdoutBuf = '';
  let alive = true;

  const sendRpc = (method, params) => {
    if (!alive) return;
    try {
      ssh.stdin.write(JSON.stringify({ id: nextRpcId++, method, params }) + '\n');
    } catch {}
  };

  // Always replay the FULL durable log (after_seq:0). The browser wipes its
  // xterm on the `replay_begin` we forward below, then rebuilds the entire
  // scrollback, so a fresh xterm (session switch, F5) AND an in-place
  // reconnect both end up showing the complete history with no duplication.
  // (Contrast with Claude sessions, where SQLite is the source of truth and
  // an incremental after_seq cursor is correct.) See CLAUDE.md §14 gotcha 37.
  sendRpc('shell_subscribe', { shell_id: shellId, after_seq: 0 });

  ssh.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // Events have no `id`; RPC responses have one and we ignore them
      // (subscribe/input/resize are fire-and-forget from our POV).
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
