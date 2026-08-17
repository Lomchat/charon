# ADR-001 — One persistent `charon-agent` daemon per VPS

- **Status:** accepted, evolved in place
- **Original decision:** 2026-05-18
- **Last reviewed against the implementation:** 2026-08-17

## Decision summary

Charon runs one long-lived Python daemon on every managed VPS. That daemon owns
all Claude and Codex sessions, persistent terminal holders and bounded remote
workspace services for that VPS. The hub reaches it through one multiplexed SSH
connection and a line-delimited JSON-RPC protocol; the daemon listens only on a
local chmod-600 Unix socket and opens no TCP port.

This replaces the original design in which every Claude session spawned its own
SSH connection and short-lived `bridge.py` process. The central decision still
holds even though its scope has grown from Claude chat to two providers, files,
Git, LSP, shells and local MCP collaboration.

The protocol itself is intentionally **not duplicated in this ADR**. Its
authoritative sources are:

- [`agent/charon_agent/protocol.py`](../agent/charon_agent/protocol.py) for
  method names and error codes;
- [`lib/server/agent/types.ts`](../lib/server/agent/types.ts) for the checked
  TypeScript mirror and event shapes;
- [`agent/README.md`](../agent/README.md) for the runnable package layout.

The build fails when the Python and TypeScript method sets drift, and the Python
tests fail when a declared method is not present in exactly one dispatch group.

## Context

In the pre-agent architecture, one running session meant one Node worker, one
SSH process and one remote Python bridge. That had four structural problems:

1. Restarting the Charon hub killed every SSH child and therefore every active
   session, including pending permissions and in-flight work.
2. N sessions on one VPS required N SSH handshakes and independent reconnect
   loops.
3. A browser reconnect could recover upstream transcript history, but not the
   exact stream of events Charon missed while disconnected.
4. Adding durable shells or shared filesystem/Git services would have repeated
   the same process and transport machinery for every feature.

The managed VPS is already Charon's trust and execution boundary. A small
resident daemon can preserve work across control-plane failures while reusing
the existing SSH authorization model.

## Architecture

```
┌──────────────┐   HTTPS / SSE / WS   ┌──────────────────────┐
│ Browser      │ ◄──────────────────► │ Charon hub           │
│ sessions     │                      │ Next.js + SQLite     │
│ files / Git  │                      │ AgentClientPool      │
│ terminals    │                      └──────────┬───────────┘
└──────────────┘                                 │ one SSH / VPS
                                                 │ JSON lines over stdio
                                      ┌──────────▼───────────┐
                                      │ charon-agent         │
                                      │ Unix socket (0600)   │
                                      │ N Claude/Codex       │
                                      │ files · Git · LSP    │
                                      │ detached PTY holders │
                                      └──────────────────────┘
```

### Hub

The Next.js process keeps one `AgentClient` per VPS. `AgentClientPool` reuses
that connection for every session and remote service on the box. The client:

- starts `charon-agent.pyz --connect` through SSH;
- matches JSON-RPC responses to request ids;
- fans unsolicited events to per-session subscribers;
- uses a bounded reconnect backoff;
- reconciles daemon state with SQLite after every reconnect; and
- re-subscribes from the last durable event cursor.

SQLite is the hub's product database: session metadata, provider-neutral
handles, the visible transcript, permissions/questions, attachments, workspace
tabs, notification settings and audit information live there. The browser gets
one global SSE stream; it does not connect directly to a VPS.

### Agent

`charon-agent` is a reproducible, standard-library-only Python zipapp. Provider
SDKs are external runtime dependencies in a dedicated venv; they are not
embedded in the zipapp.

The daemon owns:

- one `AgentSession` per live Claude session;
- one `CodexAgentSession` and local Codex app-server per live Codex session;
- permission, question and background-work state that must survive browser
  disconnects;
- a durable event log and a smaller in-memory replay ring per session;
- filesystem, project search, Git and bounded LSP services;
- the registry of detached terminal-holder processes; and
- a local stdio MCP process, `charon_peer`, for provider-neutral session
  addressing.

Every client connection has one bounded FIFO output queue and one writer for
both events and RPC responses. A slow client is disconnected on overflow and
recovers through durable replay; it cannot grow the daemon without bound or
interleave JSON lines.

### Persistent terminal holders

The daemon coordinates terminals but does not own their PTY process directly.
Each shell has a detached holder with a control socket, durable log and bounded
offline spool. Consequently a shell survives a browser close, hub restart and
agent update. When the daemon returns it reattaches to the holders it finds.

## Transport and protocol

The hub runs the instance-specific equivalent of:

```bash
ssh user@host -- ~/.charon/charon-agent.pyz --connect
```

`--connect` is a bidirectional stdio ↔ Unix-socket proxy. It needs no `socat`,
opens no listening network port and exits with a distinct code when the daemon
socket is absent.

Each newline-delimited JSON object is one of:

```jsonc
{"id": 1, "method": "send_input", "params": {}}
{"id": 1, "result": {"ok": true}}
{"id": 1, "error": {"code": -32602, "message": "invalid params"}}
{"event": "assistant_text", "session_id": "…", "delta": "…"}
```

One protocol carries session lifecycle and streaming, permissions, provider
login/usage, fork/rewind/compact/review, MCP/resources/sub-agents, background
work, shells, files/search, Git and LSP. Feature availability is discovered
from capabilities and `-32601`, not inferred from a package-version string, so
rolling fleets degrade explicitly.

## Persistence and recovery

Three stores have deliberately different jobs:

1. **Upstream provider history** (`~/.claude` / `~/.codex`) is what the model
   resumes and what native fork/compact operations manipulate.
2. **Agent state** (`state.json`) records the sessions the daemon should restore,
   their provider ids, configuration and lifecycle state. It is tolerant on
   read and atomically replaced on write.
3. **Charon SQLite** is the user-visible, provider-neutral transcript and UI
   state. It remains readable even when the VPS is offline.

Before an event is broadcast, the agent appends it to a per-session JSONL log
with a monotonic `seq` and timestamp. On reconnect the hub asks for events after
its last committed cursor. Rotation or corrupt lines produce an explicit replay
gap instead of silent loss. The in-memory ring is only a fast path.

`send_input` accepts a client message id and remembers a bounded set of accepted
ids. The hub can therefore retry a response-lost timeout without sending the
human prompt twice.

Session restore is best effort: the daemon reloads active sessions from state,
and the hub's reconnect reconciliation can resume a DB-active session missing
from the daemon. Sleeping and archived sessions retain their native id but do
not consume a live SDK client.

## Provider parity and collaboration

Claude and Codex translate their native streams into one durable event
vocabulary and one set of hub records. Common product actions share routes and
UI, while provider-specific capabilities remain explicit:

- same-provider forks use native history; cross-provider forks transfer a
  bounded provider-neutral transcript;
- rewind branches history at a selected visible user turn and never restores
  files;
- Codex review is native; Claude review is an adapted read-only fork/prompt;
- permissions share cards, but provider-native grant scopes and reviewers are
  preserved; and
- display names remain mutable while stable `@handles` are durable routing
  identities.

Both providers launch `charon_peer` as a local stdio MCP server. Its
`list_sessions` and `send_message` tools call the owning daemon through the
Unix socket. The daemon resolves an exact live handle on that VPS, applies
self-delivery, size and rate limits, sends through the target's normal input
path and emits a durable external-message record. No cross-VPS router is
implied by this decision.

## Installation and updates

The hub's streamed bootstrap performs these phases:

1. verify SSH and detect the Linux distribution;
2. install Python 3.10+ and venv support when necessary;
3. create/update the shared `~/.charon/venv` with the Claude and Codex Python
   SDKs;
4. install/update the standalone Codex CLI artifact without requiring Node/npm
   on the VPS, and install the Claude CLI where supported;
5. base64-pipe the committed `charon-agent.pyz` to the instance home;
6. install and start a systemd-user unit with `KillMode=process`; or use a
   detached-process plus cron fallback on old systems;
7. ping the live socket and report provider login state.

The service runs the zipapp with the venv Python when available. Manual and
automatic updates share one flow: snapshot live sessions, update SDKs and the
committed zipapp, rewrite the service invariant, restart, ping and resume.
Automatic updates wait until the VPS is quiet.

The default instance uses `~/.charon` and `charon-agent.service`. When two hubs
share a VPS, `CHARON_INSTANCE` selects separate state/socket/log homes and unit
names. The SDK venv and upstream provider account/history directories remain
host-wide and shared intentionally.

## Security properties

- The daemon runs as the SSH user and opens no TCP port.
- Its home is private and its Unix socket is mode 0600.
- Possession of Charon's SSH key is the authorization boundary; there is no
  weaker second credential on the local protocol.
- File, search, Git and LSP operations validate roots and arguments before
  spawning processes or touching disk. Mutating file operations use explicit
  stale/snapshot guards where applicable.
- `charon_peer` routes only within the daemon that owns source and target, with
  exact handles, message-size limits and per-source rate limiting.
- Client output queues, event payloads, transcript imports and sub-agent reads
  are bounded so a provider cannot turn one JSON line into unbounded memory or
  egress.

This does not sandbox a full-access coding agent from its VPS. The operator
chooses the provider permission/sandbox mode and must treat each managed VPS as
trusted infrastructure.

## Consequences

### Benefits

- Hub and browser restarts no longer terminate sessions or shells.
- One SSH connection replaces N per-session connections.
- Recovery has an exact cursor and explicit gaps.
- Shared VPS services — workspace, Git, LSP, usage and peer MCP — reuse one
  transport and one lifecycle owner.
- Rolling agent upgrades are observable and capability-compatible.

### Costs and trade-offs

- The daemon is now an important resident process with a broad, carefully
  bounded protocol surface.
- Provider SDK changes must be normalized without erasing real differences.
- A daemon crash interrupts active turns, although state and provider history
  normally make sessions resumable.
- Same-VPS peer routing is deliberately narrower than a fleet-wide message bus.
- The committed zipapp must be rebuilt reproducibly with every agent source
  change.

## Rejected alternatives

- **One SSH/bridge per session:** simple locally, but couples work to the hub,
  multiplies connections and cannot own shared services.
- **Expose an agent TCP service:** removes the SSH proxy but creates another
  network/auth/TLS surface on every VPS.
- **Use the hub as the sole event buffer:** cannot recover events produced while
  the hub itself is down.
- **Store the only transcript on the VPS:** makes offline browsing, search and
  provider-neutral cross-forks dependent on remote availability.
- **Make providers look identical by hiding unsupported controls:** produces
  silent failure. Charon instead shares safe semantics and labels genuine
  provider differences.

## Scope not changed by this ADR

Charon remains single-user and self-hosted. It does not provision VPSes, share
Claude/Codex credentials across hosts, or turn the SSH key into a multi-tenant
authorization system.
