# ADR-001 — charon-agent: a per-VPS daemon for persistent sessions

**Status**: adopted · **Date**: 2026-05-18

> **Historical note**: this ADR documents the migration **from** the old
> pre-v2 architecture (a `bridge.py` process as a child of one SSH per
> session) **to** the current architecture (a `charon-agent` daemon per VPS
> that multiplexes N sessions). Everything described in the "Decision"
> section below is the present state of the code. The "Context" section
> describes the old architecture, kept to explain the *why*. A deployer
> starting on a fresh DB has nothing to do — the
> `migrationV2IfNeeded()` is a no-op on a fresh base.

## Context

Today a Claude session = one `bridge.py` process as a child of an `ssh`
spawned by Charon's Node.js `SessionWorker`. Consequences:

1. **Coupling to Charon's process lifetime**: restart Charon → all SSHs
   die → all bridges die → all remote `ClaudeSDKClient` die. Resume works
   (the SDK re-reads its disk history) but we lose pending permissions and
   any in-flight interrupt.
2. **N sessions = N SSH connections** per VPS, which multiplies handshakes
   and complicates rate-limiting / monitoring.
3. **Heavy installation**: each VPS must have `python3.10+`,
   `claude-agent-sdk`, and a `claude login`. `bridge.py` is redeployed in
   base64 on every session.

## Decision

On each VPS, a single **daemon** (`charon-agent`) manages **N Claude
sessions** internally (each session = an asyncio coroutine with its
`ClaudeSDKClient`). Charon (the Next.js hub) no longer spawns a child SSH
per session: it maintains **a single SSH connection per VPS**, multiplexed
in JSON-RPC, to the daemon's Unix socket `~/.charon/agent.sock`.

```
┌───────────────┐    HTTPS/SSE     ┌───────────────────────┐    SSH (1 per VPS)     ┌──────────────────────┐
│  Browser      │ ◄───────────────►│  Charon (Next.js)     │ ◄────────────────────► │  charon-agent (VPS)  │
│  ClaudePanel  │   SSE per session│  - AgentClientPool    │  exec: agent --connect │  - asyncio Unix sock │
└───────────────┘                  │  - 1 multiplexed SSH/ │  → stdio↔socket proxy  │  - N sessions        │
                                   │    VPS, JSON-RPC      │                        │  - state.json        │
                                   └───────────────────────┘                        │  - persists resumes  │
                                                                                    └──────────────────────┘
```

### Key properties

- **Sessions independent of Charon**. Restarting Charon no longer kills any
  session — the agent keeps running, and Charon's next connection
  re-subscribes.
- **Sessions independent of the agent too** (as much as possible): the
  agent writes `~/.charon/state.json` after every change; at daemon boot, it
  restores all known sessions in `resume` mode (via their persisted SDK
  `claude_session_id`).
- **A single SSH per VPS**: multiplexed, auto-reconnect with backoff on the
  Charon side. The Charon-side DB session stays `active` during reconnects
  (the UI displays `reconnecting`).
- **Ultra-light install**: a single `charon-agent.pyz` file (Python stdlib
  zipapp, ~50KB) + a systemd-user unit. No `pip install` on the agent side
  (the SDK is installed separately; this is just a blob we `scp`).
- **`claude login` is still manual** but made easier by a mini-terminal in
  the UI (SSE for stdout + POST for stdin).

## JSON-RPC protocol (line-delimited JSON)

### Transport

Charon opens a long-running SSH per VPS:

```
ssh user@host -- /opt/charon/charon-agent.pyz --connect
```

The binary in `--connect` mode opens `~/.charon/agent.sock` and acts as a
bidirectional stdin ↔ socket proxy. If the socket is absent, it exits with
code 2 (Charon detects this → offers a setup to the user).

No `socat` / `nc` required: everything is in the `.pyz`.

### Format

Each line (separated by `\n`) is a JSON object. Three variants:

- **Request** (Charon → Agent): `{"id": <int>, "method": "<str>", "params": {...}}`
- **Response** (Agent → Charon): `{"id": <int>, "result": {...}}` or `{"id": <int>, "error": {"code": <int>, "message": "<str>"}}`
- **Event** (Agent → Charon, unsolicited): `{"event": "<str>", "session_id": "<id>", ...}`

The `id`s are allocated by Charon (increasing integers, scoped to the
connection).

### Methods (Charon → Agent)

| Method | Params | Result |
|---|---|---|
| `hello` | `{client: "charon", version}` | `{agent_version, sdk_version, sessions: [SessionInfo]}` |
| `list_sessions` | `{}` | `[SessionInfo]` |
| `start_session` | `{session_id, cwd, name?, permission_mode?, claude_session_id?}` | `{session_id}` |
| `subscribe` | `{session_id, replay?: int}` | `{ok: true, replay_count}` — the agent then pushes the buffered events (up to `replay` last ones) then live |
| `unsubscribe` | `{session_id}` | `{ok: true}` |
| `send_input` | `{session_id, content}` | `{ok: true}` |
| `interrupt` | `{session_id}` | `{ok: true}` |
| `set_permission_mode` | `{session_id, mode}` | `{ok: true}` |
| `respond_permission` | `{session_id, perm_id, allow, always?}` | `{ok: true}` |
| `respond_question` | `{session_id, q_id, answers}` | `{ok: true}` |
| `respond_exit_plan` | `{session_id, q_id, decision, feedback?}` | `{ok: true}` |
| `sleep_session` | `{session_id}` | `{ok: true}` — stops the session, keeps the `claude_session_id` |
| `kill_session` | `{session_id}` | `{ok: true}` — stops + removes from state.json |
| `ping` | `{}` | `{pong: true, ts}` |

### Events (Agent → Charon)

All carry `session_id`. The set mirrors the current `BridgeEvent`:

```
{event: "status", session_id, status: "starting"|"active"|"thinking"|"sleeping"|"error"}
{event: "session_id", session_id, claude_session_id}     # SDK uuid persisted
{event: "ready", session_id}
{event: "assistant_text", session_id, delta}
{event: "thinking", session_id, text}
{event: "tool_use", session_id, id, name, input}
{event: "tool_result", session_id, tool_use_id, content, is_error}
{event: "permission_request", session_id, id, tool, input}
{event: "user_question", session_id, id, questions}
{event: "exit_plan_request", session_id, id, plan}
{event: "todo_update", session_id, todos}
{event: "edit_snapshot", session_id, phase, tool_use_id, file_path, content, size, truncated}
{event: "mode_changed", session_id, mode}
{event: "stop", session_id, subtype}
{event: "error", session_id, msg, fatal?}
```

### Ring buffer

The agent buffers the **last N=300 events per session** in memory. On
`subscribe`, it sends them first (bracketed by synthetic
`history_begin`/`history_end` events sent by Charon to the browser, not
part of the agent protocol). Permissions/questions still `pending` are not
in the ring: the agent maintains separate collections and re-sends them
first on subscribe.

## Agent lifecycle

### Daemon startup

```
charon-agent [--socket PATH]
```

1. Creates `~/.charon/` if absent (chmod 700).
2. Opens the Unix socket `~/.charon/agent.sock` (chmod 600).
3. Reads `~/.charon/state.json`: for each known session, **launches a
   restore** (asyncio task that re-instantiates a `ClaudeSDKClient` with
   `resume=claude_session_id`).
4. Accept loop: each connection = a task that reads/writes JSON-RPC.

### state.json (atomic write)

```json
{
  "version": 1,
  "sessions": [
    {
      "session_id": "ab12cd34",
      "claude_session_id": "550e8400-e29b-...",
      "cwd": "/home/user/repo",
      "name": null,
      "permission_mode": "normal",
      "status": "sleeping"
    }
  ]
}
```

Rewritten after each creation/kill/sleep + after each initial SDK
`session_id`.

### Sessions

Each session has its own `ClaudeSDKClient` (reusing the code from
`bridge.py`, refactored into an `AgentSession` class).

- Persistence: just the SDK `claude_session_id` (enough for resume — the
  SDK keeps everything in `~/.claude/projects/...`).
- No message history in the agent (Charon stores it in DB).

### Handling multiple clients

Multiple simultaneous Charon connections possible (for resilience during a
restart: a new Charon connects, the old one dies, no down-time).
Per-connection subscriptions.

## Installation

### Detected prerequisites on the VPS

- **Ubuntu** ≥ 22.04: `python3` is ≥ 3.10. `apt install python3-pip
  python3-venv` if missing.
- **CentOS / Rocky / RHEL 9**: `python3` is 3.9 → `dnf install python3.11
  python3.11-pip`.
- **systemd** ≥ 230 (for `--user` mode). Almost always present. Fallback:
  `nohup setsid` + cron `@reboot`.

### Install flow (orchestrated on the Charon side)

1. **SSH check** (`charon → agent v2 bootstrap stream`):
   - Detects OS via `/etc/os-release`
   - Installs Python ≥ 3.10 if absent
   - `pip install --user claude-agent-sdk` (the SDK stays separate from
     the agent)
2. **Drop the agent**:
   - `scp` (or `ssh ... cat > ...`) `charon-agent.pyz` to
     `~/.charon/charon-agent.pyz`
   - `chmod +x`
3. **systemd-user service**:
   - Drop `~/.config/systemd/user/charon-agent.service` (template below)
   - `loginctl enable-linger <user>` (requires sudo OR the user is root)
   - `systemctl --user daemon-reload && systemctl --user enable --now charon-agent`
4. **Live socket check**:
   - Test: `charon-agent --connect <<< '{"id":1,"method":"ping"}'` → must
     return `{"id":1,"result":{"pong":true...}}`
5. **Claude setup**:
   - If `claude login` was never run, open the **setup console** in the
     UI: we run `ssh -tt host claude login`, the user copies the URL into
     their local browser, pastes the code → OAuth is stored.

### systemd-user unit

```
[Unit]
Description=Charon Agent
After=default.target

[Service]
ExecStart=%h/.charon/charon-agent.pyz
Restart=on-failure
RestartSec=2
StandardOutput=append:%h/.charon/agent.log
StandardError=append:%h/.charon/agent.log

[Install]
WantedBy=default.target
```

### Fallback (systemd-user unavailable)

`nohup setsid ~/.charon/charon-agent.pyz >> ~/.charon/agent.log 2>&1 &` +
cron `@reboot ~/.charon/charon-agent.pyz`.

## On the Charon side

### New lib/server/agent/

- `AgentClient.ts`: manages the long-running SSH connection to a VPS,
  line-delimited JSON-RPC parser, queue of in-flight requests, dispatches
  events to subscribers (per session_id).
- `AgentClientPool.ts`: `Map<vpsId, AgentClient>`, lazy-init.
- `types.ts`: TypeScript protocol mirror of `agent/charon_agent/protocol.py`.

### SSH auto-reconnect

When the SSH drops (network, agent restart, etc.): backoff 2s → 5min, DB
status stays `active`, live status `reconnecting`. On reconnect: `hello` →
reconcile the sessions list with the DB, re-subscribe to sessions that have
SSE clients in flight.

### DB migration

A drizzle migration adds two columns to `vps`:

```sql
ALTER TABLE vps ADD COLUMN agent_version TEXT;
ALTER TABLE vps ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'unknown'; -- unknown | ok | missing | error
```

And a data migration: all sessions `claudeSessions.status='active'` at boot
are switched to `sleeping` exactly once (the bridges from the old code are
dead for sure). The user can resume → that will try to connect to the
agent. If the agent is not installed: clear message "VPS not set up, run
the install".

### API routes refactor

Existing routes (`/api/claude/sessions/*`) keep their front-end shape.
Inside, `getWorker(id)` becomes `getAgentForSession(sessionId)` (resolved
via `claudeSessions.vpsId` → `AgentClientPool.get(vpsId)`), and the
`w.sendUserMessage(...)` etc. become `agent.sendInput(sessionId, ...)`.

The SSE stream reads events from `agent.subscribe(sessionId, sink)` instead
of `w.subscribe(sink)`.

## Backward compatibility

No compat with the old architecture: this is a one-shot rework. After the
migration boot, existing sessions are set to `sleeping` (an intermediate
status) — the user sees them again in the sidebar and can decide to kill
them or resume them. The resume will try to reach the agent. If the agent
is not yet installed on the VPS: explicit error + "Setup VPS" button.

## Security

- Unix socket `~/.charon/agent.sock` in chmod 600 → only the daemon's user
  can access it.
- The agent listens on no network port. Everything goes through SSH.
- No additional auth between Charon and the agent: possession of the SSH
  key is the authorization (existing model).
- The agent runs as the SSH user (typically root on these VPSes) — no new
  privilege escalation.

## Things not covered (out-of-scope)

- Agent auto-update: we redeploy it manually via the setup. Later: version
  check on `hello`, drop + restart if stale.
- Multi-user: we stay mono-user (one Charon = one user).
- Sharing the Claude Code OAuth across VPSes: no, each VPS runs its own
  `claude login` (cf. product discussion, too fragile otherwise).

## Risks

- **The agent crashes and `Restart=on-failure` isn't enough**: systemd
  retries. If the crashloop persists, the state.json stays but the
  sessions no longer run. Charon will display `reconnecting`
  indefinitely — the user will have to SSH in and read `agent.log`.
- **The `claude_session_id` became invalid on the SDK side** (purge of
  `~/.claude/projects/...`): the restore at agent boot emits an error, the
  session goes to `error`, the user kills it and creates a new one.
- **SDK version drift**: the agent does a check at startup (`import
  claude_agent_sdk`); if the import fails, exit code != 0 and systemd
  retries. The setup console lets you repair.
