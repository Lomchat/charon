# ADR-001 — charon-agent: a per-VPS daemon for persistent sessions

**Status**: accepted · partly superseded (historical record of the 2026-05
design) · **Date**: 2026-05-18

> **Historical note**: this ADR documents the migration **from** the old
> pre-v2 architecture (a `bridge.py` process as a child of one SSH per
> session) **to** the `charon-agent` daemon per VPS that multiplexes N
> sessions. It reflects the design **as of 2026-05**; the code has moved on
> — see "What changed since" below for the deltas, and read the code for the
> present state. The "Context" section describes the old architecture, kept
> to explain the *why*. A deployer starting on a fresh DB has nothing to do
> — the `migrationV2IfNeeded()` is a no-op on a fresh base.
>
> The **core decision still holds**: one Python daemon per VPS, one
> multiplexed SSH, a `--connect` stdio↔socket proxy, `state.json` for
> restore-on-boot, a chmod-600 Unix socket and the SSH key as the only
> authorization. Everything below is annotated where it drifted; nothing has
> been rewritten to pretend it was always so.

## What changed since (as of 2026-07)

- **`claude login` no longer uses a mini-terminal.** The SSE-stdout +
  POST-stdin console was removed; sign-in is the **hosted OAuth-code flow**
  with no PTY (`lib/server/agent/loginSession.ts`,
  `app/ClaudeLoginModal.tsx`). Codex has its own device-code flow
  (`agent/charon_agent/codex_login.py`).
- **The agent is no longer Claude-only.** A session has a `kind`
  (`claude` | `codex`); `codex_session.py` mirrors `session.py`'s contract.
  Both SDKs live in a dedicated venv `~/.charon/venv`.
- **Persistent PTY shells** were added (`shell.py` + the detached
  `holder.py`), unknown to this ADR.
- **The method set grew from 13 to ~34** (usage, Codex, shells, `list_dir`,
  `resume_session`/`force_stop`, `set_model`/`set_effort`, …). The tables
  that used to live here are gone — see the pointer under "JSON-RPC
  protocol".
- **The ring buffer is no longer the recovery mechanism**: a durable
  append-only event log (`event_log.py`, monotonic `seq` + rotation) is, and
  `subscribe` prefers `after_seq` over `replay`.
- **Agent auto-update shipped** — it was listed as out-of-scope here.
- `bridge.py` and its `BridgeEvent` type no longer exist anywhere.

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
  zipapp, ~68 KB today) + a systemd-user unit. No `pip install` on the agent
  side (the SDKs are installed separately, in `~/.charon/venv`; the pyz is
  just a blob we `scp`).
- ~~**`claude login` is still manual** but made easier by a mini-terminal in
  the UI (SSE for stdout + POST for stdin).~~ **Superseded**: the
  mini-terminal was removed. `claude login` is driven from the UI through the
  **hosted OAuth-code flow** (no PTY): the hub runs `claude auth login` over
  the SSH pipe, shows the URL, the user pastes the code back
  (`lib/server/agent/loginSession.ts`, `app/ClaudeLoginModal.tsx`). Codex
  signs in via a device code (`codex_login.py`). Still per-VPS.

## JSON-RPC protocol (line-delimited JSON)

### Transport

Charon opens a long-running SSH per VPS:

```
ssh user@host -- ~/.charon/charon-agent.pyz --connect
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

### Methods and events

> **Superseded — no third copy is kept in sync.** This ADR originally listed
> 13 methods and ~15 events. The **canonical** lists now live in:
>
> - `agent/charon_agent/protocol.py` § `METHODS` (~34 methods) + the error
>   codes — the spec;
> - `lib/server/agent/types.ts` — its TypeScript mirror (`AgentMethodName`,
>   `AgentEvent`), kept identical by `scripts/check-protocol-sync.mjs`, which
>   fails the hub build on drift.
>
> What grew since 2026-05: account usage (`get_usage`), the Codex backend
> (`list_codex_models`, `get_codex_usage`, `codex_login_*`), persistent
> shells (`shell_*`, incl. the global output-free `shell_watch`), `list_dir`,
> `resume_session` / `force_stop`, and `set_model` / `set_effort`. Events
> gained `model_changed` / `effort_changed` / `effective_model`, `bg_task`,
> `usage`, `interrupted`, `replay_begin` / `replay_end`, `shell_*` — and all
> durable ones now carry `seq` + `ts`.

### Ring buffer → durable event log

> **Superseded.** The design below (an in-memory ring, `N=300`, sent first on
> `subscribe`) shipped, but it is **no longer what recovery relies on**: the
> ring (now `RING_SIZE=2000` in `server.py`) is only a fast path. The source
> of truth is the **durable append-only event log**
> (`agent/charon_agent/event_log.py`): one JSONL file per session under
> `~/.charon/events/`, a monotonic `seq` written **before** the ring and the
> broadcast, rotation at 10 MB × 3. `subscribe` therefore takes `after_seq`
> and replays exactly what the hub missed **across rotations and agent
> restarts**; the `replay` param below survives only as backward
> compatibility for hub clients older than agent 0.4.0. The subscribe result
> also reports `earliest_seq`/`gap`, from which the hub synthesizes a
> `replay_gap`.

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

- ~~Agent auto-update: we redeploy it manually via the setup. Later: version
  check on `hello`, drop + restart if stale.~~ **Shipped** — exactly as the
  "later" sketched it: `hello` returns `agent_version` + `agent_pyz_sha`,
  compared against the committed `agent/dist/charon-agent.pyz`; a manual
  update runs through `app/api/vps/[id]/agent/update/route.ts`, and a
  fleet-wide auto-update tick redeploys stale VPSes on its own (gated on the
  VPS being quiet).
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
