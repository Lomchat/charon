# CLAUDE.md — Guide complet du repo Charon

Document destiné à tout agent Claude qui ouvre ce repo pour la première fois.
Lis-le avant de commencer une tâche : il décrit l'architecture, le protocole,
la structure DB, le build et les pièges connus. Pour la motivation détaillée,
voir aussi `docs/adr-001-charon-agent.md` (le présent fichier est une version
plus large et plus opérationnelle).

> ## ⚠ Mets à jour ce fichier à chaque changement
>
> **Ce CLAUDE.md est la source de vérité pour les futurs agents.** Si tu
> modifies une des choses suivantes, **mets à jour la section concernée
> dans le même commit** :
>
> - Protocole JSON-RPC (méthodes, params, codes d'erreur, events)
> - Schéma DB (table/colonne/index, nouvelle migration)
> - Routes API (nouveau endpoint, suppression, changement de shape)
> - Layout du repo (nouveau dossier, déplacement, renommage)
> - Build / scripts npm / config Next / config Drizzle
> - Variables d'environnement (`.env` keys)
> - Topologie de déploiement (systemd, reverse proxy, chemins sur VPS)
> - Lifecycle de l'agent (fichiers dans `~/.charon/`, unit systemd)
> - Composants frontend majeurs (ajout/refonte d'un composant clé)
> - Pièges connus (nouveau footgun découvert → §14)
>
> Pour les renommages, mets aussi à jour la table « Quick lookup » (§15).
> Pour les changements protocole/schéma, suis la checklist §17.
>
> Ne laisse pas ce fichier mentir : un agent qui se fie à un CLAUDE.md
> périmé fait pire que pas de doc du tout.

---

## 1. Ce que fait Charon

Charon est un **hub Next.js** (App Router, React 19, SQLite) qui pilote des
**sessions Claude Code/Agent SDK** tournant sur **des VPS distants**. Côté
chaque VPS, un **daemon Python** (`charon-agent`, packagé en `.pyz`) héberge
les sessions `ClaudeSDKClient` et expose un protocole JSON-RPC sur un **socket
Unix local** ; Charon s'y connecte via **une seule SSH multiplexée par VPS**.

Le tout offre :
- Un dashboard desktop multi-session (sidebar VPS → sessions → messages)
- Une UI mobile dédiée (`/m/...`)
- Des shells SSH éphémères (xterm.js) en plus des sessions Claude
- La survie des sessions au restart de Charon (l'agent continue, Charon
  re-subscribe au reboot avec replay du ring buffer)
- Un bootstrap automatique des VPS (install Python + SDK + agent en stream SSE)
- Web Push + Telegram pour notifier l'utilisateur quand une permission est
  attendue ou qu'un tour de message se termine

```
┌───────────────┐  HTTPS/SSE   ┌────────────────────────┐  SSH (1 par VPS)  ┌──────────────────────┐
│  Navigateur   │ ◄──────────► │  Charon (Next.js)      │ ◄───────────────► │  charon-agent (VPS)  │
│  ClaudePanel  │  SSE / POST  │  - AgentClientPool     │  exec: pyz        │  - asyncio Unix sock │
└───────────────┘              │  - 1 SSH/VPS, JSON-RPC │  --connect proxy  │  - N sessions SDK    │
                               │  - SQLite (charon.db)  │  stdio↔socket     │  - state.json        │
                               └────────────────────────┘                   └──────────────────────┘
```

---

## 2. Layout du repo

```
/srv/charon
├── app/                       # Next.js App Router (UI + API)
│   ├── api/                   # toutes les routes API
│   ├── m/                     # routes mobile
│   ├── login/                 # page de login (mot de passe maître)
│   ├── ClaudePanel.tsx        # UI desktop principale (~1400 lignes)
│   ├── Sidebar.tsx            # folders → VPS → sessions/shells/installs
│   ├── ToolPanel.tsx          # panneau droit (diffs / todos / calls / files)
│   ├── Message.tsx            # rendu d'un message (markdown, tool, thinking)
│   ├── PermissionPopup.tsx    # popup d'autorisation outil
│   ├── InstallNotificationPopup.tsx # popup top-right "install OK/échec"
│   ├── QuestionCard.tsx       # AskUserQuestion → form
│   ├── ExitPlanCard.tsx       # ExitPlanMode → approve/reject
│   ├── InstallSessionView.tsx # vue plein-écran log d'installation d'agent
│   ├── useInstallNotifications.ts # hook queue locale (events install_finished)
│   ├── TerminalUrlOverlay.tsx # overlay copier/ouvrir sur URL long détecté
│   ├── useTerminalUrlOverlay.ts # hook qui scrute le buffer xterm pour URLs
│   ├── terminalUrlDetect.ts   # regex URL avec dewrap (newlines au milieu)
│   ├── LoginConsole.tsx       # TUI xterm pour `claude login`
│   ├── ShellTerminal.tsx      # xterm pour shells SSH éphémères
│   ├── NewSessionDialog.tsx   # modal création session
│   ├── ResumeModal.tsx        # modal resume / import
│   ├── SessionContextMenu.tsx # menu clic-droit session/shell
│   ├── DataModal.tsx          # gestion VPS + folders (DnD via @dnd-kit) + paths
│   ├── SearchModal.tsx        # recherche full-text
│   ├── SettingsModal.tsx      # settings clé/valeur
│   ├── MobileRedirectPrompt.tsx
│   ├── pushClient.ts          # helpers Web Push
│   ├── inputDraftStore.ts     # store in-memory des brouillons textarea par session (desktop+mobile)
│   ├── icons.tsx              # icônes SVG
│   ├── globals.css            # base tokens (couleurs, fonts)
│   ├── claude.css             # layout desktop (3 colonnes)
│   ├── agent-ui.css           # badges/banner agent
│   ├── layout.tsx, page.tsx   # racine
│   └── icon.svg               # favicon
├── lib/
│   ├── api.ts                 # client API (fetch wrappers)
│   ├── db/
│   │   ├── schema.ts          # tables Drizzle
│   │   └── index.ts           # better-sqlite3 + WAL + FK ON
│   └── server/
│       ├── agent/             # client Charon → charon-agent
│       │   ├── AgentClient.ts        # 1 SSH long-running, JSON-RPC framing
│       │   ├── AgentClientPool.ts    # Map<vpsId, AgentClient>
│       │   ├── sessionOps.ts         # CRUD sessions + bridge events ↔ DB ↔ SSE
│       │   ├── autoConnect.ts        # boot-time : spawn pools + resume
│       │   ├── builtPyzSha.ts        # SHA256 du .pyz embarqué (out-of-date check)
│       │   └── types.ts              # miroir TS du protocole
│       ├── claude/
│       │   ├── bootstrap.ts          # async generator phases d'install VPS
│       │   └── types.ts              # BridgeEvent / WorkerStatus / SSE shape
│       ├── shell/                    # gestion shells SSH éphémères
│       ├── install/                  # sessions d'installation d'agent
│       │   └── installSession.ts     # pool mémoire + ring buffer + bus events
│       ├── auth.ts, session.ts       # auth + cookie session
│       ├── crypto.ts                 # AES-256-GCM (clé dérivée du mdp)
│       ├── seed.ts                   # init au boot (migration v2 + autoConnect)
│       └── migrationV2.ts            # one-shot : active → sleeping après refonte
├── agent/                     # daemon Python (déployé sur les VPS)
│   ├── charon_agent/
│   │   ├── __main__.py        # CLI daemon | --connect
│   │   ├── server.py          # asyncio Unix socket + dispatch JSON-RPC
│   │   ├── session.py         # AgentSession (1 = 1 ClaudeSDKClient + hooks)
│   │   ├── state.py           # ~/.charon/state.json (atomic)
│   │   ├── protocol.py        # codes d'erreur + helpers
│   │   ├── client.py          # mode --connect (stdio↔socket)
│   │   └── __init__.py        # __version__
│   ├── build.sh               # bash → produit dist/charon-agent.pyz (zipapp)
│   ├── dist/charon-agent.pyz  # binaire embarqué (~36KB), envoyé en base64 aux VPS
│   └── README.md
├── drizzle/                   # migrations SQL générées + journal
├── scripts/
│   ├── migrate.mjs                  # applique les migrations Drizzle
│   └── check-protocol-sync.mjs      # vérifie alignement Py↔TS (prebuild)
├── docs/adr-001-charon-agent.md
├── data/charon.db             # SQLite WAL (~43MB)
├── middleware.ts              # gate /api + redirect /login
├── next.config.mjs, tsconfig.json, drizzle.config.ts, package.json
└── /etc/systemd/system/charon.service   (en dehors du repo)
```

---

## 3. Build, dev, prod — et le piège Turbopack

### Scripts npm

```json
"dev":          "next dev -H 127.0.0.1 -p 10556",
"build":        "next build",                  // PAS --turbopack (cf §14)
"start":        "next start -H 127.0.0.1 -p 10556",
"db:generate":  "drizzle-kit generate",
"db:migrate":   "node ./scripts/migrate.mjs"
```

### ⚠ PIÈGE PRODUCTION : Turbopack + `next start`

**Sur Next.js 15.5.18, un build produit avec `--turbopack` n'est pas servi
correctement par `next start`** : tous les `/_next/static/*` répondent 404,
le site charge le HTML mais aucun CSS ni JS. Les chunks `turbopack-*.js`
existent sur disque mais le serveur ne les route pas.

C'est pour ça que le script `"build"` est `next build` tout court (sans
`--turbopack`). **Ne réintroduis pas le flag tant que Next n'a pas
stabilisé Turbopack pour `next start`.** Le dev (`"dev"`) reste en
turbopack — c'est seulement le couple build+start qui foire.

**Symptômes du retour du piège** : `.next/turbopack` (fichier vide) présent,
chunks nommés `turbopack-*.js` dans `static/chunks/`, pas de répertoire
`static/css/`. **Fix** : `systemctl stop charon && rm -rf .next && npm run
build && systemctl start charon`.

Autre symptôme proche : si un `next dev` tourne sur ce répertoire et meurt,
le `.next` reste pollué (manifests de dev, pas de `BUILD_ID`). systemd
lance alors `next start` qui boucle en restart avec *"Could not find a
production build in the '.next' directory"*. Même fix.

### Systemd unit (`/etc/systemd/system/charon.service`)

```
WorkingDirectory=/srv/charon
EnvironmentFile=/srv/charon/.env
ExecStart=/root/.nvm/versions/node/v20.19.5/bin/node /srv/charon/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 10556
User=root
Restart=on-failure
RestartSec=3
```

Logs : `journalctl -u charon -f`.
Status : `systemctl status charon`.

### Dev local

```bash
npm run dev        # turbopack dev sur 127.0.0.1:10556
```

Note que `dev` utilise turbopack sans casse — c'est uniquement le couple
`build --turbopack` puis `start` qui foire.

### Next.js config (`next.config.mjs`)

```js
serverExternalPackages: ['better-sqlite3'],  // sinon SSR casse
reactStrictMode: false,
poweredByHeader: false
```

### Variables d'environnement (`.env`)

Clés attendues (valeurs jamais en clair dans la doc) :

| Clé | Rôle |
|---|---|
| `DATABASE_URL` | chemin vers SQLite (défaut `./data/charon.db`) |
| `MASTER_PASSWORD` | mot de passe d'admin du hub |
| `MASTER_SALT` | sel scrypt pour dériver la clé AES |
| `SESSION_SECRET` | signature cookies session |
| `SYNC_TOKEN` | bearer pour `/api/sync` |
| `VAPID_SUBJECT` | identité de l'expéditeur Web Push (ex: `mailto:admin@example.com`). Override possible via `SettingsModal` |
| `HOST`, `PORT`, `NODE_ENV` | usuels. **`NODE_ENV=production` active HSTS + cookie `secure`** |

Web push : la VAPID key est exposée par `/api/claude/push/key` ; clés stockées
en settings DB (cf table `claudeSettings`).

---

## 4. Base de données

**SQLite WAL** à `/srv/charon/data/charon.db`. Driver : `better-sqlite3`
(sync). ORM : `drizzle-orm`. Le client active `PRAGMA journal_mode=WAL` et
`PRAGMA foreign_keys=ON`.

### Tables (résumé)

| Table | Clés | Rôle |
|---|---|---|
| `users` | `id` PK | utilisateur unique (un hub = un user) |
| `sessions` | `id` PK, FK `userId` | cookies session navigateur |
| `vpsFolders` | `id` PK | dossiers d'organisation des VPS (drag-and-drop dans DataModal, collapse persisté en DB). Dossier `id='default'` créé par migration 0006, protégé contre suppression (cf. piège §14.19). |
| `vps` | `id` PK | VPS distants (voir détail ci-dessous). Colonnes `folderId` + `position` (ordre intra-folder). |
| `vpsPaths` | `id` PK, FK `vpsId` | cwd connus par VPS (sidebar) |
| `claudeSessions` | `id` PK, FK `vpsId` | sessions Claude (status, mode, cwd, name, color, claudeSessionId) |
| `claudeSessionMessages` | autoincrement, FK `sessionId` | historique (role, content, createdAt) |
| `claudePendingPermissions` | `id` PK, FK `sessionId` | gates outils en attente |
| `claudePendingQuestions` | `id` PK, FK `sessionId` | `kind` = `question` (AskUserQuestion) ou `exit_plan` |
| `claudeSessionLogs` | autoincrement | audit / debug par session |
| `claudeSettings` | `key` PK | settings clé/valeur (telegram token, VAPID, etc.) |
| `claudePushSubs` | `id` PK, UNIQUE `endpoint` | endpoints Web Push |

Cascades : `vps → vpsPaths`, `vps → claudeSessions`, `claudeSessions → messages/permissions/questions/logs` (toutes CASCADE).

### Table `vps` (détail — souvent modifiée)

```ts
id: text PK
name, ip, sshUser: text NOT NULL
sshPort: integer DEFAULT 22
defaultPath: text
folderId: text NOT NULL DEFAULT 'default'  -- FK logique → vps_folders.id (non enforced SQLite)
position: integer NOT NULL DEFAULT 0       -- ordre intra-folder (drag-and-drop)
agentStatus: text DEFAULT 'unknown'  -- 'unknown' | 'ok' | 'missing' | 'error'
agentVersion: text                   -- __version__ remonté par hello()
agentPyzSha: text                    -- 12 premiers chars sha256(.pyz) — out-of-date check
agentLastSeenAt: integer             -- ping
claudeLoggedIn: integer              -- 1/0/null : `claude config get oauth.refresh_token`
claudeLoggedInCheckedAt: integer     -- ts unix du dernier check
createdAt: integer DEFAULT unixepoch()
```

### Table `vps_folders` (organisation sidebar)

```ts
id: text PK                          -- 'default' pour le dossier protégé
name: text NOT NULL
position: integer NOT NULL DEFAULT 0  -- ordre entre dossiers (drag-and-drop)
collapsed: integer NOT NULL DEFAULT 0 -- 0/1 boolean, persisté DB (toggle sidebar)
createdAt: integer DEFAULT unixepoch()
```

**Règle "default folder always last"** : le dossier `id='default'` (« Sans
dossier ») est toujours en dernière position côté UI. Il n'est pas
draggable comme dossier (mais les VPS qu'il contient le restent), et
toute tentative de modifier sa `position` via `POST /api/vps-folders/
layout` est silencieusement ignorée côté serveur. À la création d'un
nouveau dossier, sa `position` stockée est forcée à `max(autres) + 1`
pour rester cohérent avec un `ORDER BY position` simple. Côté UI, un
comparateur force l'ordre même si le stockage divergeait. Cf.
`app/DataModal.tsx` (rendu hors `SortableContext` via `StaticFolder`)
et `app/Sidebar.tsx` (`sortedFolders` comparator). La même règle est
appliquée côté mobile dans `app/m/select/MobileSelect.tsx`.

Note : la FK `vps.folder_id → vps_folders.id` n'est **pas** enforced côté
SQLite. SQLite refuse `ADD COLUMN ... REFERENCES` quand le DEFAULT est
non-NULL ("Cannot add a REFERENCES column with non-NULL default value"). Le
schéma TS (`lib/db/schema.ts`) déclare la relation via `.references()` pour
le typage, mais la validation runtime se fait côté API (`/api/vps-folders/
layout` rejette les `folderId` inconnus).

### Migrations (`/srv/charon/drizzle/`)

| # | Description |
|---|---|
| 0000 | tables initiales |
| 0001 | `vps` += `agent_status`, `agent_version`, `agent_last_seen_at` |
| 0002 | refonte `vps_project_paths` → `vps_paths` (drop `projects`) |
| 0003 | `claude_sessions` += `color` |
| 0004 | **no-op** (`SELECT 1`). Doublon accidentel de 0003 (même `ADD COLUMN color`). SQLite n'a pas `ADD COLUMN IF NOT EXISTS` donc on a remplacé le SQL par un statement neutre plutôt que supprimer le fichier — ça garde l'idx du journal stable. **Ne pas réintroduire d'ALTER ici** ; pour une vraie modif, crée une nouvelle migration. |
| 0005 | `vps` += `agent_pyz_sha` |
| 0006 | crée `vps_folders` + insère dossier `'default'` + `vps` += `folder_id`/`position`. Initialise les positions par tri alphabétique de `name`. La FK n'est pas enforced (cf. limitation SQLite ci-dessus). |
| 0007 | `vps` += `claude_logged_in` + `claude_logged_in_checked_at`. Tracking de l'état `claude login` pour masquer le bouton sidebar quand inutile. **Note importante** : drizzle-kit a généré un .sql qui répétait 0005/0006 (snapshots manquants dans `meta/`) — le contenu a été remplacé à la main pour ne garder que les vrais ADD COLUMN, et le `when` du journal a été remonté > 0006 pour que drizzle l'applique. Si tu refais une migration plus tard, vérifie le .sql avant `db:migrate`. |

Workflow type pour modifier le schéma :
1. Édite `lib/db/schema.ts`
2. `npm run db:generate` → produit `drizzle/NNNN_*.sql`
3. `npm run db:migrate` → applique
4. Commit le SQL ET le snapshot dans `drizzle/meta/`

---

## 5. Architecture côté agent (Python pyz)

### Build

```bash
bash agent/build.sh           # → agent/dist/charon-agent.pyz
```

Utilise `python3 -m zipapp` (stdlib pure, **zéro dépendance pip pour le pyz**).
Le fichier produit fait ~36KB. Le shebang `#!/usr/bin/env python3` le rend
exécutable directement.

`lib/server/agent/builtPyzSha.ts` calcule en mémoire le SHA256 (12 chars) du
`.pyz` embarqué et l'expose via `getBuiltPyzSha()`. C'est ce qu'on compare à
`vps.agentPyzSha` (remonté par l'agent dans `hello`) pour décider si une mise
à jour est due.

### Fichiers sur le VPS

```
~/.charon/charon-agent.pyz      # le daemon (~36KB)
~/.charon/agent.sock            # Unix socket (chmod 600)
~/.charon/state.json            # sessions persistées (atomic write)
~/.charon/agent.log             # stdout/stderr append-only
~/.charon/venv/                 # venv créé par bootstrap (PEP 668 friendly)
~/.config/systemd/user/charon-agent.service   # unit systemd-user
                                # fallback : nohup setsid + crontab @reboot
```

Pré-requis VPS :
- Python ≥ 3.10
- `claude-agent-sdk` (installé via `pip install --user` dans `~/.charon/venv`)
- `claude login` fait au moins une fois (OAuth Claude Code)
- systemd ≥ 230 pour `--user` (sinon fallback nohup + cron)

### Lifecycle du daemon

1. Création de `~/.charon/` (chmod 700)
2. Ouverture du socket (chmod 600)
3. Lecture de `state.json` :
   - sessions `killed` → ignorées
   - sessions `sleeping` → chargées en mémoire mais **pas** redémarrées
   - sessions actives → restore (instanciation `ClaudeSDKClient(resume=claude_session_id)`)
4. Boucle `accept` : chaque connexion = 1 task, lit du line-delimited JSON
5. SIGINT/SIGTERM : save state, stop sessions (mark `sleeping`), unlink socket

### Mode `--connect` (le proxy stdio↔socket)

```bash
charon-agent.pyz --connect
```

Démarré par Charon via `ssh user@host exec ~/.charon/charon-agent.pyz --connect`.
Deux threads (pas asyncio — pipes stdin/stdout) :
- `_pump_to_socket` : stdin → socket, `shutdown(SHUT_WR)` sur EOF
- `_pump_from_socket` : socket → stdout, signale EOF

Exit codes : `0` clean, `2` socket absent (daemon mort), `3` connect failed
(perms). Charon utilise `2` pour proposer un setup à l'utilisateur.

### Modules de l'agent

- **`server.py`** : asyncio Unix server, `Client` par connexion (`subscribed:
  set[str]`, `_send_lock`). Dispatch via une table de méthodes (cf §6). Ring
  buffer `RING_SIZE = 300` events par session (`deque(maxlen=300)`), broadcast
  via `subscribers: dict[session_id, set[Client]]`. Save state debounced
  (`schedule_save()`, 0.2s).
- **`session.py`** : `AgentSession`. Encapsule un `ClaudeSDKClient`, des hooks
  `PreToolUse`/`PostToolUse`, le callback `can_use_tool` (AskUserQuestion),
  les futures `_pending_perms`/`_pending_questions`/`_pending_exit_plans`,
  les snapshots before/after fichiers (max 256KB), la traduction `SDK event →
  protocol event` (`AssistantMessage` → `assistant_text`/`thinking`/`tool_use`,
  `UserMessage.ToolResultBlock` → `tool_result`, `ResultMessage` → `stop`).
- **`state.py`** : load tolerant (defaults sur missing fields), save atomic
  (`tempfile + fsync + os.replace`).
- **`protocol.py`** : codes d'erreur JSON-RPC, helpers `make_response`,
  `make_error`, `make_event`. Liste canonique des méthodes.

---

## 6. Protocole JSON-RPC (Charon ↔ agent)

Transport : Unix socket (côté VPS), pipes SSH stdin/stdout (côté hub via
`--connect`). Encodage : **un objet JSON par ligne** (`\n` séparateur).

### Frames

```jsonc
// Request (Charon → Agent)
{"id": 1, "method": "start_session", "params": {...}}

// Response success
{"id": 1, "result": {...}}

// Response error
{"id": 1, "error": {"code": -32000, "message": "session not found"}}

// Event (Agent → Charon, non sollicité)
{"event": "assistant_text", "session_id": "ab12cd34", "delta": "..."}
```

Les `id` sont alloués par Charon (entiers monotones, scoped à la connexion
SSH). Timeout par requête côté `AgentClient.ts` : 60s.

### Méthodes (14)

| Méthode | Params | Result |
|---|---|---|
| `hello` | `{}` | `{agent_version, agent_pyz_sha, sdk_available, sdk_error, pid, sessions:[SessionInfo]}` |
| `ping` | `{}` | `{pong:true, ts}` |
| `list_sessions` | `{}` | `[SessionInfo]` |
| `start_session` | `{session_id?, cwd, name?, permission_mode?, claude_session_id?}` | `{session_id}` |
| `subscribe` | `{session_id, replay?:int}` | `{ok, replay_count, status}` + replay events |
| `unsubscribe` | `{session_id}` | `{ok}` |
| `send_input` | `{session_id, content}` | `{ok}` |
| `interrupt` | `{session_id}` | `{ok}` — soft, peut être ignoré par le SDK si un tool est en cours |
| `force_stop` | `{session_id}` | `{ok}` — cancel forcé : status `sleeping` immédiat, resume possible (cf §14 piège 11) |
| `set_permission_mode` | `{session_id, mode}` | `{ok, mode}` |
| `respond_permission` | `{session_id, perm_id, allow}` | `{ok}` |
| `respond_question` | `{session_id, q_id, answers}` | `{ok}` |
| `respond_exit_plan` | `{session_id, q_id, decision, feedback?}` | `{ok}` |
| `resume_session` | `{session_id}` | `{ok, status, noop?}` |
| `sleep_session` | `{session_id}` | `{ok}` — arrête, garde `claude_session_id` |
| `kill_session` | `{session_id}` | `{ok}` — arrête + supprime de state.json |

### Codes d'erreur

| Code | Sens |
|---|---|
| `-32700` | parse error |
| `-32600` | invalid request |
| `-32601` | method not found |
| `-32602` | invalid params |
| `-32603` | internal |
| `-32000` | session not found |
| `-32001` | session dead |
| `-32010` | SDK unavailable (import failed sur l'agent) |

### Events (Agent → Charon)

Tous portent `session_id`. Le ring buffer en stocke jusqu'à 300 par session.

| Event | Payload (extrait) |
|---|---|
| `status` | `{status: 'starting'|'active'|'thinking'|'sleeping'|'error'|'killed'}` |
| `session_id` | `{claude_session_id}` (UUID SDK, persisté en DB) |
| `ready` | (signal SDK ouvert) |
| `assistant_text` | `{delta}` |
| `thinking` | `{text}` |
| `tool_use` | `{id, name, input}` |
| `tool_result` | `{tool_use_id, content, is_error}` |
| `permission_request` | `{id, tool, input}` |
| `user_question` | `{id, questions}` |
| `exit_plan_request` | `{id, plan}` |
| `todo_update` | `{todos}` |
| `edit_snapshot` | `{phase:'before'|'after', tool_use_id, file_path, content, size, truncated}` |
| `mode_changed` | `{mode}` |
| `stop` | `{subtype}` |
| `error` | `{msg, fatal?}` |
| `interrupted` | `{forced?: bool}` — `forced=true` si déclenché par `force_stop` |
| `replay_begin` | `{count}` (sur subscribe avec replay) |
| `replay_end` | `{}` |

---

## 7. Côté hub : la connexion à l'agent

### `lib/server/agent/AgentClient.ts`

Une instance par VPS. Maintient :
- une SSH long-running (`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10 -o ServerAliveInterval=30 ... user@ip exec "$PY"
  ~/.charon/charon-agent.pyz --connect`) où `$PY` est `python3.13 || python3.12 || ... || python3.10` (le plus récent dispo)
- un parser line-delimited JSON
- une `pending: Map<id, {resolve, reject, method, timer}>` (60s timeout)
- des `subscribers: Map<sessionId, Set<EventListener>>` pour dispatch des events
- statuts : `idle → connecting → connected → reconnecting → closed`
- **backoff reconnect** : `[1s, 3s, 8s, 20s, 60s, 120s, 300s]` (cap 5min)
- au reconnect : `hello` → comparaison `agent_pyz_sha` vs build → mise à jour
  `vps.agentStatus`/`agentVersion`/`agentPyzSha` + re-subscribe automatique aux
  sessions encore actives en mémoire

### `lib/server/agent/AgentClientPool.ts`

`Map<vpsId, AgentClient>` mémoïsée sur `globalThis` (survit aux HMR en dev).
Lazy : créé au premier accès.

### `lib/server/agent/sessionOps.ts`

Le pont entre les events agent, la DB, et les SSE clients du navigateur.

- **Pas de ring buffer côté Charon** : la SSE par-session ne fait que du
  **live**. Au mount / reconnexion / retour foreground, le client fait un
  GET `/api/claude/sessions/[id]` — la DB est la source unique. Décision
  prise après que le double-mécanisme (ring SSE + GET) provoquait races et
  duplicates dans l'historique. Cf. §14 piège 14.
- **Dédup au replay agent** : pendant `replay_begin → replay_end` (events
  envoyés par charon-agent côté VPS au reconnect SSH), les events déjà
  présents en DB (par `tool_use_id`, hash de texte, etc.) sont filtrés pour
  éviter la double persistance après un restart Charon. C'est différent du
  feu ring SSE Charon-side — celui-ci venait de l'agent VPS qui, lui, a
  toujours son ring buffer (cf. §5).
- **Persistance** : `assistant_text` accumulés et flushés sur `stop`/`tool_use`/
  `permission_request`. `tool_use`, `tool_result`, `thinking`, `permission_request`,
  `user_question`, `exit_plan_request` sont insérés dans les tables idoines.
- **Notifications** : sur `permission_request`/`user_question`/`exit_plan_request`/
  `stop`, push Web + Telegram si configuré.
- **alwaysAllow** : set par-session (en mémoire) ; permet l'auto-respond sans UI.
- **Fonctions clés** : `startNewSession`, `resumeSession`, `sleepSession`,
  `killSession`, `importExistingSession`.

### `lib/server/agent/autoConnect.ts`

Au boot du process Charon (via `seed.ts`) :
1. Pour chaque VPS, lance l'`AgentClient` (non bloquant — backoff individuel).
2. **Hook self-healing** : enregistre un `onStatus('connected')` qui appelle
   `reconcileVpsAgentState(vpsId, hello.sessions)` à CHAQUE (re)connexion
   SSH. C'est cette réconciliation qui ré-attache les SessionStream après
   un restart Charon : sans ça, les sessions qui étaient en `'thinking'`
   au moment du SIGTERM restent figées en DB et l'UI affiche un spinner
   éternel parce qu'aucun listener n'est branché côté agent (cf. §14
   piège 23).
3. En parallèle, tente un `resumeSession()` opportuniste pour toutes les
   sessions DB en `'active'`/`'thinking'`/`'starting'` (= "devraient être
   en cours d'exécution"). Si l'agent répond pas dans le timeout RPC, on
   dégrade en `'sleeping'` pour exposer un bouton resume manuel.
4. Logs en DB (`claudeSessionLogs`, event `auto_resume`).

`reconcileVpsAgentState(vpsId, agentSessions)` dans `sessionOps.ts` est la
fonction qui fait le travail : pour chaque session que l'agent connaît, elle
`getStream()` + `ensureAttached()` + sync DB status. Pour chaque session DB
"devrait tourner" que l'agent NE connaît pas (= l'agent a été redémarré et
a perdu son state.json), elle relance via `resumeSession()` (qui fallback
sur `start_session(claude_session_id=…)`).

### `lib/server/claude/bootstrap.ts`

Générateur asynchrone qui produit les phases du setup VPS, consommé par
`POST /api/vps/[id]/claude/setup` (SSE) et `GET /api/vps/[id]/claude/bootstrap`.

Phases (chacune émet `{phase, status:'running'|'ok'|'warn'|'error', detail?}`) :

1. `verify` — `"$PY" -c 'import claude_agent_sdk'`
2. `detect_os` — parse `/etc/os-release` (apt/dnf/yum/apk/pacman)
3. `install_python` — package manager distro
4. `install_sdk` — crée `~/.charon/venv` (évite PEP 668), `pip install
   claude-agent-sdk`
5. `install_claude_cli` — CLI shell `claude` (`curl -fsSL https://claude.ai/install.sh
   | bash`). Distincte du SDK Python. Nécessaire pour `claude login` (OAuth).
   Échec = `warn` non bloquant : l'agent peut tourner sans, mais l'user devra
   installer à la main si `claude login` est requis. PATH étendu à
   `~/.local/bin:~/.claude/bin:/usr/local/bin` pour les check + re-check.
6. `install_agent` — base64-pipe le `.pyz` embarqué vers `~/.charon/charon-agent.pyz`
7. `install_service` — systemd-user (fallback nohup + cron @reboot)
8. `ping_agent` — ping + hello RPC. **Écrit `agentVersion`/`agentPyzSha` en DB
   immédiatement** (sinon l'UI affiche "outdated" jusqu'au prochain hello lazy
   d'`AgentClient` — cf. §14 piège 27).
9. `check_login` — `claude config get oauth.refresh_token` (warn-only, PATH
   étendu pour trouver `claude` même si install.sh l'a mis dans `~/.local/bin`)

`updateVpsAgent(vps)` : redeploy du `.pyz` + restart service + ping vérif.

---

## 8. Routes API (catalogue)

Toutes sous `/api/`. Préfixées par le middleware (sauf `/api/sync` qui s'auth
en Bearer `SYNC_TOKEN`).

### Auth & settings

- `POST /api/login/*`, `POST /logout`
- `GET|POST /api/claude/settings`
- `POST /api/claude/telegram/test`
- `GET /api/claude/push/key`, `POST /api/claude/push/subscribe`, `POST /api/claude/push/unsubscribe`

### VPS CRUD

- `POST /api/vps` — création. Accepte un `folderId` optionnel ; sinon tombe sur le premier dossier (par position) — typiquement `default`. Auto-assigne une `position` = max+1 dans le dossier choisi.
- `PATCH /api/vps/[id]` — update name/ip/sshUser/sshPort/defaultPath
- `DELETE /api/vps/[id]` — cascade
- `POST /api/vps/[id]/test` — test SSH

### VPS folders

- `GET /api/vps-folders` — liste triée par position
- `POST /api/vps-folders` — body `{name, position?}` ; append si position omise
- `PATCH /api/vps-folders/[id]` — body `{name?, collapsed?}` (rename + toggle collapse persisté)
- `DELETE /api/vps-folders/[id]` — refuse pour `id='default'` ; sinon déplace les VPS contenus vers le dossier `default` puis supprime
- `POST /api/vps-folders/layout` — re-layout atomique. Body `{folders:[{id,position}], vps:[{id,folderId,position}]}`. L'UI envoie l'état complet après un drag-end ; le serveur applique en transaction et renvoie l'état resynchronisé.

### VPS paths

- `GET /api/vps-paths`
- `POST /api/vps-paths`, `PATCH /api/vps-paths/[id]`, `DELETE /api/vps-paths/[id]`

### VPS agent (bootstrap, update, login Claude)

- `GET /api/vps/[id]/claude/check` — ping + hello
- `GET /api/vps/[id]/claude/bootstrap` — SSE phases
- `POST /api/vps/[id]/claude/setup` — bootstrap one-shot
- `POST /api/vps/[id]/agent/update` — redeploy `.pyz`
- `GET /api/vps/[id]/claude/scan` — sessions Claude trouvées sur disque (pour import)
- `POST /api/vps/[id]/claude/check-login` — re-vérifie `claude config get oauth.refresh_token` via SSH + persiste `vps.claudeLoggedIn` en DB. Déclenché automatiquement à la fermeture de `LoginConsole` côté UI.
- `GET|POST|DELETE /api/vps/[id]/login` — gérer `claude login`
- `GET /api/vps/[id]/login/stream` — SSE TUI
- `POST /api/vps/[id]/login/input` — stdin

### Shells SSH éphémères

- `GET|POST /api/shells`
- `GET|PATCH|DELETE /api/shells/[id]`
- `GET /api/shells/[id]/stream` — SSE
- `POST /api/shells/[id]/input`

### Installs d'agent (sessions install, mémoire, 1 par VPS max)

- `GET /api/installs` — liste toutes les installs (running + terminées en mémoire)
- `GET /api/installs/[id]` — info
- `DELETE /api/installs/[id]` — ferme la session install (retire du pool ; le
  run SSH en cours n'est pas vraiment annulé, juste plus suivi)
- `GET /api/installs/[id]/stream` — SSE replay ring buffer + live
  (`replay_begin/end`, `event`, `status`)
- `POST /api/installs/[id]/retry` — relance bootstrap dans la même session
- `GET /api/vps/[id]/installs` — install courante pour ce VPS (ou null)
- `POST /api/vps/[id]/installs` — démarre (ou récupère) une install pour ce
  VPS. Si une install est déjà en cours, retourne l'existante (focus, pas
  double-run)

Les events `install_started` / `install_finished` passent aussi par le SSE
multiplexé `/api/claude/events` (bus install, broadcast à toutes les
connexions, classés "low-volume"). C'est ce qui alimente la popup
top-right `<InstallNotificationPopup>` et la mise à jour live de la
liste sidebar.

### Sessions Claude

- `GET /api/claude/sessions` (filtres `vpsId`, `status`)
- `POST /api/claude/sessions` — créer
- `POST /api/claude/sessions/import` — depuis scan
- `GET|PATCH|DELETE /api/claude/sessions/[id]` — GET supporte `?limit=N` (default 200, cap 1000) et `?before=K` (cursor pagination scroll-up). La limite ne compte QUE les rôles "chat" (user/assistant/tool_use/tool_result/user_question/exit_plan_request/thinking) ; `edit_snapshot` et `event` sont chargés en pièces jointes par range d'IDs (cf. §14 piège 25). Réponse : `{ messages, hasMore, oldestChatId, ... }` — `oldestChatId` sert de cursor pour le prochain loadMore.
- `GET /api/claude/events?conn=<uuid>[&focus=<sid>]` — **SSE multiplexée unique** : ouverte UNE FOIS par tab browser, persistante. Émet `status` initial pour toutes les sessions + tous les pendings + flux live filtré par focus. Les changements de session focus sont gérés via POST `/focus` sans reconnect SSE.
- `POST /api/claude/focus` — Body `{ conn, sessionId }`. Change le focus d'une connexion SSE. Le serveur commence/arrête de streamer les events high-volume (assistant_text, tool_use, tool_result, edit_snapshot, todo_update, thinking, user_echo, stop, prefill_input, reconnecting) de la session ciblée. Les events low-volume (status, perms, questions, exit_plans, interaction_resolved, mode_changed, error, ready, session_id) sont toujours envoyés à toutes les connexions.
- `POST /api/claude/sessions/[id]/input` — `{content}` ou `{type:'interrupt'}`
- `POST /api/claude/sessions/[id]/permission` — `{id, allow, always?}`
- `POST /api/claude/sessions/[id]/question` — `{id, answers}`
- `POST /api/claude/sessions/[id]/exit-plan` — `{id, decision, feedback?}`
- `POST /api/claude/sessions/[id]/mode` — `{mode}`
- `POST /api/claude/sessions/[id]/sleep`, `POST .../resume`
- `POST /api/claude/sessions/[id]/force-stop` — cancel forcé quand le SDK ne répond plus au `interrupt` (status → `sleeping`)
- `POST /api/claude/sessions/[id]/revert` — undo une édition (`{filePath, content}`)
- `GET /api/claude/sessions/[id]/export` — JSONL
- `GET /api/claude/search` — full-text sur messages

### Local agent (le hub lui-même)

- `GET /api/local-agent/status`, `POST /api/local-agent/update`

### Sync

- `POST /api/sync` — pour l'ancien hub qui pousse VPS/paths (Bearer auth)

---

## 9. SSE côté navigateur (mapping events)

Le navigateur ouvre `EventSource('/api/claude/sessions/{id}/stream')`. Côté
serveur (`sessionOps.ts`), les events sont relayés depuis l'`AgentClient` +
quelques events synthétiques. Côté client (`ClaudePanel.tsx`), la routing :

| Event SSE | Action UI |
|---|---|
| `status` | met à jour `cur.status` (pill header) |
| `user_echo` | append message user |
| `assistant_text` | accumule dans `assistantBufRef`, streaming display |
| `thinking` | ajoute un thinking message (collapsible) |
| `tool_use` | flush buffer, append message tool_use + entrée dans `toolCalls[]` |
| `tool_result` | pair avec tool_use via `tool_use_id`, met à jour la résultat |
| `permission_request` | push dans `permQueue` → `PermissionPopup` |
| `user_question` | push dans `questionQueue` → `QuestionCard` remplace l'input |
| `exit_plan_request` | push dans `exitPlanQueue` → `ExitPlanCard` |
| `interaction_resolved` | retire de la queue correspondante |
| `mode_changed` | met à jour le badge mode |
| `todo_update` | met à jour onglet `todos` du `ToolPanel` |
| `edit_snapshot` | range dans `edits` Map (before/after par filePath) pour `ToolPanel`/`SplitDiffModal` |
| `stop` | flush final, prêt pour le tour suivant |
| `error` | banner d'erreur ; détecte "import error" → propose bootstrap |
| `prefill_input` | pré-remplit la textarea |
| `replay_begin/end` | gérés côté serveur, transparents pour le client (events agent VPS au reconnect SSH, pas Charon→browser) |

Note : `permission_request`/`user_question`/`exit_plan_request`/
`interaction_resolved` arrivent via **deux chemins** complémentaires :
1. La SSE par-session (`useClaudeSessionStream`) qui les push dans la queue
   per-session (visible dans la vue chat de la session active)
2. La SSE agrégée `/api/claude/interactions/stream` consommée par
   `useCrossSessionInteractionFeed` qui maintient des queues cross-session
   (utilisées par la popup globale ClaudePanel + le bandeau mobile)

Les deux états sont indépendants et non synchronisés — c'est voulu, chaque
vue gère son propre cycle d'affichage. Le serveur émet un seul event mais
le client le route différemment selon le contexte.

---

## 10. Parcours utilisateur typique (golden path)

1. Browser → `/` → SSR `app/page.tsx` :
   - `requireSession()` (cookie `charon_session` valide ? sinon redirect `/login`)
   - `seedInitialData()` (migration v2 si pas faite + `autoConnectAgents()`)
   - Charge `vps`, `vpsPaths`, `claudeSessions` triés desc, `builtPyzSha`
   - Rend `<ClaudePanel ...>`
2. ClaudePanel → mount → ouvre SSE pour la session sélectionnée (sinon attend)
3. User clique « New Session » → `<NewSessionDialog>` → choisit VPS + cwd →
   `api.createClaudeSession()` → `POST /api/claude/sessions` →
   `sessionOps.startNewSession()` :
   - INSERT `claudeSessions` (status `starting`)
   - `AgentClient.start_session()` → l'agent crée `AgentSession` →
     `ClaudeSDKClient(cwd, hooks, can_use_tool, resume?)`
   - `stream.attach()` → écoute les events agent
4. UI reçoit `status=starting` → `ready` → `session_id` (claude_session_id
   persisté en DB)
5. User tape un message → `api.sendClaudeInput()` → `POST /input` →
   `stream.sendUserMessage()` → agent `send_input` →
   `_stdin_queue.put(content)` → `ClaudeSDKClient.query(content)`
6. Events streament : `assistant_text` * N, parfois `thinking`, puis
   `tool_use` → l'agent attend le résultat (interne) ou demande permission :
   - Si `permission_mode == 'normal'` ou tool non auto-safe : le hook
     `_pre_tool_use` crée un `Future`, émet `permission_request` (timeout
     10min)
   - UI : `PermissionPopup` → user clique → `respond_permission` → résolution
     du Future → tool exécuté → `tool_result` émis
7. `stop` event termine le tour.

### Resume après restart Charon

- Toutes les sessions DB en `status='active'` ont été passées à `sleeping`
  par la migration V2 au premier boot après refonte (`migrationV2.ts`).
- `autoConnect.ts` au boot tente de re-subscribe aux sessions encore vivantes
  côté agent (`hello` renvoie la liste). Pour celles non-trouvées sur l'agent
  mais ayant un `claudeSessionId`, un `start_session` avec ce paramètre
  reprend la session SDK depuis l'historique disque.
- En plus, un hook `onStatus('connected')` sur chaque `AgentClient` rappelle
  `reconcileVpsAgentState()` à CHAQUE (re)connexion SSH — y compris donc
  après un drop réseau. C'est ce qui garantit qu'après `systemctl restart
  charon`, les sessions qui étaient en `'thinking'` au moment du SIGTERM
  voient leur `SessionStream` ré-attaché automatiquement, sans avoir besoin
  de faire force_stop + resume à la main (cf. §14 piège 23).

### Sleep / kill

- `sleep` : agent.stop(mark='sleeping'), state.json à jour, DB → `sleeping`.
  Le `claude_session_id` est conservé → resume possible.
- `kill` : agent.stop(mark='killed'), retire de state.json, DB → `killed`,
  closes SSE, vire de `AgentClient.subscribers`.

### Import d'une session existante

`GET /api/vps/[id]/claude/scan` → l'agent énumère `~/.claude/projects/...`
et renvoie les sessions trouvées avec leur résumé. L'UI propose
`<ResumeModal>` pour importer : crée une `claudeSessions` en DB (status
`sleeping`, `claudeSessionId` rempli), pas de `start_session` immédiat.
Quand l'user fait Resume, on lance `start_session` avec `claude_session_id`
+ `cwd` détecté.

---

## 11. Frontend en détail

### Layout 3-colonnes (desktop, `claude.css`)

```
┌──────────────────────────────────────────────────────────────────┐
│  Header (vps:cwd, status pill, search, settings, bell)           │
├──────────────┬─────────────────────────────┬─────────────────────┤
│  Sidebar     │  Chat (scrollable list)     │  ToolPanel          │
│  (VPS,       │                             │  (diffs/todos/      │
│  sessions,   │                             │   calls/files)      │
│  shells)     │  ──────────────────────     │                     │
│              │  Input bar (mode + textarea)│                     │
│  280px       │  1fr                        │  340px              │
└──────────────┴─────────────────────────────┴─────────────────────┘
```

### `ClaudePanel.tsx` (~1400 lignes) — état clé

- `selectedId` : session courante
- `stateById` : `Map<sessionId, { messages, currentAssistant, status,
  permissionMode, toolCalls, todos, edits }>`
- `permQueue`, `questionQueue`, `exitPlanQueue` : interactions en attente
- `assistantBufRef` : buffer du delta streamé
- `esRef` : `EventSource` courante
- Scroll : stick-to-bottom natif à la WhatsApp (`flex-direction: column-reverse`,
  scroll anchoring browser, 0 `useLayoutEffect`) ; cursor pagination scroll-up
  qui charge 200 messages chat plus anciens quand l'utilisateur arrive à
  <400px du haut visuel (cf. §14 piège 25 et `useClaudeSessionStream.loadMoreHistory`)
- Service worker : reçoit les push, `postMessage` à la fenêtre, force le
  `selectedId` sur le tap d'une notification

### Composants secondaires

| Fichier | Rôle |
|---|---|
| `Sidebar.tsx` | Folders (pliables, compteur de sessions actives quand replié) → VPS pliables, sessions/shells/installs groupés, badges agent status, rename inline. État `collapsed` du dossier persisté DB (toggle → `PATCH /api/vps-folders/[id]`). Le collapsed par-VPS reste en localStorage. **Boutons disabled** quand `agentStatus !== 'ok'` : "new claude session" et "historique" — seul "shell SSH" + "install agent" restent dispo. |
| `Message.tsx` | rendu par role (markdown + remark-gfm + rehype-highlight, tool cards, thinking collapsible) |
| `ToolPanel.tsx` | 4 onglets diffs/todos/calls/files ; bouton revert sur un diff → `api.revertClaudeEdit` |
| `SplitDiffModal.tsx` | diff before/after en grand |
| `PermissionPopup.tsx` | flottant, badge queue, allow once / allow always / deny |
| `InstallNotificationPopup.tsx` | flottant top-right, queue locale (events `install_finished` du bus global). Bouton "voir le log" → `selectInstall(id)`. Style copié sur PermissionPopup. |
| `QuestionCard.tsx` | remplace l'input quand AskUserQuestion ; multi-select + free text |
| `ExitPlanCard.tsx` | markdown du plan + Approve / Ask for changes (feedback) |
| `NewSessionDialog.tsx` | VPS dropdown + cwd + autosuggest paths + bouton setup si SDK absent |
| `ResumeModal.tsx` | onglets « resumable DB » et « scanned » |
| `SessionContextMenu.tsx` | clic-droit : rename, cwd, color (8), kill, delete (cf `ROW_COLORS`). Pour `kind='install'` : seulement "Fermer" (pas de rename/color/delete). |
| `InstallSessionView.tsx` | vue plein-écran (occupe `.claude-main`) qui rend le log d'une session d'installation. SSE sur `/api/installs/[id]/stream` (replay ring buffer + live). Header avec status pill + boutons Retry / Setup login / Fermer selon état. Remplace l'ancien `BootstrapBanner` (qui était un bandeau supérieur). |
| `LoginConsole.tsx` | xterm.js, OAuth Claude Code via SSH `-tt`. Branche le flux SSE sur `useTerminalUrlOverlay` pour détecter et proposer copier/ouvrir l'URL OAuth (souvent wrappé sur plusieurs lignes). |
| `ShellTerminal.tsx` | xterm.js, shells SSH éphémères. Idem URL overlay : si l'user voit un URL long dans la sortie d'une commande, overlay copier/ouvrir. |
| `TerminalUrlOverlay.tsx` | Petite carte flottante bottom-right d'un terminal, boutons copier (clipboard API + fallback execCommand) et ouvrir (window.open new tab). |
| `useTerminalUrlOverlay.ts` + `terminalUrlDetect.ts` | Hook qui accumule un rolling buffer (64 KB) du texte stream, applique `extractWrappedUrls` (regex `https?://` + suivi des URL-chars en sautant `\n`/`\r`/jusqu'à 4 espaces — gère hard-wrap et soft-wrap). Seuil 60 chars (en-dessous l'user copie à la main). |
| `DataModal.tsx` | CRUD VPS + folders + paths. Drag-and-drop via `@dnd-kit/core` + `@dnd-kit/sortable` : on peut réordonner les dossiers entre eux et déplacer/réordonner les VPS (intra-dossier ou cross-dossier). Le drag-end POST `/api/vps-folders/layout` (atomique). Folders avec body `useDroppable` pour capter les drops sur l'espace vide. |
| `SearchModal.tsx` | recherche full-text (debounced) sur `/api/claude/search` |
| `SettingsModal.tsx` | settings clé/valeur, test Telegram |
| `MobileRedirectPrompt.tsx` | suggère `/m` quand < 768px ou touch only |
| `LocalAgentButton.tsx` | badge "agent out of date" sur le hub lui-même |
| `pushClient.ts` | helpers Web Push (VAPID, base64↔Uint8Array) |
| `icons.tsx` | SVG icons (Bootstrap Icons) |

### Mobile (`app/m/`)

Layout dédié `.m-root`, fixed, safe-area-insets. Routes :

- `/m` → redirect `/m/select`
- `/m/select` (`MobileSelect.tsx`) : sessions groupées **par dossier puis par
  VPS** (mêmes folders que desktop, état `collapsed` persisté DB via
  `PATCH /api/vps-folders/[id]` → un dossier fermé sur desktop l'est aussi
  mobile, et vice-versa ; un poll 5s sync les folders), long-press →
  bottom sheet contextuel (`MobileContextSheet.tsx`), bouton `+` →
  `NewSessionSheet.tsx`. Le collapse par-VPS reste local (localStorage,
  par-device).
- `/m/chat?id=...` (`MobileChat.tsx`) : version condensée de ClaudePanel
  (pas de ToolPanel à droite), SSE identique, modals overlay
- `/m/shell?id=...` (`MobileShell.tsx`) : xterm fullscreen

### CSS

- `globals.css` : tokens (`--stone`, `--parchment`, `--gold`, `--teal`,
  `--crimson`, `--lavender`), Inter + JetBrains Mono, scrollbars, page auth
- `claude.css` : layout 3-col desktop, bubbles par role, modals, popups
- `agent-ui.css` : badges status agent (●/○/◐/?), banner bootstrap, login console
- `app/m/mobile.css` : mobile (touch ≥44px, no body scroll, sans 3-col)

### `lib/api.ts`

Wrappers `fetch` autour des routes, organisés par domaine (VPS, shells, paths,
sessions, settings, push). Lis-le quand tu cherches un endpoint depuis l'UI.

**Tous typés** : les couples request/response par méthode sont déclarés dans
`lib/types/api.ts`. Le générique `send<TRes>()` propage le typage, donc
`api.foo(...)` renvoie déjà le bon type — pas de cast nécessaire côté caller.
Si tu ajoutes une route, ajoute son couple `XxxBody`/`XxxResponse` dans
`lib/types/api.ts` puis annote la méthode dans `lib/api.ts`.

### Code partagé desktop ↔ mobile

Le `ClaudePanel.tsx` (desktop) et `MobileChat.tsx` (mobile) consomment du
code commun extrait après l'audit maintenabilité :

- **`app/sessionTypes.ts`** : `Msg`, `ToolCallEntry`, `Todo`, `EditSnapshot`,
  `PermissionRequest`, `PendingQuestion`, `PendingExitPlan`. `sessionId` est
  requis partout (mobile remplit avec le sessionId courant).
- **`app/sessionRebuild.ts`** : `rebuildStateFromMessages()` — reconstruit
  l'état d'une session depuis les messages persistés (utilisé au mount /
  switch / retour onglet).
- **`app/sessionCache.ts`** : cache module-level d'une session
  (`getCached` / `fetchAndCache` / `prefetchAll` / `invalidate`).
  Anciennement `app/m/chatCache.ts` — promu en partagé pour servir desktop
  aussi. `app/m/chatCache.ts` reste comme ré-export pour rétrocompat.
- **`app/inputDraftStore.ts`** : store in-memory `Map<sessionId, string>`
  pour le brouillon de la zone d'input (textarea). Expose le hook
  `useInputDraft(sessionId)` qui s'utilise comme un `useState` classique
  mais persiste le texte au switch de session — desktop (re-mount du
  `<ClaudeSessionView key={sid}>`) **et** mobile (changement de prop
  `sessionId` sur la même instance `MobileChat`, géré par une
  réconciliation in-render). Volontairement non persisté à disque : un F5
  vide tout.
- **`app/useClaudeSessionStream.ts`** : hook React qui encapsule SSE +
  state + actions + cache d'**une** session. Utilisé par `MobileChat.tsx`
  et par `<ClaudeSessionView>` (zone chat desktop).
  Le hook expose :
  - State : `messages`, `currentAssistant`, `status`, `permissionMode`,
    `toolCalls`, `todos`, `edits`, `files`, `permQueue`, `questionQueue`,
    `exitPlanQueue`, `prefillInput`, `error`, `sessionMeta`
  - Actions : `send`, `interrupt`, `forceStop`, `setMode`, `doSleep`,
    `doResume`, `doKill`, `respondPermission`/`Question`/`ExitPlan`,
    `refetchHistory`, `clearError`, `clearPrefillInput`
- **`app/useCrossSessionInteractionFeed.ts`** : hook React qui ouvre **une
  seule SSE multiplexée** (`/api/claude/interactions/stream`) écoutant les
  events `permission_request` / `user_question` / `exit_plan_request` /
  `interaction_resolved` de **toutes** les sessions. Maintient les 3 queues
  agrégées (dédup par `id`). Utilisé par :
  - **ClaudePanel** : alimente `<PermissionPopup>` cross-session — tu vois
    les perms d'une autre session en temps réel sans devoir y avoir été.
  - **MobileChat** : compte les interactions sur les autres sessions,
    affiche un bandeau cliquable vers `/m/select`.

  **Pourquoi 1 SSE et pas N** : sur HTTP/1.1, le browser limite à
  6 connexions par origine. Avec 8 sessions + la SSE de la session active,
  les POST (envoi de message, création) restaient en queue. La route
  serveur `app/api/claude/interactions/stream/route.ts` agrège.
- **`app/ClaudeSessionView.tsx`** : composant qui rend la zone chat de la
  session active (header bar avec sleep/resume/kill/interrupt/force-stop,
  bannières reconnect/disconnect/error, chat scroll-reverse + **scroll
  pills ↓/↑** (↓ = aller en bas, masquée si déjà en bas ; ↑ = remonter au
  dernier user message au-dessus de la vue, position fixe au-dessus de ↓,
  reste visible tant qu'on n'est pas au sommet absolu ou que la pagination
  a encore des messages à charger),
  ThinkingBar, input bar avec mode-switch, QuestionCard/ExitPlanCard/
  InlinePermissionCard quand pending, et le ToolPanel). Consomme
  `useClaudeSessionStream`. ClaudePanel l'instancie avec `key={selectedId}`
  pour re-monter sur changement de session (cache module-level rend le
  switch instantané). Mirror mobile dans `app/m/chat/MobileChat.tsx` :
  mêmes pills (`m-scroll-pill` / `m-scroll-up-pill`).

---

## 12. Auth, crypto, session

- **Single-user** : `users` contient 1 ligne, créée à partir de
  `MASTER_PASSWORD` + `MASTER_SALT` au seed.
- **Login** : la page `/login` valide le mot de passe via scrypt, crée une row
  `sessions` (TTL 24h sliding), pose le cookie `charon_session`.
- **`middleware.ts`** : sur toute requête non `_next`/`favicon`/`/login`/
  `/api/sync` : valide le cookie. API non auth → 401. Sinon redirect `/login`.
- **`lib/server/auth.ts`** : helpers `createSession`/`getSession`/`touchSession`.
- **`lib/server/session.ts`** : `requireSession()` (server components),
  `requireApiSession()` (routes API).
- **`lib/server/crypto.ts`** : AES-256-GCM, clé dérivée scrypt. Sert à
  chiffrer ce qui doit l'être en DB (peu de choses actuellement).

---

## 13. Sécurité

- Le socket Unix de l'agent est en `chmod 600` ; pas d'auth additionnelle
  entre Charon et l'agent — possession de la clé SSH = autorisation.
- L'agent **n'écoute aucun port réseau** ; tout transite par SSH.
- L'agent s'exécute typiquement en root (modèle existant). Pas de privesc
  nouvelle introduite.
- `SYNC_TOKEN` : pour `/api/sync` (Bearer). Rotate via `.env`.
- Les secrets (`.env`) ne doivent **jamais** être commités. `MASTER_PASSWORD`,
  `MASTER_SALT`, `SESSION_SECRET` sont critiques.
- **Cookie session** (`charon_session`) : `httpOnly: true`, `sameSite: 'lax'`,
  `secure: process.env.NODE_ENV === 'production'`. Modifier les deux endroits
  qui le posent : `middleware.ts` (refresh) et `app/login/actions.ts`
  (création initiale).
- **Headers HTTP** (cf. `next.config.mjs`) : `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` (prod only).
  Pas de CSP — Next inline des scripts SSR sans nonce, une CSP stricte
  casserait le SSR. À implémenter avec nonce SSR si besoin un jour.
- **Injection shell** : tout `filePath`/`cwd` interpolé dans une commande
  `sshExec` doit passer par `shQuote()` (cf. §14 piège 11).

---

## 14. Pièges / gotchas connus

1. **`next build --turbopack` casse `next start` sur 15.5.18** → site sans
   CSS/JS (404 sur `/_next/static/*`). Build sans turbopack en prod.
2. **`.next` pollué par un `next dev` mort** → `next start` boucle en
   "Could not find a production build". `rm -rf .next && next build`.
3. **Snapshot Drizzle absent au commit** → migrations peuvent diverger.
   Toujours commit `drizzle/*.sql` ET `drizzle/meta/`.
4. **`color` ajouté deux fois** (migrations 0003 et 0004) — le second est
   inerte mais reste un témoin à ne pas reproduire.
5. **Agent out of date** : si `vps.agentPyzSha !== getBuiltPyzSha()`, l'UI
   doit proposer le bouton update (`POST /api/vps/[id]/agent/update`). Ne pas
   oublier de bump `__version__` dans `agent/charon_agent/__init__.py` quand
   on touche au protocole.
6. **`claude login` se fait par VPS** (pas de partage OAuth global), via
   le `<LoginConsole>` (xterm SSH `-tt`).
7. **Permissions `alwaysAllow` sont en mémoire** côté hub (par session, par
   tool) — perdues au restart Charon. Voulu : la rétention permanente passe
   par `permission_mode='auto'`.
8. **better-sqlite3 + Next** : `serverExternalPackages: ['better-sqlite3']`
   est obligatoire dans `next.config.mjs`. Sans ça, SSR crash.
9. **SQLite WAL** : 3 fichiers (`.db`, `.db-shm`, `.db-wal`). Tous critiques.
   `PRAGMA foreign_keys=ON` activé au boot.
10. **`--turbopack` retiré du script `"build"`** (cf §3). Si tu le
    réintroduis dans `package.json` — ou si tu lances `next build --turbopack`
    manuellement — le site servira son HTML sans CSS ni JS. Marqueur :
    présence de `.next/turbopack` et de chunks `turbopack-*.js`.
11. **SSH injection** : tout `filePath`/`cwd`/slug interpolé dans une
    commande `sshExec` **doit passer par `shQuote()`** (exporté de
    `lib/server/claude/sshExec.ts`). Quoter `"$x"` ne suffit pas — `$`,
    `` ` ``, `\\` et `\n` traversent. shQuote utilise les single quotes
    POSIX qui sont opaques à tout sauf à `'`.
12. **Handlers signaux module-level** : `sessionOps.ts` enregistre
    `SIGTERM`/`SIGINT` à l'import. C'est gardé par
    `process.env.NEXT_PHASE !== 'phase-production-build'` pour ne pas faire
    `process.exit(0)` pendant `next build` (qui import les modules pour le
    SSR analysis et reçoit des signaux entre les workers). Si tu ajoutes
    d'autres handlers globaux à l'import d'un module server, applique la
    même garde.
13. **`interrupt` SDK n'annule pas un tool en cours**. Le SDK envoie un signal
    mais `receive_response()` reste bloqué jusqu'à la fin de l'opération
    courante. Pour vraiment couper, utiliser `force_stop` (cancel forcé du
    main task agent, status → `sleeping` immédiat, resume possible). Le
    bouton existe dans le header desktop et le menu mobile. Implémenté en
    agent v0.3.0 — si un VPS est sur 0.2.0, l'UI affichera *agent out of
    date*.
14. **SSE Charon-side est live-only — pas de ring buffer**. Au mount /
    reconnexion / retour foreground, le client doit refetch via GET
    `/api/claude/sessions/[id]` (la DB est source de vérité). Avant, le
    SessionStream maintenait un ring buffer 200 events rejoué à chaque
    subscribe SSE, MAIS le client faisait quand même un GET → events
    traités deux fois (race + duplicates dans l'historique). On a tout
    supprimé : pas de ring buffer ni de markers `history_begin/end`. Si
    tu ajoutes une nouvelle vue, **fais un GET d'abord** — la SSE seule
    ne suffit pas (elle ne fait que du live).
15. **Architecture SSE = un seul stream multiplexé par browser**. Le
    pattern est : 1 EventSource sur `/api/claude/events` (singleton
    `app/globalEventStream.ts`), focus mutable via POST `/focus`. Pas
    d'EventSource par session, pas de close/reopen sur switch. Pourquoi :
    le navigateur limite à 6 connexions par origine en HTTP/1.1 (Apache
    devant Charon n'a pas HTTP/2 activé), et fermer/réouvrir sur switch
    coûte 50-150ms de latence visible. Côté serveur, le bus
    `subscribeGlobalSessionEvents` reçoit TOUS les events tagués avec
    sessionId ; le registre `eventConnections` filtre par focus avant
    d'envoyer au client. **Si tu ajoutes un hook qui veut écouter des
    events serveur, ne crée pas d'EventSource — abonne-toi au global
    stream via `subscribeSession(sid, cb)` ou `subscribeAll(cb)`**.
16. **Events low-volume vs high-volume**. Le serveur classe les events
    en 2 catégories (cf. `eventConnections.ts` § LOW_VOLUME_EVENTS) :
    low-volume (status, mode_changed, ready, session_id,
    permission_request, user_question, exit_plan_request,
    interaction_resolved, error) → envoyés à toutes les connexions.
    High-volume (assistant_text, tool_use, tool_result, edit_snapshot,
    todo_update, thinking, user_echo, stop, prefill_input,
    reconnecting) → uniquement à la connexion focus. Si tu ajoutes un
    nouvel event au protocole, range-le explicitement dans une des deux
    catégories sinon il sera high-volume par défaut.
17. **Per-token re-render = streaming qui lag**. `assistant_text` arrive
    token par token (100+/sec sur Claude Sonnet 4.6). Si tu fais
    `setState` à chaque token, tu re-render le sous-arbre 100x/sec.
    `useClaudeSessionStream` batche via `requestAnimationFrame` (60Hz max).
    Ne fais pas la même erreur si tu ajoutes un autre stream textuel.
18. **Acks pessimistes sur les interactions**. `respondPermission` /
    `respondQuestion` / `respondExitPlan` attendent l'OK du POST avant de
    retirer la card de la queue (avant : c'était optimiste, l'UI se vidait
    mais si le POST foirait, la card revenait au reload et confusion).
    Sauf si t'as une bonne raison, garde ce pattern.
19. **`cmd &;` est une syntax error en bash**. Si tu joins une liste de
    commandes shell avec `'; '` et qu'une des commandes finit par `&`
    (background), tu produis `cmd & ; next` qui fait sauter le parser :
    `bash: -c: syntax error near unexpected token ';'`. Le piège réel
    rencontré : `bootstrap.ts § installAgentService` faisait
    `[...].join('; ')` sur un fallback nohup avec un `nohup ... &` au
    milieu — l'install échouait silencieusement sur tout VPS fresh où
    systemd-user était indispo. **Fix** : joindre avec `\n` plutôt qu'avec
    `'; '` quand un item peut contenir un `&` terminal.
20. **`'...\\'...'` ne fonctionne PAS en bash**. À l'intérieur d'une
    single-quoted string, le backslash est **littéral** — tu ne peux pas
    escape une single quote. Le pattern POSIX valide est `'...'\''...'`
    (ferme, escape, rouvre). Si tu dois construire une commande qui
    contient une chaîne avec des `'`, **base64-encode-la** au lieu de
    quoter (cf. `bootstrap.ts § installAgentService` pour la ligne
    crontab — bytes base64 → `base64 -d` côté VPS).
21. **systemd-user "Failed to connect to bus" sur VPS fresh**. Sur un VPS
    où root n'a jamais eu de session interactive, `systemctl --user` ne
    peut pas trouver le bus dbus (`/run/user/$UID/bus`). `enable-linger`
    seul ne suffit pas — il faut **forcer le démarrage du user manager**
    avec `systemctl start user@$(id -u).service` AVANT le `daemon-reload`.
    Sinon le bootstrap tombe sur le fallback nohup (qui marche, mais
    perd les bénéfices de systemd : auto-restart, append:log, etc.).
22. **Sessions install = pool mémoire, pattern shell**. Une session
    install (`lib/server/install/installSession.ts`) est créée quand
    l'user clique "install agent" sur un VPS. Elle wrap `bootstrapVps()`,
    broadcast les events à des subscribers SSE et au bus global
    (`subscribeInstallBus`). Max 1 par VPS — un 2e `startInstall(vpsId)`
    pendant qu'une tourne déjà retourne l'existante. Au restart Charon :
    tout est perdu (mémoire). Les events `install_started` /
    `install_finished` sont classés low-volume → broadcast à toutes les
    connexions du SSE multiplexé pour alimenter `<InstallNotificationPopup>`.
23. **Échec SSH = abort tout le bootstrap**. Avant : si `tryVerify()`
    tombait sur un SSH timeout/refus/auth, il retournait `reason: 'other'`
    et `bootstrapVps()` poursuivait sur `install_sdk` (qui re-SSH-failait
    après 4 minutes de timeout pip). Maintenant : `detectSshFailure(r:
    SshResult)` dans `bootstrap.ts` reconnaît les patterns `ssh: connect
    to host`, `Host key verification failed`, `Permission denied (...)`,
    `kex_exchange_identification`, `Could not resolve hostname`, et le
    sentinel `[timeout]` injecté par `sshExec`. Sur match : `tryVerify`
    retourne `reason: 'ssh'` avec un message lisible, et `bootstrapVps`
    yield `verify: error` + `done: error` immédiatement. Si tu ajoutes
    une nouvelle phase dans `bootstrapVps`, **appelle `detectSshFailure`
    sur le résultat de chaque `sshExec`** (cf. les 5 phases existantes qui
    le font déjà) — sinon le piège revient.
24. **Chats bloqués après `systemctl restart charon`**. Le SIGTERM handler
    de `sessionOps.ts` flush juste les buffers assistant : il ne touche pas
    aux statuts en DB. Conséquence : une session qui était en `'thinking'`
    au moment du restart reste `'thinking'` en DB. Le bug avait DEUX moitiés :

    **Moitié back-end** : `autoConnect` ne resumait QUE les sessions
    `status='active'` — celles en `'thinking'`/`'starting'` étaient
    ignorées, leur `SessionStream` jamais ré-attaché au listener agent,
    et l'UI affichait un spinner éternel. Le user devait faire `force_stop`
    puis `resume` à la main pour que `resumeSession()` re-fasse le
    `stream.attach()`. **Fix** : (a) `autoConnect` couvre désormais
    `active`/`thinking`/`starting` via `inArray`, et (b) un hook
    `onStatus('connected')` appelle `reconcileVpsAgentState(vpsId, hello.
    sessions)` à chaque (re)connexion SSH, qui utilise la liste des sessions
    rapportée par `hello` comme source de vérité et (ré-)attache un
    SessionStream pour chacune. Idempotent et exécuté à chaque reconnect
    réseau aussi. Cf. `lib/server/agent/autoConnect.ts` +
    `lib/server/agent/sessionOps.ts § reconcileVpsAgentState`.

    **Moitié front-end** : même quand le back recommence à streamer, le
    browser ne refetchait PAS l'historique manqué pendant le drop SSE. La
    SSE est live-only côté Charon (cf. piège 14) ; les messages persistés
    en DB pendant le gap ne sont pas relayés. `useClaudeSessionStream`
    refetchait au mount et sur `visibilitychange` mais PAS sur reconnect
    SSE — l'user voyait son chat figé et devait refresh la page. **Fix**
    dans `app/globalEventStream.ts` : l'`EventSource.onopen` compte les
    opens ; à partir de la 2e (= reconnect), (i) re-POST `/api/claude/focus`
    avec le focus courant — l'URL d'origine de l'EventSource utilise un
    `?focus=` figé que l'auto-reconnect browser rejoue, ce qui peut écraser
    le focus serveur si l'user a switché de session entre temps —, et (ii)
    notifie les `subscribeReconnect` listeners. `useClaudeSessionStream`
    s'y abonne et déclenche `refetchHistory()` → l'UI se met à jour seule.
    Si tu ajoutes un autre hook qui maintient un state synchronisé avec la
    DB serveur, **abonne-le aussi à `subscribeReconnect`** sinon il
    restera figé après un restart back.
25. **`edit_snapshot` et `event` noient `claudeSessionMessages`**. Une session
    "active" écrit 4 rows par Edit (1 tool_use + 1 tool_result + 2 snapshots
    before/after). Avec 240 Edits → 480 snapshots. Un slice `-200` naïf sur
    la table renvoyait alors 186 snapshots + 14 events = 0 messages visibles
    dans le chat (user/assistant/tool_use décalés hors fenêtre). **Fix**
    (`app/api/claude/sessions/[id]/route.ts § loadMessageWindow`) : le limit
    NE COMPTE QUE les rôles "chat" (`NON_PAGINATED_ROLES = ['edit_snapshot',
    'event']` est filtré). Les snapshots/events sont chargés en pièces
    jointes par range d'IDs (`gte(minId), lte(maxId)`) car ils sont émis
    temporellement entre `tool_use` et `tool_result`. Si tu ajoutes un
    nouveau rôle "side-channel" (genre log non-visible côté chat), **range-le
    dans `NON_PAGINATED_ROLES`** sinon il consommera des slots de fenêtre.
26. **Pagination scroll-up = cursor par `id`, pas par index**. Le client
    déclenche `loadMoreHistory()` quand le scroll passe sous 400px du haut
    visuel (column-reverse : `scrollHeight - clientHeight - |scrollTop| <
    400`). Le hook envoie `GET ?before=<oldestChatId>&limit=200` et PRÉPEND
    le résultat. Le browser fait du scroll anchoring nativement quand on
    append à la fin du DOM (= haut visuel en column-reverse), donc **0 manip
    manuelle de scrollTop**. Garde-fous dans `useClaudeSessionStream` :
    `loadMoreInflightRef` empêche les appels concurrents, `hasMore=false`
    + cursor null désactivent les loadMore suivants. **Note** : un
    `refetchHistory()` (visibilitychange, doResume) RESET le cursor à la
    fenêtre la plus récente — les pages étendues sont perdues côté state
    ET côté cache (cf. `sessionCache.fetchAndCache` qui remplace l'entrée).
    Acceptable car visibilitychange est rare ; l'user scroll juste à nouveau.
    Pour les `edits` au merge : on n'écrase JAMAIS une entrée existante par
    une plus ancienne du même `file_path` (le live/récent gagne — sinon on
    perdrait le diff courant en chargeant un Edit antérieur sur le même file).
27. **Post-bootstrap : persister `agentPyzSha` immédiatement**. La DB
    `vps.agentPyzSha` est normalement mise à jour par `AgentClient` sur
    `hello` (cf. `AgentClient.ts` § hello). Mais ce hello arrive **lazy** —
    seulement quand quelqu'un demande à utiliser l'agent (`AgentClientPool.
    get(vpsId)`), typiquement à la 1re création de session Claude. Donc
    après un bootstrap réussi, la DB garde l'ancien `agentPyzSha` (souvent
    `null`), l'UI calcule `agentOutOfDate=true` et propose "update agent"
    alors qu'on vient juste d'installer le bon. **Fix** : `bootstrapVps`
    écrit directement en DB après la phase `ping_agent` réussie (duplique
    le code de `AgentClient.hello` mais c'est volontaire — état cohérent
    dès la fin du bootstrap). Côté client, le handler `install_finished`
    dans `ClaudePanel` patche aussi `agentPyzSha: builtPyzSha` localement
    (par construction le pyz qu'on vient de déployer est la version
    embarquée).

| Question | Fichier(s) |
|---|---|
| Liste des routes API | `app/api/**/route.ts` |
| Wrapper fetch côté client | `lib/api.ts` |
| Types request/response API (par méthode) | `lib/types/api.ts` |
| Schéma DB | `lib/db/schema.ts` |
| Migrations SQL | `drizzle/*.sql` + `drizzle/meta/_journal.json` |
| Protocole JSON-RPC (TS) | `lib/server/agent/types.ts` |
| Protocole JSON-RPC (Py) | `agent/charon_agent/protocol.py` |
| Une session côté agent | `agent/charon_agent/session.py` |
| Dispatch RPC côté agent | `agent/charon_agent/server.py` |
| Connexion SSH + JSON-RPC client | `lib/server/agent/AgentClient.ts` |
| Bridge events ↔ DB ↔ SSE | `lib/server/agent/sessionOps.ts` |
| Reconnect / pool | `lib/server/agent/AgentClientPool.ts` |
| Phases d'install VPS | `lib/server/claude/bootstrap.ts` |
| Pool install sessions (mémoire, ring buffer) | `lib/server/install/installSession.ts` |
| Routes install | `app/api/installs/**` + `app/api/vps/[id]/installs/route.ts` |
| Vue plein-écran log d'install | `app/InstallSessionView.tsx` |
| Popup top-right "install OK/échec" | `app/InstallNotificationPopup.tsx` + `app/useInstallNotifications.ts` |
| Overlay URL copier/ouvrir dans terminaux xterm | `app/TerminalUrlOverlay.tsx` + `app/useTerminalUrlOverlay.ts` + `app/terminalUrlDetect.ts` |
| State machine UI desktop | `app/ClaudePanel.tsx` |
| Handlers SSE côté client | `app/ClaudePanel.tsx` (`es.onmessage`) + `app/useClaudeSessionStream.ts` (utilisé par MobileChat) |
| Hook React session (SSE + state + actions + pagination loadMoreHistory) | `app/useClaudeSessionStream.ts` |
| Pagination scroll-up de l'historique (backend) | `app/api/claude/sessions/[id]/route.ts § loadMessageWindow` |
| Hook React feed cross-session (perms d'autres sessions en temps réel) | `app/useCrossSessionInteractionFeed.ts` |
| Zone chat desktop (consomme le hook) | `app/ClaudeSessionView.tsx` |
| Types partagés desktop/mobile | `app/sessionTypes.ts` |
| Reconstruire l'état d'une session depuis les messages DB | `app/sessionRebuild.ts` |
| Cache module-level d'une session | `app/sessionCache.ts` |
| Brouillons textarea par session (preservés au switch, vidés au F5) | `app/inputDraftStore.ts` (hook `useInputDraft`) |
| Vérif protocole Py↔TS aligné (script prebuild) | `scripts/check-protocol-sync.mjs` |
| Markdown / tool cards | `app/Message.tsx` |
| Diffs / todos / tools | `app/ToolPanel.tsx` |
| Permission popup | `app/PermissionPopup.tsx` |
| AskUserQuestion form | `app/QuestionCard.tsx` |
| ExitPlanMode UI | `app/ExitPlanCard.tsx` |
| Sidebar VPS | `app/Sidebar.tsx` |
| Folders d'organisation VPS (DnD + collapse) | `lib/db/schema.ts` (`vpsFolders`), `app/api/vps-folders/**`, `app/DataModal.tsx` (DnD), `app/Sidebar.tsx` (rendu groupé) |
| Mobile | `app/m/**` |
| Auth (cookie, scrypt) | `lib/server/auth.ts`, `lib/server/session.ts` |
| Build du pyz | `agent/build.sh` |
| Boot init (seed + autoConnect) | `lib/server/seed.ts` |
| Migration data v2 → sleeping | `lib/server/migrationV2.ts` |

---

## 16. Commandes à connaître

```bash
# Dev
npm run dev                                # turbopack dev, 127.0.0.1:10556

# Prod (sur le serveur)
npx next build                             # SANS --turbopack !
systemctl restart charon
journalctl -u charon -f

# DB
npm run db:generate                        # après édition de schema.ts
npm run db:migrate                         # applique
sqlite3 data/charon.db                     # inspection

# Agent
bash agent/build.sh                        # → agent/dist/charon-agent.pyz
python3 -m charon_agent                    # daemon en local
./agent/dist/charon-agent.pyz --connect    # mode proxy stdio↔sock

# Sur un VPS (debug)
ssh root@<ip> systemctl --user status charon-agent
ssh root@<ip> tail -f .charon/agent.log
echo '{"id":1,"method":"ping"}' | ssh root@<ip> ~/.charon/charon-agent.pyz --connect
```

---

## 17. Quand tu touches au repo

**Rappel** : si une de ces modifications change un fait documenté ici,
**mets à jour ce CLAUDE.md dans le même commit** (cf. bandeau du haut).

- **Modifier le protocole JSON-RPC** : édite à la fois `agent/charon_agent/server.py`
  (dispatch + handlers), `agent/charon_agent/protocol.py` (set METHODS),
  `lib/server/agent/types.ts` (miroir TS, **union `AgentMethodName` ET `AgentEvent`**),
  `lib/server/agent/AgentClient.ts` (le wrapper de méthode), et bump
  `agent/charon_agent/__init__.py` `__version__`. Rebuild le `.pyz`
  (`bash agent/build.sh`) → le SHA changera → tous les VPS apparaîtront
  "out of date" dans l'UI tant que tu n'as pas push l'update.
  **→ Mets à jour §6 (méthodes/events) et le bump de version.**
  **Garde-fou automatique** : `scripts/check-protocol-sync.mjs` est exécuté
  par `npm run build` (prebuild). Il compare le set Python `METHODS` à
  l'union TS `AgentMethodName` ; si drift, le build échoue avec un message
  pointant les noms manquants. Pas besoin de t'en souvenir, **le build te le
  rappellera**.
- **Ajouter un event** : `_emit("nouveau_event", session_id=..., ...)` dans
  `session.py`, ajoute le type côté `lib/server/agent/types.ts` et le handler
  côté `sessionOps.ts` puis dans `ClaudePanel.tsx`. **→ Ajoute la ligne dans
  les tables §6 (events) et §9 (mapping SSE).**
- **Nouveau champ DB** : édite `lib/db/schema.ts`, `npm run db:generate`,
  vérifie le SQL, `npm run db:migrate`, commit le `.sql` et le snapshot.
  **→ Ajoute la migration dans la timeline §4 et le champ dans le détail
  de la table.**
- **Nouvelle route API** : crée le `route.ts`, ajoute le wrapper dans
  `lib/api.ts`. **→ Ajoute la ligne dans le catalogue §8.**
- **Nouveau composant UI** : préfère éditer un existant (pas de duplication).
  La majorité de l'état UI vit dans `ClaudePanel.tsx`. **→ Ajoute le
  composant dans la table §11 si c'est un composant majeur, et dans le
  Quick lookup §15.**
- **Permissions / hooks SDK** : tout passe par `agent/charon_agent/session.py`
  (`_pre_tool_use`, `_post_tool_use`, `_can_use_tool`, `_is_safe_bash`).
  C'est là qu'on whiteliste/blacklist.
- **Changement d'infra** (systemd unit, reverse proxy, paths sur VPS, env
  vars) : **→ Mets à jour §3 (systemd), §3 (.env), §5 (fichiers VPS), et
  ajoute un piège en §14 si c'est subtil.**
- **Nouveau footgun découvert** : **→ §14 sans hésiter.** Préviens les
  futurs agents avant qu'ils marchent dessus.

---

Bonne route. En cas de doute, lis aussi `docs/adr-001-charon-agent.md` qui
explique le **pourquoi** des choix d'architecture.
