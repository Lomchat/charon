# charon-agent

Python daemon (stdlib-only) that runs on each VPS and hosts N coding-agent
sessions — **Claude** (`claude-agent-sdk`) and **Codex** (`openai-codex`) —
plus persistent PTY shells. Charon (the Next.js hub) drives it over **one
multiplexed SSH per VPS**, speaking line-delimited JSON-RPC to the daemon's
Unix socket `~/.charon/agent.sock`.

Current `__version__`: **0.68.0** (`charon_agent/__init__.py`).

The **protocol spec is [`charon_agent/protocol.py`](charon_agent/protocol.py)**
(error codes + the canonical `METHODS` set). Its TypeScript mirror is
[`lib/server/agent/types.ts`](../lib/server/agent/types.ts);
[`scripts/check-protocol-sync.mjs`](../scripts/check-protocol-sync.mjs) fails
the hub build if the two drift. See
[`docs/adr-001-charon-agent.md`](../docs/adr-001-charon-agent.md) for the
architectural **motivation and current consequences** (not a protocol catalog).

## Layout

```
charon_agent/__main__.py      CLI: daemon | --connect | --shell-holder (internal)
charon_agent/server.py        asyncio Unix server, JSON-RPC dispatch, per-session
                              ring (RING_SIZE=2000), subscribers, send queue
charon_agent/session.py       Claude session: wraps ClaudeSDKClient, hooks,
                              can_use_tool, permission/question futures
charon_agent/codex_session.py Codex session: same event vocabulary, per-turn
                              model/effort/sandbox, approvals and global signals
charon_agent/codex_login.py   headless ChatGPT device-code sign-in
charon_agent/peer_mcp.py      local stdio MCP: list/message live @handles through
                              the daemon socket, shared by Claude and Codex
charon_agent/shell.py         client of the detached PTY holder (spawn/attach,
                              input/resize/kill, busy/idle heuristics)
charon_agent/holder.py        the DETACHED process owning PTY + bash — shells
                              survive agent restarts; spools output while detached
charon_agent/event_log.py     durable per-session JSONL log, monotonic seq,
                              rotation → gap-free replay via subscribe(after_seq)
charon_agent/state.py         tolerant load / atomic save of state.json
charon_agent/usage.py         account usage (GET /api/oauth/usage)
charon_agent/fsnav.py         bounded remote tree/read/write/search operations
charon_agent/git.py           bounded source-control/workspace/history operations
charon_agent/lsp.py           remote language-server lifecycle and requests
charon_agent/protocol.py      error codes + canonical METHODS  ← the spec
charon_agent/client.py        --connect mode (stdio ↔ socket proxy)
build.sh                      → dist/charon-agent.pyz
```

Runtime files (all under `$CHARON_AGENT_HOME`, default `~/.charon`):
`charon-agent.pyz`, `agent.sock` (chmod 600), `state.json`, `agent.log`,
`events/<sid>.jsonl(.N)`, `shells/<id>.{jsonl,sock,spool}`, `venv/`.

A named hub instance uses `~/.charon-<instance>` for its socket, state, logs and
systemd unit. The SDK venv and upstream `~/.claude` / `~/.codex` account stores
remain shared host-wide.

Besides the common session lifecycle, the protocol carries durable transcript
replay, permissions and questions, same- and cross-provider collaboration,
fork/rewind/compact/review controls, context and turn usage, MCP/resources/
sub-agent inspection, background process control, account login, persistent
shells, filesystem/search, Git and LSP operations. Do not duplicate that method
catalog here: `protocol.py` and its checked TypeScript mirror are authoritative.

## Build

```bash
bash agent/build.sh          # → agent/dist/charon-agent.pyz
```

A **reproducible** zipapp: sorted entries, fixed timestamps/permissions, no
`__pycache__` — same source ⇒ byte-identical output. `dist/charon-agent.pyz`
is **committed to git** and CI runs `git diff --exit-code` on it, so any
change under `charon_agent/` must be rebuilt and committed in the same commit.
The sha also drives the fleet auto-update (hub-side `getBuiltPyzSha()` vs
`vps.agentPyzSha`).

## Run / debug

```bash
python3 -m charon_agent                  # daemon (from a source checkout)
./agent/dist/charon-agent.pyz            # daemon (packaged)
./agent/dist/charon-agent.pyz --connect  # stdio ↔ socket proxy (what the hub execs)

echo '{"id":1,"method":"ping"}' | ./agent/dist/charon-agent.pyz --connect
ssh root@<ip> systemctl --user status charon-agent
ssh root@<ip> tail -f .charon/agent.log
```

`--connect` exit codes: `0` clean · `2` socket absent (daemon down) · `3`
connect failed.

## Environment variables

| Var | Default | Role |
|---|---|---|
| `CHARON_AGENT_HOME` | `~/.charon` | state directory (handy for tests) |
| `CHARON_CODEX_BIN` | auto-detected | override the standalone Codex CLI binary |
| `CHARON_EVLOG_MAX_BYTES` | `10485760` | event-log rotation threshold |
| `CHARON_EVLOG_ROTATIONS` | `3` | rotated event-log files kept |

## Tests

```bash
npm run test:py              # from the repo root — stdlib unittest, agent/tests/
```

CI runs them on Python 3.10 and 3.13 (the supported range).

## Prerequisites on the VPS

- Python ≥ 3.10.
- A dedicated **venv at `~/.charon/venv`** holding `claude-agent-sdk` and
  `openai-codex`, plus the independently updated native npm artifact under
  `~/.charon/venv/codex-cli` — never `pip install --user` (PEP 668). The agent
  passes that binary through `CodexConfig.codex_bin`; `CHARON_CODEX_BIN` can
  override it, and the bundled SDK binary remains the fallback. The systemd unit's
  `ExecStart` runs the pyz with `~/.charon/venv/bin/python`, falling back to
  the best system python. Created and kept fresh by the hub
  (`lib/server/claude/bootstrap.ts`, `VENV_DIR`).
- `claude login` / `codex login` done once per VPS (both can be driven from
  the hub UI).
- systemd ≥ 230 for `--user` mode (otherwise a `nohup setsid` + cron fallback).
