# ADR-001 — One persistent `charon-agent` daemon per VPS

**Status:** accepted, evolved in place.

## Decision

Charon runs one long-lived Python daemon on every managed VPS. It owns all
provider sessions (Claude, Codex, Cursor), persistent terminal holders and
bounded workspace services (files, search, Git, LSP) for that VPS. The hub
reaches it through one multiplexed SSH connection speaking line-delimited
JSON-RPC; the daemon listens only on a local chmod-600 Unix socket and opens no
TCP port.

This replaced a design where every Claude session spawned its own SSH
connection and short-lived bridge process.

The protocol is **not** catalogued here. Authoritative sources:
[`agent/charon_agent/protocol.py`](../agent/charon_agent/protocol.py) (methods,
error codes) and its checked TypeScript mirror
[`lib/server/agent/types.ts`](../lib/server/agent/types.ts) (plus event shapes).
The build fails when the two method sets drift; the Python tests fail when a
method is not in exactly one dispatch group.

## Context

One session = one Node worker + one SSH process + one remote bridge had four
structural problems:

1. Restarting the hub killed every SSH child, hence every session, pending
   permission and in-flight turn.
2. N sessions on a VPS meant N SSH handshakes and N reconnect loops.
3. A browser reconnect could recover provider history, but not the exact events
   missed while disconnected.
4. Durable shells or shared file/Git services would each repeat that process
   and transport machinery.

The VPS is already Charon's trust and execution boundary; a resident daemon
preserves work across control-plane failures while reusing SSH authorization.

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
                                      │ N provider sessions  │
                                      │ files · Git · LSP    │
                                      │ detached PTY holders │
                                      └──────────────────────┘
```

**Hub.** One `AgentClient` per VPS, shared by every session and service on the
box. It execs `charon-agent.pyz --connect` over SSH, matches responses to
request ids, fans events to subscribers, reconnects with bounded backoff, then
reconciles daemon state with SQLite and re-subscribes from the last durable
event cursor. SQLite holds the product state (session metadata, handles, the
visible transcript, gates, attachments, tabs, settings); the browser has one
global SSE stream and never talks to a VPS.

**Agent.** A reproducible, stdlib-only zipapp; provider SDKs live in a separate
venv. The daemon owns one session object per live session (selected by a
provider registry), the gate and background-work state that must outlive a
browser, a durable event log plus a small replay ring per session, the
workspace services, the registry of terminal holders, and the local stdio MCP
`charon_peer`. Each client connection has one bounded FIFO output queue and a
single writer for events and responses: a slow client is disconnected on
overflow and recovers through durable replay, so it can neither grow the daemon
without bound nor interleave JSON lines.

**Terminal holders.** Each shell's PTY belongs to a detached holder with a
control socket, durable log and bounded offline spool. A shell therefore
survives a browser close, a hub restart and an agent update; the daemon
reattaches to the holders it finds on boot.

**Session runtimes.** Live sessions follow the same rule: their provider
objects (and so their CLIs) belong to a detached runtime process, one per
code generation (a frozen copy of the zipapp plus the provider SDK versions),
not to the daemon. The daemon keeps a proxy per session, owns the event log,
subscribers, peer ledger and state.json, and forwards per-session calls. A
runtime numbers what it sends and keeps it until the daemon acks it after
logging, so a daemon restart in the middle of a turn loses no event and logs
none twice; a restarted daemon re-adopts every runtime before restoring
anything. After an update the old runtime keeps its sessions running; each
one is moved to the current runtime when idle (stop, then resume — hidden
from the hub), and the drained runtime exits. Only when no runtime can start
does a session run inside the daemon, as before.

## Transport

```bash
ssh user@host -- ~/.charon/charon-agent.pyz --connect
```

`--connect` is a stdio ↔ Unix-socket proxy (no `socat`, no listening port) with
a distinct exit code when the socket is absent. Each JSON line is a request
`{"id","method","params"}`, a response `{"id","result"|"error"}` or an event
`{"event","session_id",…}`. Feature availability is discovered from declared
capabilities and `-32601`, never inferred from a version string, so rolling
fleets degrade explicitly.

## Persistence and recovery

Three stores, three jobs:

1. **Provider history** (`~/.claude`, `~/.codex`, Cursor's store): what the model
   resumes and what native fork/compact manipulate.
2. **Agent state** (`state.json`): which sessions to restore, with provider ids,
   configuration and lifecycle; tolerant on read, atomically replaced on write.
3. **Hub SQLite**: the provider-neutral transcript and UI state, readable while
   the VPS is offline.

Every event is appended to a per-session JSONL log with a monotonic `seq` before
it is broadcast. On reconnect the hub asks for events after its last committed
cursor; rotation or corrupt lines surface as an explicit replay gap, never silent
loss. `send_input` deduplicates by client message id, so a timeout can be
retried without sending the prompt twice. On boot the daemon restores active
sessions; the hub's reconciliation resumes any DB-active session it lacks.
Sleeping and archived sessions keep their native id without a live SDK client.

## Provider parity and collaboration

Providers translate their native streams into one durable event vocabulary and
one set of hub records. Common actions share routes and UI; genuine differences
stay explicit through declared capabilities (same-provider forks use native
history, cross-provider forks transfer a bounded transcript; rewind never
restores files; Codex review is native, Claude's is an adapted read-only fork;
provider-native grant scopes are preserved). Display names are mutable; stable
`@handles` are the routing identity.

Every session launches `charon_peer` as a local stdio MCP server whose
`list_sessions` / `send_message` tools call the owning daemon. The daemon
resolves an exact live handle on that VPS, applies self-delivery, size and rate
limits, delivers through the target's normal input path and records a durable
external message. No cross-VPS routing is implied.

## Installation and updates

The hub's streamed bootstrap: verify SSH and detect the distro → install Python
3.10+ and venv support → create/update `~/.charon/venv` with the provider SDKs →
install the CLIs (no Node/npm required on the VPS) → base64-pipe the committed
zipapp → install a systemd-user unit with `KillMode=process` (cron fallback on
old systems) → ping the socket and report login state.

Manual and automatic updates share one flow: update SDKs and the zipapp,
rewrite the unit, restart, ping. On an agent with session runtimes the restart
touches no session (only one still booting delays an automatic update); the
hub then moves each outdated session once it is idle — no turn, human gate,
background task or recent activity — and the session header says so until
then. Older agents keep the original flow: snapshot live sessions, restart,
resume, and automatic updates wait for a quiet VPS. `CHARON_INSTANCE` gives a second hub on the same VPS its own
state/socket/log home and unit; the venv and provider credentials stay shared.

## Security properties

- The daemon runs as the SSH user, opens no TCP port; its home is private and
  its socket 0600. Charon's SSH key is the authorization boundary — there is no
  weaker second credential.
- File, search, Git and LSP operations validate roots and arguments before
  touching disk or spawning processes; mutating writes carry stale guards.
- `charon_peer` routes only within one daemon, by exact handle, with size and
  per-source rate limits.
- Output queues, event payloads, imports and sub-agent reads are bounded, so a
  provider cannot turn one JSON line into unbounded memory or egress.

This does not sandbox a full-access coding agent from its VPS: the operator
picks the provider's permission/sandbox mode and must treat each VPS as trusted.

## Consequences

**Benefits:** hub and browser restarts — and agent updates — no longer end
sessions or shells; one SSH
connection per VPS; recovery has an exact cursor and explicit gaps; workspace,
Git, LSP, usage and peer messaging share one transport and lifecycle owner;
rolling upgrades are observable and capability-compatible.

**Costs:** the daemon is an important resident process with a broad (bounded)
protocol surface; provider SDK changes must be normalized without erasing real
differences; a runtime process per generation adds memory, and a runtime crash
interrupts its active turns (its sessions are restored in a new one);
peer routing is narrower than a fleet-wide bus; the committed zipapp must be
rebuilt reproducibly with every agent change.

## Rejected alternatives

- **One SSH/bridge per session:** couples work to the hub, multiplies
  connections, cannot own shared services.
- **An agent TCP service:** another network/auth/TLS surface on every VPS.
- **The hub as sole event buffer:** loses events produced while the hub is down.
- **The transcript only on the VPS:** offline browsing, search and cross-provider
  forks would depend on remote availability.
- **Hiding unsupported controls to make providers look identical:** silent
  failure; Charon shares safe semantics and labels real differences instead.

## Out of scope

Charon stays single-user and self-hosted. It does not provision VPSes, share
provider credentials across hosts, or turn the SSH key into multi-tenant
authorization.
