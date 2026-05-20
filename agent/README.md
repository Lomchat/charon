# charon-agent

Python daemon that runs on each VPS and manages Claude sessions.
Charon (the Next.js hub) talks to it via a multiplexed SSH connection in JSON-RPC.

See [`docs/adr-001-charon-agent.md`](../docs/adr-001-charon-agent.md) for
the motivation and the full protocol.

## Build

```bash
bash agent/build.sh
# → agent/dist/charon-agent.pyz
```

The script uses `python3 -m zipapp` (stdlib, zero external dependency).
The resulting pyz is a few tens of KB in size.

## Run (locally for testing)

```bash
# Daemon
python3 -m charon_agent
# OR
./agent/dist/charon-agent.pyz

# Client (stdio ↔ socket proxy)
./agent/dist/charon-agent.pyz --connect

# Ping
echo '{"id":1,"method":"ping"}' | ./agent/dist/charon-agent.pyz --connect
```

## Layout

- `charon_agent/__main__.py` : CLI (daemon mode | --connect mode)
- `charon_agent/server.py`   : asyncio Unix socket server + JSON-RPC dispatch
- `charon_agent/session.py`  : 1 instance = 1 ClaudeSDKClient + hooks
- `charon_agent/state.py`    : persistence ~/.charon/state.json
- `charon_agent/protocol.py` : error codes + serialization helpers
- `charon_agent/client.py`   : `--connect` mode (bidirectional proxy)
- `build.sh`                 : produces `dist/charon-agent.pyz`

## Environment variables

- `CHARON_AGENT_HOME` : overrides `~/.charon` (useful for tests)

## Prerequisites on the VPS

- Python ≥ 3.10
- `claude-agent-sdk` installed (`pip install --user claude-agent-sdk`)
- `claude login` done (OAuth Claude Code)
- systemd ≥ 230 for `--user` mode (otherwise fallback to `nohup setsid`)
