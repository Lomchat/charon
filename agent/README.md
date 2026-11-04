# charon-agent

Stdlib-only Python daemon that runs on each VPS and hosts N coding-agent
sessions — **Claude** (`claude-agent-sdk`), **Codex** (`openai-codex`) and
**Cursor** (`cursor-sdk`) — plus persistent PTY shells and bounded file, Git and
LSP services. The hub drives it over **one multiplexed SSH per VPS**, speaking
line-delimited JSON-RPC to the Unix socket `~/.charon/agent.sock`.

Version: `__version__` in [`charon_agent/__init__.py`](charon_agent/__init__.py).
Protocol spec: [`charon_agent/protocol.py`](charon_agent/protocol.py) (error
codes + canonical `METHODS`), mirrored by
[`lib/server/agent/types.ts`](../lib/server/agent/types.ts);
[`scripts/check-protocol-sync.mjs`](../scripts/check-protocol-sync.mjs) fails the
hub build on drift. Motivation: [ADR-001](../docs/adr-001-charon-agent.md).

## Layout

```
__main__.py        CLI: daemon | --connect | --stream-file/zip | --receive-file | --shell-holder
server.py          asyncio Unix server, JSON-RPC dispatch, replay ring, per-client send queue
protocol.py        error codes + METHODS  ← the spec
providers.py       backend registry: kind → session class, config kwarg, availability
session.py         Claude session (ClaudeSDKClient, hooks, can_use_tool)
codex_session.py   Codex session (app-server; codex_compat.py, codex_login.py)
cursor_session.py  Cursor session (cursor_runtime/_login/_catalog.py)
account_profiles.py  per-provider login profiles (isolated config dirs)
peer_mcp.py        local stdio MCP `charon_peer`: list/message live @handles
shell.py           client of the detached PTY holder; shell_activity.py = idle detection
holder.py          detached process owning PTY + bash; survives agent restarts
event_log.py       durable per-session JSONL log, monotonic seq, rotation → explicit gaps
state.py           tolerant load / atomic save of state.json
child_ledger.py    reaps provider CLIs orphaned by a killed daemon
fsnav.py · filetools.py · git.py · lsp.py   workspace: tree/read/write/search, viewers, Git, LSP
usage.py           account usage polling
custom_endpoints.py · endpoint_*.py         custom model endpoints (probe, relay, credentials, usage)
client.py          --connect (stdio ↔ socket proxy)
```

Runtime files under `$CHARON_AGENT_HOME` (default `~/.charon`):
`charon-agent.pyz`, `agent.sock` (0600), `state.json`, `agent.log`,
`events/<sid>.jsonl`, `shells/<id>.{jsonl,sock,spool}`, `accounts/`, `venv/`.
A named hub instance uses `~/.charon-<instance>`; the venv and default provider
credentials stay shared host-wide.

## Build

```bash
bash agent/build.sh          # → agent/dist/charon-agent.pyz
```

Reproducible zipapp (sorted entries, fixed timestamps, no `__pycache__`).
`dist/charon-agent.pyz` is **committed** and CI diffs it: any change under
`charon_agent/` bumps `__version__` and ships the rebuilt pyz in the same commit.
The version drives the hub's update prompt.

## Run / debug

```bash
python3 -m charon_agent                  # daemon (source checkout)
./agent/dist/charon-agent.pyz            # daemon (packaged)
echo '{"id":1,"method":"ping"}' | ./agent/dist/charon-agent.pyz --connect
ssh <host> systemctl --user status charon-agent
ssh <host> tail -f .charon/agent.log
```

`--connect` exits `0` clean · `2` socket absent (daemon down) · `3` connect
failed. The daemon itself exits `4` when a live daemon already owns the socket.

## Environment variables

| Var | Default | Role |
|---|---|---|
| `CHARON_AGENT_HOME` | `~/.charon` | state directory |
| `CHARON_CODEX_BIN` | auto-detected | override the Codex CLI binary |
| `CHARON_EVLOG_MAX_BYTES` / `CHARON_EVLOG_ROTATIONS` | `10485760` / `3` | event-log rotation |
| `CHARON_LOG_MAX_BYTES` / `CHARON_LOG_ROTATE_CHECK_S` | `8388608` / `300` | `agent.log` rotation |
| `CHARON_CODEX_START_CONCURRENCY` / `CHARON_CODEX_START_ATTEMPTS` | `2` / `3` | Codex app-server startup |

## Tests

`npm run test:py` from the repo root (stdlib `unittest`, `agent/tests/`); CI runs
Python 3.10 and 3.13.

## VPS prerequisites

- Python ≥ 3.10; systemd ≥ 230 for `--user` mode (else `nohup setsid` + cron).
- A venv at `~/.charon/venv` with the provider SDKs (never `pip install --user`,
  PEP 668), Pillow for image compression, and the Codex native CLI under
  `venv/codex-cli`. The hub creates and updates it (`lib/server/hub/bootstrap.ts`).
- One sign-in per provider and VPS, driven from the hub UI.
