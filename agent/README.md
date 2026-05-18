# charon-agent

Daemon Python qui tourne sur chaque VPS et gère les sessions Claude.
Charon (le hub Next.js) y parle via une connexion SSH multiplexée en JSON-RPC.

Voir [`docs/adr-001-charon-agent.md`](../docs/adr-001-charon-agent.md) pour
la motivation et le protocole complet.

## Build

```bash
bash agent/build.sh
# → agent/dist/charon-agent.pyz
```

Le script utilise `python3 -m zipapp` (stdlib, zéro dépendance externe).
Le pyz attendu fait quelques dizaines de KB.

## Run (en local pour test)

```bash
# Daemon
python3 -m charon_agent
# OU
./agent/dist/charon-agent.pyz

# Client (proxy stdio ↔ socket)
./agent/dist/charon-agent.pyz --connect

# Ping
echo '{"id":1,"method":"ping"}' | ./agent/dist/charon-agent.pyz --connect
```

## Lay-out

- `charon_agent/__main__.py` : CLI (mode daemon | mode --connect)
- `charon_agent/server.py`   : asyncio Unix socket server + dispatch JSON-RPC
- `charon_agent/session.py`  : 1 instance = 1 ClaudeSDKClient + hooks
- `charon_agent/state.py`    : persistance ~/.charon/state.json
- `charon_agent/protocol.py` : codes d'erreur + helpers de sérialisation
- `charon_agent/client.py`   : mode `--connect` (proxy bidirectionnel)
- `build.sh`                 : produit `dist/charon-agent.pyz`

## Variables d'environnement

- `CHARON_AGENT_HOME` : remplace `~/.charon` (utile pour les tests)

## Prérequis sur le VPS

- Python ≥ 3.10
- `claude-agent-sdk` installé (`pip install --user claude-agent-sdk`)
- `claude login` fait (OAuth Claude Code)
- systemd ≥ 230 pour le mode `--user` (sinon fallback `nohup setsid`)
