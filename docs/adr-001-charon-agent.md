# ADR-001 — charon-agent : daemon par VPS pour sessions persistantes

**Statut** : adopté · **Date** : 2026-05-18

## Contexte

Aujourd'hui une session Claude = un process `bridge.py` enfant d'une `ssh` lancée par le `SessionWorker` Node.js de Charon. Conséquences :

1. **Couplage à la vie du process Charon** : restart Charon → toutes les SSH meurent → tous les bridges meurent → tous les `ClaudeSDKClient` distants meurent. Le resume marche (le SDK relit son historique disque) mais on perd les permissions en cours et tout interrupt en vol.
2. **N sessions = N connexions SSH** par VPS, ce qui multiplie les handshakes et complique le ratelimit / le monitoring.
3. **Installation lourde** : chaque VPS doit avoir `python3.10+`, `claude-agent-sdk`, et un `claude login`. Le `bridge.py` est redéployé en base64 à chaque session.

## Décision

Sur chaque VPS, un seul **daemon** (`charon-agent`) gère **N sessions Claude** en interne (chaque session = une coroutine asyncio avec son `ClaudeSDKClient`). Charon (le hub Next.js) ne crée plus de child SSH par session : il maintient **une seule connexion SSH par VPS**, multiplexée en JSON-RPC, vers le socket Unix `~/.charon/agent.sock` du daemon.

```
┌───────────────┐    HTTPS/SSE     ┌───────────────────────┐    SSH (1 par VPS)     ┌──────────────────────┐
│  Navigateur   │ ◄───────────────►│  Charon (Next.js)     │ ◄────────────────────► │  charon-agent (VPS)  │
│  ClaudePanel  │   SSE par session│  - AgentClientPool    │  exec: agent --connect │  - asyncio Unix sock │
└───────────────┘                  │  - 1 SSH/VPS multi-   │  → proxy stdio↔socket  │  - N sessions        │
                                   │    plexée JSON-RPC    │                        │  - state.json        │
                                   └───────────────────────┘                        │  - persiste resumes  │
                                                                                    └──────────────────────┘
```

### Propriétés clés

- **Sessions indépendantes de Charon**. Restart Charon ne tue plus aucune session — l'agent continue à tourner, et la prochaine connexion de Charon re-subscribe.
- **Sessions indépendantes de l'agent aussi** (autant que possible) : l'agent écrit `~/.charon/state.json` après chaque change ; au boot du daemon, il restore toutes les sessions connues en mode `resume` (via leur `claude_session_id` SDK persisté).
- **Une seule SSH par VPS** : multiplexée, auto-reconnect avec backoff côté Charon. La session DB côté Charon reste `active` pendant les reconnects (UI affiche `reconnecting`).
- **Install ultra-light** : un seul fichier `charon-agent.pyz` (zipapp Python stdlib, ~50KB) + un unit systemd-user. Pas de `pip install` côté agent (le SDK est installé séparément ; lui c'est un blob qu'on `scp`).
- **`claude login` reste manuel** mais facilité par un mini-terminal dans l'UI (SSE pour stdout + POST pour stdin).

## Protocole JSON-RPC (line-delimited JSON)

### Transport

Charon ouvre une SSH long-running par VPS :

```
ssh user@host -- /opt/charon/charon-agent.pyz --connect
```

Le binaire en mode `--connect` ouvre `~/.charon/agent.sock` et fait un proxy bidirectionnel stdin ↔ socket. Si le socket est absent, il sort code 2 (Charon le détecte → propose un setup à l'utilisateur).

Pas de `socat` / `nc` requis : tout est dans le `.pyz`.

### Format

Chaque ligne (séparée par `\n`) est un objet JSON. Trois variantes :

- **Request** (Charon → Agent) : `{"id": <int>, "method": "<str>", "params": {...}}`
- **Response** (Agent → Charon) : `{"id": <int>, "result": {...}}` ou `{"id": <int>, "error": {"code": <int>, "message": "<str>"}}`
- **Event** (Agent → Charon, non sollicité) : `{"event": "<str>", "session_id": "<id>", ...}`

Les `id` sont alloués par Charon (entiers croissants, scoped à la connexion).

### Méthodes (Charon → Agent)

| Méthode | Params | Result |
|---|---|---|
| `hello` | `{client: "charon", version}` | `{agent_version, sdk_version, sessions: [SessionInfo]}` |
| `list_sessions` | `{}` | `[SessionInfo]` |
| `start_session` | `{session_id, cwd, name?, permission_mode?, claude_session_id?}` | `{session_id}` |
| `subscribe` | `{session_id, replay?: int}` | `{ok: true, replay_count}` — l'agent push ensuite les events bufferisés (jusqu'à `replay` derniers) puis live |
| `unsubscribe` | `{session_id}` | `{ok: true}` |
| `send_input` | `{session_id, content}` | `{ok: true}` |
| `interrupt` | `{session_id}` | `{ok: true}` |
| `set_permission_mode` | `{session_id, mode}` | `{ok: true}` |
| `respond_permission` | `{session_id, perm_id, allow, always?}` | `{ok: true}` |
| `respond_question` | `{session_id, q_id, answers}` | `{ok: true}` |
| `respond_exit_plan` | `{session_id, q_id, decision, feedback?}` | `{ok: true}` |
| `sleep_session` | `{session_id}` | `{ok: true}` — arrête la session, garde le `claude_session_id` |
| `kill_session` | `{session_id}` | `{ok: true}` — arrête + supprime de state.json |
| `ping` | `{}` | `{pong: true, ts}` |

### Events (Agent → Charon)

Tous portent `session_id`. Le set est calqué sur l'actuel `BridgeEvent` :

```
{event: "status", session_id, status: "starting"|"active"|"thinking"|"sleeping"|"error"}
{event: "session_id", session_id, claude_session_id}     # SDK uuid persisté
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

L'agent buffer les **N=300 derniers events par session** en mémoire. Sur `subscribe`, il les envoie d'abord (encadrés par events synthétiques `history_begin`/`history_end` envoyés par Charon vers le navigateur, pas dans le protocole agent). Les permissions/questions encore `pending` ne sont pas dans le ring : l'agent maintient des collections séparées et les renvoie en premier sur subscribe.

## Lifecycle de l'agent

### Démarrage daemon

```
charon-agent [--socket PATH]
```

1. Crée `~/.charon/` si absent (chmod 700).
2. Ouvre le Unix socket `~/.charon/agent.sock` (chmod 600).
3. Lit `~/.charon/state.json` : pour chaque session connue, **lance le restore** (asyncio task qui réinstancie un `ClaudeSDKClient` avec `resume=claude_session_id`).
4. Boucle accept : chaque connexion = un task qui lit/écrit du JSON-RPC.

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

Réécrit après chaque création/kill/sleep + après chaque `session_id` SDK initial.

### Sessions

Chaque session a son propre `ClaudeSDKClient` (réutilisation du code de `bridge.py`, refactoré en classe `AgentSession`).

- Persistance : juste le `claude_session_id` SDK (suffit pour resume — le SDK garde tout dans `~/.claude/projects/...`).
- Pas d'historique de messages dans l'agent (c'est Charon qui le stocke en DB).

### Gestion des clients multiples

Plusieurs connexions Charon possibles simultanément (pour resilience pendant un restart : nouveau Charon connecte, l'ancien meurt, no down-time). Subscriptions par-connexion.

## Installation

### Pré-requis détectés sur le VPS

- **Ubuntu** ≥ 22.04 : `python3` est ≥ 3.10. `apt install python3-pip python3-venv` si manquant.
- **CentOS / Rocky / RHEL 9** : `python3` est 3.9 → `dnf install python3.11 python3.11-pip`.
- **systemd** ≥ 230 (pour `--user` mode). Quasi-toujours présent. Fallback : `nohup setsid` + cron `@reboot`.

### Flow d'install (orchestré côté Charon)

1. **SSH check** (`charon → agent v2 bootstrap stream`) :
   - Détecte OS via `/etc/os-release`
   - Installe Python ≥ 3.10 si absent
   - `pip install --user claude-agent-sdk` (le SDK reste séparé de l'agent)
2. **Drop l'agent** :
   - `scp` (ou `ssh ... cat > ...`) `charon-agent.pyz` vers `~/.charon/charon-agent.pyz`
   - `chmod +x`
3. **Service systemd-user** :
   - Drop `~/.config/systemd/user/charon-agent.service` (template ci-dessous)
   - `loginctl enable-linger <user>` (nécessite sudo OU le user est root)
   - `systemctl --user daemon-reload && systemctl --user enable --now charon-agent`
4. **Vérif socket vivant** :
   - Test : `charon-agent --connect <<< '{"id":1,"method":"ping"}'` → doit retourner `{"id":1,"result":{"pong":true...}}`
5. **Setup Claude** :
   - Si `claude login` jamais fait, ouvrir le **setup console** dans l'UI : on lance `ssh -tt host claude login`, l'utilisateur copie l'URL dans son nav local, colle le code → l'OAuth est stocké.

### Unit systemd-user

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

### Fallback (systemd-user indispo)

`nohup setsid ~/.charon/charon-agent.pyz >> ~/.charon/agent.log 2>&1 &` + cron `@reboot ~/.charon/charon-agent.pyz`.

## Côté Charon

### Nouveau lib/server/agent/

- `AgentClient.ts` : gère la connexion SSH long-running à un VPS, parser JSON-RPC line-delimited, queue des requêtes en cours, dispatch des events vers les subscribers (par session_id).
- `AgentClientPool.ts` : `Map<vpsId, AgentClient>`, lazy-init.
- `types.ts` : protocole TypeScript miroir de `agent/charon_agent/protocol.py`.

### Auto-reconnect SSH

Quand la SSH drop (network, agent restart, etc.) : backoff 2s → 5min, status DB `active` reste, status live `reconnecting`. À la reconnexion : `hello` → réconcilie la liste des sessions avec la DB, re-subscribe aux sessions qui ont des SSE clients en vol.

### Migration DB

Une migration drizzle ajoute deux colonnes à `vps` :

```sql
ALTER TABLE vps ADD COLUMN agent_version TEXT;
ALTER TABLE vps ADD COLUMN agent_status TEXT NOT NULL DEFAULT 'unknown'; -- unknown | ok | missing | error
```

Et une migration data : toutes les sessions `claudeSessions.status='active'` au boot sont passées à `sleeping` une seule fois (les bridges du vieux code sont morts à coup sûr). L'utilisateur peut resume → ça tentera de connecter à l'agent. Si l'agent n'est pas installé : message clair "VPS non setup, fais l'install".

### Refactor des API routes

Les routes existantes (`/api/claude/sessions/*`) gardent leur shape côté front. À l'intérieur, `getWorker(id)` devient `getAgentForSession(sessionId)` (résolu via `claudeSessions.vpsId` → `AgentClientPool.get(vpsId)`), et les `w.sendUserMessage(...)` etc. deviennent `agent.sendInput(sessionId, ...)`.

Le SSE stream lit les events de `agent.subscribe(sessionId, sink)` au lieu de `w.subscribe(sink)`.

## Compatibilité ascendante

Pas de compat avec l'ancienne archi : c'est une refonte one-shot. Au boot après migration, les sessions existantes sont mises en `sleeping` (statut intermédiaire) — l'utilisateur les revoit dans la sidebar et peut décider de les killer ou de les resume. Le resume tentera de joindre l'agent. Si l'agent n'est pas encore installé sur le VPS : erreur explicite + bouton "Setup VPS".

## Sécurité

- Socket Unix `~/.charon/agent.sock` en chmod 600 → seul l'user du daemon y a accès.
- L'agent n'écoute aucun port réseau. Tout passe par SSH.
- Pas d'auth additionnelle entre Charon et l'agent : la possession du SSH key est l'autorisation (modèle existant).
- L'agent exécute en tant que l'user SSH (typiquement root sur ces VPS) — pas de privesc nouvelle.

## Choses non couvertes (out-of-scope)

- Auto-update de l'agent : on le redéploie manuellement via le setup. Plus tard : version check au `hello`, drop + restart si stale.
- Multi-utilisateur : on reste mono-user (un Charon = un user).
- Partage de l'OAuth Claude Code entre VPS : non, chaque VPS fait son `claude login` (cf. discussion produit, trop fragile sinon).

## Risques

- **L'agent crash et `Restart=on-failure` ne suffit pas** : systemd retry. Si crashloop persistant, le state.json reste mais les sessions ne tournent plus. Charon affichera `reconnecting` indéfiniment — l'utilisateur devra SSH et lire `agent.log`.
- **Le `claude_session_id` est devenu invalide côté SDK** (purge `~/.claude/projects/...`) : le restore au boot agent émet une erreur, la session passe en `error`, l'utilisateur la kill et en recrée une.
- **Drift de version SDK** : l'agent fait un check au démarrage (`import claude_agent_sdk`) ; si import fails, exit code != 0 et systemd retry. Le setup console permet de réparer.
