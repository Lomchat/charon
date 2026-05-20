# CLAUDE.md — Full guide to the Charon repo

Document aimed at any Claude agent opening this repo for the first time.
Read it before starting a task: it describes the architecture, the protocol,
the DB structure, the build, and the known gotchas. For detailed motivation,
also see `docs/adr-001-charon-agent.md` (this file is a broader and more
operational version).

> ## ⚠ Update this file with every change
>
> **This CLAUDE.md is the source of truth for future agents.** If you
> modify any of the following, **update the relevant section in the
> same commit**:
>
> - JSON-RPC protocol (methods, params, error codes, events)
> - DB schema (table/column/index, new migration)
> - API routes (new endpoint, removal, shape change)
> - Repo layout (new folder, move, rename)
> - Build / npm scripts / Next config / Drizzle config
> - Environment variables (`.env` keys)
> - Deployment topology (systemd, reverse proxy, paths on the VPS)
> - Agent lifecycle (files in `~/.charon/`, systemd unit)
> - Major frontend components (adding/redesigning a key component)
> - Known gotchas (newly discovered footgun → §14)
>
> For renames, also update the "Quick lookup" table (§15).
> For protocol/schema changes, follow the §17 checklist.
>
> Don't let this file lie: an agent relying on a stale CLAUDE.md is
> worse off than one with no doc at all.

---

## 1. What Charon does

Charon is a **Next.js hub** (App Router, React 19, SQLite) that drives
**Claude Code/Agent SDK sessions** running on **remote VPSes**. On each
VPS, a **Python daemon** (`charon-agent`, packaged as a `.pyz`) hosts
the `ClaudeSDKClient` sessions and exposes a JSON-RPC protocol on a
**local Unix socket**; Charon connects to it via **one multiplexed SSH
per VPS**.

The whole thing offers:
- A desktop multi-session dashboard (sidebar VPS → sessions → messages)
- A dedicated mobile UI (`/m/...`)
- Ephemeral SSH shells (xterm.js) in addition to Claude sessions
- Session survival across Charon restarts (the agent keeps running, Charon
  re-subscribes on reboot with ring buffer replay)
- Automated VPS bootstrap (install Python + SDK + agent in an SSE stream)
- Web Push + Telegram to notify the user when a permission is pending
  or a message turn finishes

```
┌───────────────┐  HTTPS/SSE   ┌────────────────────────┐  SSH (1 per VPS)  ┌──────────────────────┐
│   Browser     │ ◄──────────► │  Charon (Next.js)      │ ◄───────────────► │  charon-agent (VPS)  │
│  ClaudePanel  │  SSE / POST  │  - AgentClientPool     │  exec: pyz        │  - asyncio Unix sock │
└───────────────┘              │  - 1 SSH/VPS, JSON-RPC │  --connect proxy  │  - N SDK sessions    │
                               │  - SQLite (charon.db)  │  stdio↔socket     │  - state.json        │
                               └────────────────────────┘                   └──────────────────────┘
```

---

## 2. Repo layout

```
/srv/charon
├── app/                       # Next.js App Router (UI + API)
│   ├── api/                   # all API routes
│   ├── m/                     # mobile routes
│   ├── login/                 # login page (master password)
│   ├── ClaudePanel.tsx        # main desktop UI (~1400 lines)
│   ├── Sidebar.tsx            # folders → VPS → sessions/shells/installs
│   ├── ToolPanel.tsx          # right panel (diffs / todos / calls / files)
│   ├── Message.tsx            # message rendering (markdown, tool, thinking)
│   ├── PermissionPopup.tsx    # tool authorization popup
│   ├── InstallNotificationPopup.tsx # top-right popup "install OK/failed"
│   ├── QuestionCard.tsx       # AskUserQuestion → form
│   ├── ExitPlanCard.tsx       # ExitPlanMode → approve/reject
│   ├── InstallSessionView.tsx # full-screen view of an agent install log
│   ├── useInstallNotifications.ts # hook local queue (install_finished events)
│   ├── TerminalUrlOverlay.tsx # copy/open overlay on detected long URL
│   ├── useTerminalUrlOverlay.ts # hook that scans the xterm buffer for URLs
│   ├── terminalUrlDetect.ts   # URL regex with dewrap (newlines in the middle)
│   ├── LoginConsole.tsx       # xterm TUI for `claude login`
│   ├── ShellTerminal.tsx      # xterm for ephemeral SSH shells
│   ├── NewSessionDialog.tsx   # session creation modal
│   ├── ResumeModal.tsx        # resume / import modal
│   ├── SessionContextMenu.tsx # right-click session/shell menu
│   ├── DataModal.tsx          # VPS + folders (DnD via @dnd-kit) + paths management
│   ├── SearchModal.tsx        # full-text search
│   ├── SettingsModal.tsx      # key/value settings
│   ├── MobileRedirectPrompt.tsx
│   ├── pushClient.ts          # Web Push helpers
│   ├── inputDraftStore.ts     # in-memory store of textarea drafts per session (desktop+mobile)
│   ├── icons.tsx              # SVG icons
│   ├── globals.css            # base tokens (colors, fonts)
│   ├── claude.css             # desktop layout (3 columns)
│   ├── agent-ui.css           # agent badges/banner
│   ├── layout.tsx, page.tsx   # root
│   └── icon.svg               # favicon
├── lib/
│   ├── api.ts                 # API client (fetch wrappers)
│   ├── db/
│   │   ├── schema.ts          # Drizzle tables
│   │   └── index.ts           # better-sqlite3 + WAL + FK ON
│   └── server/
│       ├── agent/             # client Charon → charon-agent
│       │   ├── AgentClient.ts        # 1 long-running SSH, JSON-RPC framing
│       │   ├── AgentClientPool.ts    # Map<vpsId, AgentClient>
│       │   ├── sessionOps.ts         # CRUD sessions + bridge events ↔ DB ↔ SSE
│       │   ├── autoConnect.ts        # boot-time: spawn pools + resume
│       │   ├── builtPyzSha.ts        # SHA256 of the embedded .pyz (out-of-date check)
│       │   └── types.ts              # TS mirror of the protocol
│       ├── claude/
│       │   ├── bootstrap.ts          # async generator of VPS install phases
│       │   └── types.ts              # BridgeEvent / WorkerStatus / SSE shape
│       ├── shell/                    # ephemeral SSH shell management
│       ├── install/                  # agent install sessions
│       │   └── installSession.ts     # in-memory pool + ring buffer + event bus
│       ├── auth.ts, session.ts       # auth + session cookie
│       ├── crypto.ts                 # AES-256-GCM (key derived from password)
│       ├── seed.ts                   # boot init (migration v2 + autoConnect)
│       └── migrationV2.ts            # one-shot: active → sleeping after refactor
├── agent/                     # Python daemon (deployed on the VPSes)
│   ├── charon_agent/
│   │   ├── __main__.py        # CLI daemon | --connect
│   │   ├── server.py          # asyncio Unix socket + JSON-RPC dispatch
│   │   ├── session.py         # AgentSession (1 = 1 ClaudeSDKClient + hooks)
│   │   ├── state.py           # ~/.charon/state.json (atomic)
│   │   ├── protocol.py        # error codes + helpers
│   │   ├── client.py          # --connect mode (stdio↔socket)
│   │   └── __init__.py        # __version__
│   ├── build.sh               # bash → produces dist/charon-agent.pyz (zipapp)
│   ├── dist/charon-agent.pyz  # embedded binary (~36KB), shipped base64 to the VPSes
│   └── README.md
├── drizzle/                   # generated SQL migrations + journal
├── scripts/
│   ├── migrate.mjs                  # applies Drizzle migrations
│   └── check-protocol-sync.mjs      # checks Py↔TS alignment (prebuild)
├── docs/adr-001-charon-agent.md
├── data/charon.db             # SQLite WAL (~43MB)
├── middleware.ts              # gate /api + redirect /login
├── next.config.mjs, tsconfig.json, drizzle.config.ts, package.json
└── /etc/systemd/system/charon.service   (outside the repo)
```

---

## 3. Build, dev, prod — and the Turbopack gotcha

### npm scripts

```json
"dev":          "next dev -H 127.0.0.1 -p 10556",
"build":        "next build",                  // NO --turbopack (see §14)
"start":        "next start -H 127.0.0.1 -p 10556",
"db:generate":  "drizzle-kit generate",
"db:migrate":   "node ./scripts/migrate.mjs"
```

### ⚠ PRODUCTION GOTCHA: Turbopack + `next start`

**On Next.js 15.5.18, a build produced with `--turbopack` is not served
correctly by `next start`**: every `/_next/static/*` returns 404, the
site loads its HTML but no CSS or JS. The `turbopack-*.js` chunks exist
on disk but the server doesn't route them.

That's why the `"build"` script is plain `next build` (no `--turbopack`).
**Don't reintroduce the flag until Next has stabilized Turbopack for
`next start`.** Dev (`"dev"`) stays on turbopack — it's only the
build+start combo that breaks.

**Symptoms of the gotcha returning**: `.next/turbopack` (empty file)
present, chunks named `turbopack-*.js` in `static/chunks/`, no
`static/css/` directory. **Fix**: `systemctl stop charon && rm -rf
.next && npm run build && systemctl start charon`.

Another close symptom: if a `next dev` is running in this directory
and dies, `.next` stays polluted (dev manifests, no `BUILD_ID`).
systemd then launches `next start` which restart-loops with *"Could
not find a production build in the '.next' directory"*. Same fix.

### Systemd unit (`/etc/systemd/system/charon.service`)

```
WorkingDirectory=/srv/charon
EnvironmentFile=/srv/charon/.env
ExecStart=/root/.nvm/versions/node/v20.19.5/bin/node /srv/charon/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 10556
User=root
Restart=on-failure
RestartSec=3
```

Logs: `journalctl -u charon -f`.
Status: `systemctl status charon`.

### Local dev

```bash
npm run dev        # turbopack dev on 127.0.0.1:10556
```

Note that `dev` uses turbopack without breaking — it's only the
`build --turbopack` then `start` combo that fails.

### Next.js config (`next.config.mjs`)

```js
serverExternalPackages: ['better-sqlite3'],  // otherwise SSR breaks
reactStrictMode: false,
poweredByHeader: false
```

### Environment variables (`.env`)

Expected keys (values never spelled out in the doc):

| Key | Role |
|---|---|
| `DATABASE_URL` | path to SQLite (default `./data/charon.db`) |
| `MASTER_PASSWORD` | hub admin password |
| `MASTER_SALT` | scrypt salt for deriving the AES key |
| `SESSION_SECRET` | signature for session cookies |
| `SYNC_TOKEN` | bearer for `/api/sync` |
| `VAPID_SUBJECT` | Web Push sender identity (e.g. `mailto:admin@example.com`). Overridable via `SettingsModal` |
| `HOST`, `PORT`, `NODE_ENV` | usual ones. **`NODE_ENV=production` enables HSTS + `secure` cookie** |

Web push: the VAPID key is exposed by `/api/claude/push/key`; keys stored
in DB settings (see `claudeSettings` table).

---

## 4. Database

**SQLite WAL** at `/srv/charon/data/charon.db`. Driver: `better-sqlite3`
(sync). ORM: `drizzle-orm`. The client enables `PRAGMA journal_mode=WAL`
and `PRAGMA foreign_keys=ON`.

### Tables (summary)

| Table | Keys | Role |
|---|---|---|
| `users` | `id` PK | unique user (one hub = one user) |
| `sessions` | `id` PK, FK `userId` | browser session cookies |
| `vpsFolders` | `id` PK | folders organizing VPSes (drag-and-drop in DataModal, collapse persisted in DB). Folder `id='default'` created by migration 0006, protected against deletion (see gotcha §14.19). |
| `vps` | `id` PK | remote VPSes (see detail below). `folderId` + `position` columns (intra-folder ordering). |
| `vpsPaths` | `id` PK, FK `vpsId` | known cwds per VPS (sidebar) |
| `claudeSessions` | `id` PK, FK `vpsId` | Claude sessions (status, mode, cwd, name, color, claudeSessionId) |
| `claudeSessionMessages` | autoincrement, FK `sessionId` | history (role, content, createdAt) |
| `claudePendingPermissions` | `id` PK, FK `sessionId` | pending tool gates |
| `claudePendingQuestions` | `id` PK, FK `sessionId` | `kind` = `question` (AskUserQuestion) or `exit_plan` |
| `claudeSessionLogs` | autoincrement | per-session audit / debug |
| `claudeSettings` | `key` PK | key/value settings (telegram token, VAPID, etc.) |
| `claudePushSubs` | `id` PK, UNIQUE `endpoint` | Web Push endpoints |

Cascades: `vps → vpsPaths`, `vps → claudeSessions`, `claudeSessions → messages/permissions/questions/logs` (all CASCADE).

### `vps` table (detail — often modified)

```ts
id: text PK
name, ip, sshUser: text NOT NULL
sshPort: integer DEFAULT 22
defaultPath: text
folderId: text NOT NULL DEFAULT 'default'  -- logical FK → vps_folders.id (not SQLite-enforced)
position: integer NOT NULL DEFAULT 0       -- intra-folder ordering (drag-and-drop)
agentStatus: text DEFAULT 'unknown'  -- 'unknown' | 'ok' | 'missing' | 'error'
agentVersion: text                   -- __version__ reported by hello()
agentPyzSha: text                    -- first 12 chars of sha256(.pyz) — out-of-date check
agentLastSeenAt: integer             -- ping
claudeLoggedIn: integer              -- 1/0/null: `claude config get oauth.refresh_token`
claudeLoggedInCheckedAt: integer     -- unix ts of last check
createdAt: integer DEFAULT unixepoch()
```

### `vps_folders` table (sidebar organization)

```ts
id: text PK                          -- 'default' for the protected folder
name: text NOT NULL
position: integer NOT NULL DEFAULT 0  -- ordering between folders (drag-and-drop)
collapsed: integer NOT NULL DEFAULT 0 -- 0/1 boolean, persisted in DB (sidebar toggle)
createdAt: integer DEFAULT unixepoch()
```

**"Default folder always last" rule**: the `id='default'` folder ("No
folder") is always last in the UI. It is not draggable as a folder
(but the VPSes inside it still are), and any attempt to change its
`position` via `POST /api/vps-folders/layout` is silently ignored
server-side. When creating a new folder, its stored `position` is
forced to `max(others) + 1` to stay consistent with a simple
`ORDER BY position`. UI-side, a comparator forces the order even if
storage diverged. See `app/DataModal.tsx` (rendered outside
`SortableContext` via `StaticFolder`) and `app/Sidebar.tsx`
(`sortedFolders` comparator). The same rule is applied mobile-side
in `app/m/select/MobileSelect.tsx`.

Note: the FK `vps.folder_id → vps_folders.id` is **not** enforced
SQLite-side. SQLite refuses `ADD COLUMN ... REFERENCES` when the
DEFAULT is non-NULL ("Cannot add a REFERENCES column with non-NULL
default value"). The TS schema (`lib/db/schema.ts`) declares the
relation via `.references()` for typing, but runtime validation
happens API-side (`/api/vps-folders/layout` rejects unknown
`folderId`s).

### Migrations (`/srv/charon/drizzle/`)

| # | Description |
|---|---|
| 0000 | initial tables |
| 0001 | `vps` += `agent_status`, `agent_version`, `agent_last_seen_at` |
| 0002 | refactor `vps_project_paths` → `vps_paths` (drop `projects`) |
| 0003 | `claude_sessions` += `color` |
| 0004 | **no-op** (`SELECT 1`). Accidental duplicate of 0003 (same `ADD COLUMN color`). SQLite has no `ADD COLUMN IF NOT EXISTS` so we replaced the SQL with a neutral statement rather than deleting the file — that keeps the journal idx stable. **Don't reintroduce an ALTER here**; for a real change, create a new migration. |
| 0005 | `vps` += `agent_pyz_sha` |
| 0006 | creates `vps_folders` + inserts `'default'` folder + `vps` += `folder_id`/`position`. Initializes positions by alphabetical sort on `name`. The FK is not enforced (see SQLite limitation above). |
| 0007 | `vps` += `claude_logged_in` + `claude_logged_in_checked_at`. Tracks the `claude login` state to hide the sidebar button when not needed. **Important note**: drizzle-kit generated a .sql that repeated 0005/0006 (missing snapshots in `meta/`) — the contents were manually replaced to only keep the actual ADD COLUMNs, and the journal `when` was bumped > 0006 so drizzle would apply it. If you do another migration later, double-check the .sql before `db:migrate`. |
| 0008 | purges sessions with `status='killed'` (explicit cascade to logs + FK cascade for messages/permissions/questions). Accompanies the kill→delete refactor (see §10): the `'killed'` middle state no longer exists as a persistent state. No schema change — just a `DELETE` on data. Hand-written (drizzle-kit can't generate a data-only migration without a schema change). |

Typical workflow for changing the schema:
1. Edit `lib/db/schema.ts`
2. `npm run db:generate` → produces `drizzle/NNNN_*.sql`
3. `npm run db:migrate` → applies it
4. Commit both the SQL AND the snapshot in `drizzle/meta/`

---

## 5. Agent-side architecture (Python pyz)

### Build

```bash
bash agent/build.sh           # → agent/dist/charon-agent.pyz
```

Uses `python3 -m zipapp` (pure stdlib, **zero pip dependencies for the
pyz**). The produced file is ~36KB. The `#!/usr/bin/env python3`
shebang makes it directly executable.

`lib/server/agent/builtPyzSha.ts` computes the SHA256 (12 chars) of
the embedded `.pyz` in memory and exposes it via `getBuiltPyzSha()`.
That's what we compare against `vps.agentPyzSha` (reported by the
agent in `hello`) to decide whether an update is due.

### Files on the VPS

```
~/.charon/charon-agent.pyz      # the daemon (~36KB)
~/.charon/agent.sock            # Unix socket (chmod 600)
~/.charon/state.json            # persisted sessions (atomic write)
~/.charon/agent.log             # stdout/stderr append-only
~/.charon/venv/                 # venv created by bootstrap (PEP 668 friendly)
~/.config/systemd/user/charon-agent.service   # systemd-user unit
                                # fallback: nohup setsid + crontab @reboot
```

VPS prerequisites:
- Python ≥ 3.10
- `claude-agent-sdk` (installed via `pip install --user` in `~/.charon/venv`)
- `claude login` done at least once (Claude Code OAuth)
- systemd ≥ 230 for `--user` (otherwise fallback nohup + cron)

### Daemon lifecycle

1. Create `~/.charon/` (chmod 700)
2. Open the socket (chmod 600)
3. Read `state.json`:
   - `killed` sessions → ignored
   - `sleeping` sessions → loaded into memory but **not** restarted
   - active sessions → restore (instantiate `ClaudeSDKClient(resume=claude_session_id)`)
4. `accept` loop: each connection = 1 task, reads line-delimited JSON
5. SIGINT/SIGTERM: save state, stop sessions (mark `sleeping`), unlink socket

### `--connect` mode (the stdio↔socket proxy)

```bash
charon-agent.pyz --connect
```

Started by Charon via `ssh user@host exec ~/.charon/charon-agent.pyz --connect`.
Two threads (no asyncio — stdin/stdout pipes):
- `_pump_to_socket`: stdin → socket, `shutdown(SHUT_WR)` on EOF
- `_pump_from_socket`: socket → stdout, signals EOF

Exit codes: `0` clean, `2` socket absent (daemon dead), `3` connect
failed (perms). Charon uses `2` to offer a setup to the user.

### Agent modules

- **`server.py`**: asyncio Unix server, `Client` per connection
  (`subscribed: set[str]`, `_send_lock`). Dispatch via a method table
  (see §6). Ring buffer `RING_SIZE = 300` events per session
  (`deque(maxlen=300)`), broadcast via
  `subscribers: dict[session_id, set[Client]]`. State save is debounced
  (`schedule_save()`, 0.2s).
- **`session.py`**: `AgentSession`. Wraps a `ClaudeSDKClient`,
  `PreToolUse`/`PostToolUse` hooks, the `can_use_tool` callback
  (AskUserQuestion), the
  `_pending_perms`/`_pending_questions`/`_pending_exit_plans` futures,
  before/after file snapshots (max 256KB), and the translation
  `SDK event → protocol event` (`AssistantMessage` →
  `assistant_text`/`thinking`/`tool_use`, `UserMessage.ToolResultBlock`
  → `tool_result`, `ResultMessage` → `stop`).
- **`state.py`**: tolerant load (defaults on missing fields), atomic
  save (`tempfile + fsync + os.replace`).
- **`protocol.py`**: JSON-RPC error codes, `make_response`,
  `make_error`, `make_event` helpers. Canonical method list.

---

## 6. JSON-RPC protocol (Charon ↔ agent)

Transport: Unix socket (VPS-side), SSH stdin/stdout pipes (hub-side via
`--connect`). Encoding: **one JSON object per line** (`\n` separator).

### Frames

```jsonc
// Request (Charon → Agent)
{"id": 1, "method": "start_session", "params": {...}}

// Response success
{"id": 1, "result": {...}}

// Response error
{"id": 1, "error": {"code": -32000, "message": "session not found"}}

// Event (Agent → Charon, unsolicited)
{"event": "assistant_text", "session_id": "ab12cd34", "delta": "..."}
```

`id`s are allocated by Charon (monotonic integers, scoped to the SSH
connection). Per-request timeout in `AgentClient.ts`: 60s.

### Methods (14)

| Method | Params | Result |
|---|---|---|
| `hello` | `{}` | `{agent_version, agent_pyz_sha, sdk_available, sdk_error, pid, sessions:[SessionInfo]}` |
| `ping` | `{}` | `{pong:true, ts}` |
| `list_sessions` | `{}` | `[SessionInfo]` |
| `start_session` | `{session_id?, cwd, name?, permission_mode?, claude_session_id?}` | `{session_id}` |
| `subscribe` | `{session_id, replay?:int}` | `{ok, replay_count, status}` + replay events |
| `unsubscribe` | `{session_id}` | `{ok}` |
| `send_input` | `{session_id, content}` | `{ok}` |
| `interrupt` | `{session_id}` | `{ok}` — soft, may be ignored by the SDK if a tool is in flight |
| `force_stop` | `{session_id}` | `{ok}` — forced cancel: status `sleeping` immediately, resume possible (see §14 gotcha 11) |
| `set_permission_mode` | `{session_id, mode}` | `{ok, mode}` |
| `respond_permission` | `{session_id, perm_id, allow}` | `{ok}` |
| `respond_question` | `{session_id, q_id, answers}` | `{ok}` |
| `respond_exit_plan` | `{session_id, q_id, decision, feedback?}` | `{ok}` |
| `resume_session` | `{session_id}` | `{ok, status, noop?}` |
| `sleep_session` | `{session_id}` | `{ok}` — stops, keeps `claude_session_id` |
| `kill_session` | `{session_id}` | `{ok}` — stops + removes from state.json |

### Error codes

| Code | Meaning |
|---|---|
| `-32700` | parse error |
| `-32600` | invalid request |
| `-32601` | method not found |
| `-32602` | invalid params |
| `-32603` | internal |
| `-32000` | session not found |
| `-32001` | session dead |
| `-32010` | SDK unavailable (import failed on the agent) |

### Events (Agent → Charon)

All carry `session_id`. The ring buffer stores up to 300 per session.

| Event | Payload (excerpt) |
|---|---|
| `status` | `{status: 'starting'|'active'|'thinking'|'sleeping'|'error'|'killed'}` — `'killed'` is no longer persisted in DB since the kill→delete refactor (see §10). It is a **transient signal** emitted by `deleteSession()` at deletion time to notify active SSEs that they should bail out (the `useClaudeSessionStream` hook triggers `onKilled` when it receives this event). |
| `session_id` | `{claude_session_id}` (SDK UUID, persisted in DB) |
| `ready` | (SDK opened signal) |
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
| `interrupted` | `{forced?: bool}` — `forced=true` if triggered by `force_stop` |
| `replay_begin` | `{count}` (on subscribe with replay) |
| `replay_end` | `{}` |

---

## 7. Hub-side: the connection to the agent

### `lib/server/agent/AgentClient.ts`

One instance per VPS. Maintains:
- a long-running SSH (`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10 -o ServerAliveInterval=30 ... user@ip exec "$PY"
  ~/.charon/charon-agent.pyz --connect`) where `$PY` is `python3.13 || python3.12 || ... || python3.10` (the newest available)
- a line-delimited JSON parser
- a `pending: Map<id, {resolve, reject, method, timer}>` (60s timeout)
- `subscribers: Map<sessionId, Set<EventListener>>` for event dispatch
- statuses: `idle → connecting → connected → reconnecting → closed`
- **reconnect backoff**: `[1s, 3s, 8s, 20s, 60s, 120s, 300s]` (cap 5min)
- on reconnect: `hello` → compare `agent_pyz_sha` vs build → update
  `vps.agentStatus`/`agentVersion`/`agentPyzSha` + automatic re-subscribe
  to sessions still active in memory

### `lib/server/agent/AgentClientPool.ts`

`Map<vpsId, AgentClient>` memoized on `globalThis` (survives HMR in
dev). Lazy: created on first access.

### `lib/server/agent/sessionOps.ts`

The bridge between agent events, the DB, and the browser's SSE clients.

- **No ring buffer on the Charon side**: the per-session SSE only does
  **live**. On mount / reconnect / foreground return, the client does
  a GET `/api/claude/sessions/[id]` — the DB is the single source.
  Decision made after the dual mechanism (ring SSE + GET) caused races
  and duplicates in history. See §14 gotcha 14.
- **Dedup on agent replay**: during `replay_begin → replay_end`
  (events sent by charon-agent VPS-side on SSH reconnect), events
  already present in DB (by `tool_use_id`, text hash, etc.) are
  filtered to avoid double persistence after a Charon restart. This
  is different from the Charon-side SSE ring — that one came from
  the VPS agent, which still has its ring buffer (see §5).
- **Persistence**: `assistant_text` accumulated and flushed on
  `stop`/`tool_use`/`permission_request`. `tool_use`, `tool_result`,
  `thinking`, `permission_request`, `user_question`, `exit_plan_request`
  are inserted into the appropriate tables.
- **Notifications**: on `permission_request`/`user_question`/
  `exit_plan_request`/`stop`, Web push + Telegram if configured.
- **alwaysAllow**: per-session set (in memory); allows auto-respond
  without UI.
- **Key functions**: `startNewSession`, `resumeSession`, `sleepSession`,
  `deleteSession`, `importExistingSession`. (Formerly `killSession` →
  renamed `deleteSession` during the kill→delete refactor: see §10.)

### `lib/server/agent/autoConnect.ts`

On Charon process boot (via `seed.ts`):
1. For each VPS, launch the `AgentClient` (non-blocking — individual backoff).
2. **Self-healing hook**: registers an `onStatus('connected')` that
   calls `reconcileVpsAgentState(vpsId, hello.sessions)` on EVERY SSH
   (re)connection. This reconciliation is what re-attaches the
   SessionStreams after a Charon restart: without it, sessions that
   were in `'thinking'` at SIGTERM time stay stuck in DB and the UI
   shows an eternal spinner because no listener is wired up agent-side
   (see §14 gotcha 23).
3. In parallel, attempts an opportunistic `resumeSession()` for all DB
   sessions in `'active'`/`'thinking'`/`'starting'` (= "should be
   running"). If the agent doesn't respond within the RPC timeout, we
   degrade to `'sleeping'` to expose a manual resume button.
4. DB logs (`claudeSessionLogs`, event `auto_resume`).
5. **Auto-check `claude login`**: in the same `onStatus('connected')`
   hook, calls `refreshClaudeLoginStatusIfStale(v)` (see
   `lib/server/agent/claudeLoginCheck.ts`). Best-effort SSH that
   updates `vps.claudeLoggedIn`/`_checkedAt` if never checked or
   older than 24h. Without this step, VPSes bootstrapped before the
   `check_login` phase was added keep `claudeLoggedIn=NULL` forever
   → the "claude login" sidebar button stays visible even when the
   OAuth is valid. The browser sees the new status on the next SSR
   (no SSE event for it — acceptable as page reload is occasional).

`reconcileVpsAgentState(vpsId, agentSessions)` in `sessionOps.ts` does
the work: for each session the agent knows about, it `getStream()` +
`ensureAttached()` + sync DB status. For each DB session "should be
running" that the agent does NOT know about (= the agent was restarted
and lost its state.json), it relaunches via `resumeSession()` (which
falls back to `start_session(claude_session_id=…)`).

### `lib/server/claude/bootstrap.ts`

Async generator that produces the VPS setup phases, consumed by
`POST /api/vps/[id]/claude/setup` (SSE) and
`GET /api/vps/[id]/claude/bootstrap`.

Phases (each emits `{phase, status:'running'|'ok'|'warn'|'error', detail?}`):

1. `verify` — `"$PY" -c 'import claude_agent_sdk'`
2. `detect_os` — parse `/etc/os-release` (apt/dnf/yum/apk/pacman)
3. `install_python` — distro package manager
4. `install_sdk` — creates `~/.charon/venv` (avoids PEP 668),
   `pip install claude-agent-sdk`
5. `install_claude_cli` — `claude` shell CLI (`curl -fsSL
   https://claude.ai/install.sh | bash`). Distinct from the Python
   SDK. Needed for `claude login` (OAuth). Failure = non-blocking
   `warn`: the agent can run without it, but the user will need to
   install it by hand if `claude login` is required. PATH extended
   to `~/.local/bin:~/.claude/bin:/usr/local/bin` for the check +
   re-check.
6. `install_agent` — base64-pipe the embedded `.pyz` to `~/.charon/charon-agent.pyz`
7. `install_service` — systemd-user (fallback nohup + cron @reboot)
8. `ping_agent` — ping + hello RPC. **Writes `agentVersion`/
   `agentPyzSha` in DB immediately** (otherwise the UI shows
   "outdated" until the next lazy `AgentClient` hello — see §14
   gotcha 27).
9. `check_login` — `claude config get oauth.refresh_token` (warn-only,
   PATH extended to find `claude` even if install.sh put it in
   `~/.local/bin`)

`updateVpsAgent(vps)`: redeploy the `.pyz` + restart service + ping check.

---

## 8. API routes (catalog)

All under `/api/`. Prefixed by the middleware (except `/api/sync` which
auths with Bearer `SYNC_TOKEN`).

### Auth & settings

- `POST /api/login/*`, `POST /logout`
- `GET|POST /api/claude/settings`
- `POST /api/claude/telegram/test`
- `GET /api/claude/push/key`, `POST /api/claude/push/subscribe`, `POST /api/claude/push/unsubscribe`

### VPS CRUD

- `POST /api/vps` — create. Accepts an optional `folderId`; otherwise falls back to the first folder (by position) — typically `default`. Auto-assigns a `position` = max+1 in the chosen folder.
- `PATCH /api/vps/[id]` — update name/ip/sshUser/sshPort/defaultPath
- `DELETE /api/vps/[id]` — cascade
- `POST /api/vps/[id]/test` — SSH test

### VPS folders

- `GET /api/vps-folders` — list sorted by position
- `POST /api/vps-folders` — body `{name, position?}`; append if position omitted
- `PATCH /api/vps-folders/[id]` — body `{name?, collapsed?}` (rename + persisted collapse toggle)
- `DELETE /api/vps-folders/[id]` — refused for `id='default'`; otherwise moves the contained VPSes to the `default` folder then deletes
- `POST /api/vps-folders/layout` — atomic re-layout. Body `{folders:[{id,position}], vps:[{id,folderId,position}]}`. The UI sends the full state after a drag-end; the server applies it in a transaction and returns the resynced state.

### VPS paths

- `GET /api/vps-paths`
- `POST /api/vps-paths`, `PATCH /api/vps-paths/[id]`, `DELETE /api/vps-paths/[id]`

### VPS agent (bootstrap, update, Claude login)

- `GET /api/vps/[id]/claude/check` — ping + hello
- `GET /api/vps/[id]/claude/bootstrap` — SSE phases
- `POST /api/vps/[id]/claude/setup` — one-shot bootstrap
- `POST /api/vps/[id]/agent/update` — redeploy `.pyz`
- `GET /api/vps/[id]/claude/scan` — Claude sessions found on disk (for import)
- `POST /api/vps/[id]/claude/check-login` — re-checks `claude config get oauth.refresh_token` via SSH + persists `vps.claudeLoggedIn` in DB. Triggered: (1) on `LoginConsole` close UI-side, (2) automatically by `autoConnect` on every `connected` event of an `AgentClient` if `claudeLoggedIn` is null or `claudeLoggedInCheckedAt` older than 24h (TTL). The SSH+DB logic lives in `lib/server/agent/claudeLoginCheck.ts` (`refreshClaudeLoginStatus` + `refreshClaudeLoginStatusIfStale`) to be shared between the route and the auto-check.
- `GET|POST|DELETE /api/vps/[id]/login` — manage `claude login`
- `GET /api/vps/[id]/login/stream` — SSE TUI
- `POST /api/vps/[id]/login/input` — stdin

### Ephemeral SSH shells

- `GET|POST /api/shells`
- `GET|PATCH|DELETE /api/shells/[id]`
- `GET /api/shells/[id]/stream` — SSE
- `POST /api/shells/[id]/input`

### Agent installs (install sessions, in-memory, max 1 per VPS)

- `GET /api/installs` — list all installs (running + finished in memory)
- `GET /api/installs/[id]` — info
- `DELETE /api/installs/[id]` — closes the install session (removes
  it from the pool; the in-flight SSH run isn't really canceled, just
  no longer tracked)
- `GET /api/installs/[id]/stream` — SSE ring buffer replay + live
  (`replay_begin/end`, `event`, `status`)
- `POST /api/installs/[id]/retry` — relaunches bootstrap in the same session
- `GET /api/vps/[id]/installs` — current install for this VPS (or null)
- `POST /api/vps/[id]/installs` — start (or fetch) an install for this
  VPS. If an install is already running, returns the existing one
  (focus, no double-run)

The `install_started` / `install_finished` events also flow through
the multiplexed SSE `/api/claude/events` (install bus, broadcast to
all connections, classed as "low-volume"). That's what feeds the
top-right `<InstallNotificationPopup>` and the live update of the
sidebar list.

### Claude sessions

- `GET /api/claude/sessions` (filters `vpsId`, `status`)
- `POST /api/claude/sessions` — create
- `POST /api/claude/sessions/import` — from scan
- `GET|PATCH|DELETE /api/claude/sessions/[id]` — GET supports `?limit=N` (default 200, cap 1000) and `?before=K` (cursor pagination for scroll-up). The limit only counts "chat" roles (user/assistant/tool_use/tool_result/user_question/exit_plan_request/thinking); `edit_snapshot` and `event` are loaded as attachments by ID range (see §14 gotcha 25). Response: `{ messages, hasMore, oldestChatId, ... }` — `oldestChatId` serves as cursor for the next loadMore. **DELETE** = definitive deletion (DB cascade + best-effort agent kill) — no more `?hard=1`, no more soft-kill (see §10).
- `GET /api/claude/events?conn=<uuid>[&focus=<sid>]` — **single multiplexed SSE**: opened ONCE per browser tab, persistent. Emits initial `status` for all sessions + all pendings + live stream filtered by focus. Session focus changes are handled via POST `/focus` without SSE reconnect.
- `POST /api/claude/focus` — Body `{ conn, sessionId }`. Changes the focus of an SSE connection. The server starts/stops streaming the high-volume events (assistant_text, tool_use, tool_result, edit_snapshot, todo_update, thinking, user_echo, stop, prefill_input, reconnecting) of the targeted session. Low-volume events (status, perms, questions, exit_plans, interaction_resolved, mode_changed, error, ready, session_id) are always sent to all connections.
- `POST /api/claude/sessions/[id]/input` — `{content}` or `{type:'interrupt'}`
- `POST /api/claude/sessions/[id]/permission` — `{id, allow, always?}`
- `POST /api/claude/sessions/[id]/question` — `{id, answers}`
- `POST /api/claude/sessions/[id]/exit-plan` — `{id, decision, feedback?}`
- `POST /api/claude/sessions/[id]/mode` — `{mode}`
- `POST /api/claude/sessions/[id]/sleep`, `POST .../resume`
- `POST /api/claude/sessions/[id]/force-stop` — forced cancel when the SDK no longer responds to `interrupt` (status → `sleeping`)
- `POST /api/claude/sessions/[id]/revert` — undo an edit (`{filePath, content}`)
- `GET /api/claude/sessions/[id]/export` — JSONL
- `GET /api/claude/search` — full-text on messages

### Local agent (the hub itself)

- `GET /api/local-agent/status`, `POST /api/local-agent/update`

### Sync

- `POST /api/sync` — for the legacy hub pushing VPS/paths (Bearer auth)

---

## 9. Browser-side SSE (event mapping)

The browser opens `EventSource('/api/claude/sessions/{id}/stream')`.
Server-side (`sessionOps.ts`), events are relayed from the `AgentClient`
+ a few synthetic events. Client-side (`ClaudePanel.tsx`), the routing:

| SSE event | UI action |
|---|---|
| `status` | updates `cur.status` (header pill). **Special case `'killed'`**: since the kill→delete refactor (see §10), `'killed'` is a transient signal emitted by `deleteSession()` server-side — the `useClaudeSessionStream` hook does NOT update local state but triggers `onKilled?.()` (= redirect out of the session). |
| `user_echo` | append user message |
| `assistant_text` | accumulates in `assistantBufRef`, streaming display |
| `thinking` | adds a thinking message (collapsible) |
| `tool_use` | flush buffer, append tool_use message + entry in `toolCalls[]` |
| `tool_result` | paired with tool_use via `tool_use_id`, updates the result |
| `permission_request` | push into `permQueue` → `PermissionPopup` |
| `user_question` | push into `questionQueue` → `QuestionCard` replaces the input |
| `exit_plan_request` | push into `exitPlanQueue` → `ExitPlanCard` |
| `interaction_resolved` | removes from the matching queue |
| `mode_changed` | updates the mode badge |
| `todo_update` | updates the `todos` tab of `ToolPanel` |
| `edit_snapshot` | stored in `edits` Map (before/after per filePath) for `ToolPanel`/`SplitDiffModal` |
| `stop` | final flush, ready for the next turn |
| `error` | error banner; detects "import error" → offers bootstrap |
| `prefill_input` | pre-fills the textarea |
| `replay_begin/end` | handled server-side, transparent to the client (VPS agent events on SSH reconnect, not Charon→browser) |

Note: `permission_request`/`user_question`/`exit_plan_request`/
`interaction_resolved` arrive via **two complementary paths**:
1. The per-session SSE (`useClaudeSessionStream`) which pushes them
   into the per-session queue (visible in the active session's chat
   view)
2. The aggregated SSE `/api/claude/interactions/stream` consumed by
   `useCrossSessionInteractionFeed` which maintains cross-session
   queues (used by the global ClaudePanel popup + the mobile banner)

The two states are independent and not synchronized — that's by
design, each view manages its own display cycle. The server emits a
single event but the client routes it differently depending on the
context.

---

## 10. Typical user journey (golden path)

1. Browser → `/` → SSR `app/page.tsx`:
   - `requireSession()` (`charon_session` cookie valid? otherwise redirect `/login`)
   - `seedInitialData()` (v2 migration if not done + `autoConnectAgents()`)
   - Loads `vps`, `vpsPaths`, `claudeSessions` sorted desc, `builtPyzSha`
   - Renders `<ClaudePanel ...>`
2. ClaudePanel → mount → opens SSE for the selected session (otherwise waits)
3. User clicks "New Session" → `<NewSessionDialog>` → picks VPS + cwd →
   `api.createClaudeSession()` → `POST /api/claude/sessions` →
   `sessionOps.startNewSession()`:
   - INSERT `claudeSessions` (status `starting`)
   - `AgentClient.start_session()` → the agent creates `AgentSession` →
     `ClaudeSDKClient(cwd, hooks, can_use_tool, resume?)`
   - `stream.attach()` → listens for agent events
4. UI receives `status=starting` → `ready` → `session_id`
   (claude_session_id persisted in DB)
5. User types a message → `api.sendClaudeInput()` → `POST /input` →
   `stream.sendUserMessage()` → agent `send_input` →
   `_stdin_queue.put(content)` → `ClaudeSDKClient.query(content)`
6. Events stream: `assistant_text` * N, sometimes `thinking`, then
   `tool_use` → the agent waits for the result (internal) or requests
   permission:
   - If `permission_mode == 'normal'` or tool not auto-safe: the
     `_pre_tool_use` hook creates a `Future`, emits
     `permission_request` (10min timeout)
   - UI: `PermissionPopup` → user clicks → `respond_permission` →
     Future resolved → tool executed → `tool_result` emitted
7. `stop` event ends the turn.

### Resume after Charon restart

- All DB sessions in `status='active'` were moved to `sleeping` by
  the V2 migration on the first boot after the refactor
  (`migrationV2.ts`).
- `autoConnect.ts` at boot tries to re-subscribe to sessions still
  alive agent-side (`hello` returns the list). For those not found
  on the agent but having a `claudeSessionId`, a `start_session`
  with that parameter resumes the SDK session from the on-disk
  history.
- On top of that, an `onStatus('connected')` hook on each
  `AgentClient` calls `reconcileVpsAgentState()` on EVERY SSH
  (re)connection — including after a network drop. That's what
  guarantees that after `systemctl restart charon`, sessions that
  were in `'thinking'` at SIGTERM time have their `SessionStream`
  re-attached automatically, without needing to manually do
  force_stop + resume (see §14 gotcha 23).

### Sleep / delete (kill→delete refactor, November 2025)

Before the refactor, there were **3 states**: `sleep` (reversible
pause), `kill` (status `'killed'`, non-resumable but readable
history), and `hardDelete` (DB cascade). The "pause" button in the
header actually called `kill` — UX false friend. The `'killed'`
middle state served no purpose: agent-side it freed exactly the same
resources as `sleep` (the only difference was `self.sessions.pop()`
agent-side + a "don't resume" flag Charon-side). We merged `kill`
and `hardDelete` into a single **definitive deletion** action.

The current model: **2 buttons**.

- **`sleep`**: `agent.stop(mark='sleeping')`, state.json updated, DB
  → `sleeping`. The `claude_session_id` is kept → resume possible.
- **`delete`** (`POST /api/claude/sessions/[id]` DELETE →
  `deleteSession()` in `lib/server/agent/sessionOps.ts`): emits
  `status='killed'` on the bus as a transient signal, detaches +
  removes the SessionStream, DB cascade (logs + session row → FK
  cascade for messages/permissions/questions), then best-effort
  `kill_session` RPC so the agent forgets the session.

The DB status `'killed'` no longer exists as a persistent state —
migration 0008 purged the remnants. The `status='killed'` event
survives only as a **transient signal**: the
`useClaudeSessionStream` hook triggers `onKilled` (= navigation out
of the session) when it receives it. The DB row is deleted
immediately, so the client can never observe a "killed but
viewable" session.

The TS enum `WorkerStatus` (`lib/server/claude/types.ts`) still
keeps the `'killed'` member to type the transient signal — no need
to remove it.

### Importing an existing session

`GET /api/vps/[id]/claude/scan` → the agent enumerates
`~/.claude/projects/...` and returns the sessions found along with
their summary. The UI offers `<ResumeModal>` to import: creates a
`claudeSessions` row in DB (status `sleeping`, `claudeSessionId`
filled), no immediate `start_session`. When the user clicks Resume,
we launch `start_session` with `claude_session_id` + the detected
`cwd`.

---

## 11. Frontend in detail

### 3-column layout (desktop, `claude.css`)

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

### `ClaudePanel.tsx` (~1400 lines) — key state

- `selectedId`: current session
- `stateById`: `Map<sessionId, { messages, currentAssistant, status,
  permissionMode, toolCalls, todos, edits }>`
- `permQueue`, `questionQueue`, `exitPlanQueue`: pending interactions
- `assistantBufRef`: streamed delta buffer
- `esRef`: current `EventSource`
- Scroll: WhatsApp-style native stick-to-bottom
  (`flex-direction: column-reverse`, browser scroll anchoring, 0
  `useLayoutEffect`); cursor pagination scroll-up that loads 200
  older chat messages when the user reaches <400px from the visual
  top (see §14 gotcha 25 and `useClaudeSessionStream.loadMoreHistory`)
- Service worker: receives pushes, `postMessage`s the window, forces
  `selectedId` on a notification tap

### Secondary components

| File | Role |
|---|---|
| `Sidebar.tsx` | Folders (collapsible, active session counter when collapsed) → collapsible VPSes, grouped sessions/shells/installs, agent status badges, inline rename. Folder `collapsed` state persisted in DB (toggle → `PATCH /api/vps-folders/[id]`). Per-VPS collapsed remains in localStorage. **Disabled buttons** when `agentStatus !== 'ok'`: "new claude session" and "history" — only "SSH shell" + "install agent" remain available. |
| `Message.tsx` | rendering per role (markdown + remark-gfm + rehype-highlight, tool cards, collapsible thinking) |
| `ToolPanel.tsx` | 4 tabs diffs/todos/calls/files; revert button on a diff → `api.revertClaudeEdit` |
| `SplitDiffModal.tsx` | large before/after diff |
| `PermissionPopup.tsx` | floating, queue badge, allow once / allow always / deny |
| `InstallNotificationPopup.tsx` | floating top-right, local queue (`install_finished` events from the global bus). "View log" button → `selectInstall(id)`. Style copied from PermissionPopup. |
| `QuestionCard.tsx` | replaces the input on AskUserQuestion; multi-select + free text |
| `ExitPlanCard.tsx` | plan markdown + Approve / Ask for changes (feedback) |
| `NewSessionDialog.tsx` | VPS dropdown + cwd + path autosuggest + setup button if SDK missing |
| `ResumeModal.tsx` | "resumable DB" and "scanned" tabs |
| `SessionContextMenu.tsx` | right-click: rename, cwd, color (8), delete (see `ROW_COLORS`). For Claude sessions: only "Delete permanently" (no intermediate "kill" since the kill→delete refactor, see §10). For shells / installs: "Close" (the component's `onKill` serves as close here, not as a Claude session kill). |
| `InstallSessionView.tsx` | full-screen view (fills `.claude-main`) rendering an install session's log. SSE on `/api/installs/[id]/stream` (ring buffer replay + live). Header with status pill + Retry / Setup login / Close buttons depending on state. Replaces the old `BootstrapBanner` (which was a top banner). |
| `LoginConsole.tsx` | xterm.js, Claude Code OAuth via SSH `-tt`. Wires the SSE stream into `useTerminalUrlOverlay` to detect and offer copy/open of the OAuth URL (often wrapped over several lines). |
| `ShellTerminal.tsx` | xterm.js, ephemeral SSH shells. Same URL overlay: if the user sees a long URL in a command's output, copy/open overlay. |
| `TerminalUrlOverlay.tsx` | Small floating card bottom-right of a terminal, copy (clipboard API + execCommand fallback) and open (window.open new tab) buttons. |
| `useTerminalUrlOverlay.ts` + `terminalUrlDetect.ts` | Hook that accumulates a rolling buffer (64 KB) of streamed text, applies `extractWrappedUrls` (regex `https?://` + tracking URL-chars while skipping `\n`/`\r`/up to 4 spaces — handles hard-wrap and soft-wrap). 60 char threshold (below it the user copies by hand). |
| `DataModal.tsx` | VPS + folders + paths CRUD. Drag-and-drop via `@dnd-kit/core` + `@dnd-kit/sortable`: you can reorder folders among themselves and move/reorder VPSes (intra-folder or cross-folder). Drag-end POSTs `/api/vps-folders/layout` (atomic). Folders with body `useDroppable` to catch drops on empty space. |
| `SearchModal.tsx` | full-text search (debounced) on `/api/claude/search` |
| `SettingsModal.tsx` | key/value settings, Telegram test |
| `MobileRedirectPrompt.tsx` | suggests `/m` when < 768px or touch-only |
| `LocalAgentButton.tsx` | "agent out of date" badge on the hub itself |
| `pushClient.ts` | Web Push helpers (VAPID, base64↔Uint8Array) |
| `icons.tsx` | SVG icons (Bootstrap Icons) |

### Mobile (`app/m/`)

Dedicated `.m-root` layout, fixed, safe-area-insets. Routes:

- `/m` → redirect `/m/select`
- `/m/select` (`MobileSelect.tsx`): sessions grouped **by folder then
  by VPS** (same folders as desktop, `collapsed` state persisted in
  DB via `PATCH /api/vps-folders/[id]` → a folder closed on desktop
  is closed on mobile too, and vice versa; a 5s poll syncs folders),
  long-press → contextual bottom sheet (`MobileContextSheet.tsx`),
  `+` button → `NewSessionSheet.tsx`. Per-VPS collapse stays local
  (localStorage, per device).
- `/m/chat?id=...` (`MobileChat.tsx`): condensed version of
  ClaudePanel (no ToolPanel on the right), identical SSE, overlay
  modals
- `/m/shell?id=...` (`MobileShell.tsx`): fullscreen xterm

### CSS

- `globals.css`: tokens (`--stone`, `--parchment`, `--gold`,
  `--teal`, `--crimson`, `--lavender`), Inter + JetBrains Mono,
  scrollbars, auth page
- `claude.css`: 3-col desktop layout, bubbles per role, modals, popups
- `agent-ui.css`: agent status badges (●/○/◐/?), bootstrap banner,
  login console
- `app/m/mobile.css`: mobile (touch ≥44px, no body scroll, no 3-col)

### `lib/api.ts`

`fetch` wrappers around the routes, organized by domain (VPS, shells,
paths, sessions, settings, push). Read it when looking for an
endpoint from the UI.

**All typed**: the per-method request/response pairs are declared in
`lib/types/api.ts`. The generic `send<TRes>()` propagates typing, so
`api.foo(...)` already returns the right type — no cast needed on the
caller side. If you add a route, add its `XxxBody`/`XxxResponse` pair
in `lib/types/api.ts` then annotate the method in `lib/api.ts`.

### Shared desktop ↔ mobile code

`ClaudePanel.tsx` (desktop) and `MobileChat.tsx` (mobile) consume
common code extracted after the maintainability audit:

- **`app/sessionTypes.ts`**: `Msg`, `ToolCallEntry`, `Todo`,
  `EditSnapshot`, `PermissionRequest`, `PendingQuestion`,
  `PendingExitPlan`. `sessionId` is required everywhere (mobile
  fills it with the current sessionId).
- **`app/sessionRebuild.ts`**: `rebuildStateFromMessages()` —
  rebuilds a session's state from persisted messages (used on mount
  / switch / tab return).
- **`app/sessionCache.ts`**: module-level cache of a session
  (`getCached` / `fetchAndCache` / `prefetchAll` / `invalidate`).
  Formerly `app/m/chatCache.ts` — promoted to shared to serve
  desktop too. `app/m/chatCache.ts` remains as a re-export for
  backward compat.
- **`app/inputDraftStore.ts`**: in-memory store
  `Map<sessionId, string>` for the input area (textarea) draft.
  Exposes the `useInputDraft(sessionId)` hook that's used like a
  regular `useState` but persists the text across session switches —
  desktop (re-mount of `<ClaudeSessionView key={sid}>`) **and**
  mobile (change of `sessionId` prop on the same `MobileChat`
  instance, handled by an in-render reconciliation). Intentionally
  not persisted to disk: an F5 clears everything.
- **`app/useClaudeSessionStream.ts`**: React hook that wraps SSE +
  state + actions + cache of **one** session. Used by
  `MobileChat.tsx` and by `<ClaudeSessionView>` (desktop chat area).
  The hook exposes:
  - State: `messages`, `currentAssistant`, `status`,
    `permissionMode`, `toolCalls`, `todos`, `edits`, `files`,
    `permQueue`, `questionQueue`, `exitPlanQueue`, `prefillInput`,
    `error`, `sessionMeta`
  - Actions: `send`, `interrupt`, `forceStop`, `setMode`, `doSleep`,
    `doResume`, `doKill`, `respondPermission`/`Question`/`ExitPlan`,
    `refetchHistory`, `clearError`, `clearPrefillInput`
- **`app/useCrossSessionInteractionFeed.ts`**: React hook that opens
  **a single multiplexed SSE** (`/api/claude/interactions/stream`)
  listening to `permission_request` / `user_question` /
  `exit_plan_request` / `interaction_resolved` events of **all**
  sessions. Maintains the 3 aggregated queues (dedup by `id`). Used
  by:
  - **ClaudePanel**: feeds cross-session `<PermissionPopup>` — you
    see another session's perms in real time without needing to
    have been on it.
  - **MobileChat**: counts interactions on other sessions, displays
    a clickable banner to `/m/select`.

  **Why 1 SSE and not N**: on HTTP/1.1, the browser caps at 6
  connections per origin. With 8 sessions + the active session's
  SSE, POSTs (sending a message, creating) stayed queued. The
  server route `app/api/claude/interactions/stream/route.ts`
  aggregates.
- **`app/ClaudeSessionView.tsx`**: component that renders the chat
  area of the active session (header bar with
  sleep/resume/interrupt/force-stop — no "delete" button here,
  deletion goes through the sidebar context menu to require a
  deliberate right-click; see §10), reconnect/disconnect/error
  banners, scroll-reverse chat + **↓/↑ scroll pills** (↓ = go to
  bottom, hidden if already at bottom; ↑ = go up to the last user
  message above the view, fixed above ↓, stays visible as long as
  we're not at the absolute top or pagination still has messages to
  load), ThinkingBar, input bar with mode-switch,
  QuestionCard/ExitPlanCard/InlinePermissionCard when pending, and
  the ToolPanel). Consumes `useClaudeSessionStream`. ClaudePanel
  instantiates it with `key={selectedId}` to re-mount on session
  change (module-level cache makes the switch instant). Mobile
  mirror in `app/m/chat/MobileChat.tsx`: same pills
  (`m-scroll-pill` / `m-scroll-up-pill`).

---

## 12. Auth, crypto, session

- **Single-user**: `users` contains 1 row, created from
  `MASTER_PASSWORD` + `MASTER_SALT` at seed time.
- **Login**: the `/login` page validates the password via scrypt,
  creates a `sessions` row (24h sliding TTL), sets the
  `charon_session` cookie.
- **`middleware.ts`**: on every non-`_next`/`favicon`/`/login`/
  `/api/sync` request: validates the cookie. Non-auth API → 401.
  Otherwise redirect `/login`.
- **`lib/server/auth.ts`**: `createSession`/`getSession`/`touchSession` helpers.
- **`lib/server/session.ts`**: `requireSession()` (server components),
  `requireApiSession()` (API routes).
- **`lib/server/crypto.ts`**: AES-256-GCM, scrypt-derived key. Used
  to encrypt what needs to be encrypted in DB (little currently).

---

## 13. Security

- The agent's Unix socket is `chmod 600`; no additional auth
  between Charon and the agent — possession of the SSH key =
  authorization.
- The agent **listens on no network port**; everything goes through SSH.
- The agent typically runs as root (existing model). No new privesc
  introduced.
- `SYNC_TOKEN`: for `/api/sync` (Bearer). Rotate via `.env`.
- Secrets (`.env`) must **never** be committed. `MASTER_PASSWORD`,
  `MASTER_SALT`, `SESSION_SECRET` are critical.
- **Session cookie** (`charon_session`): `httpOnly: true`,
  `sameSite: 'lax'`,
  `secure: process.env.NODE_ENV === 'production'`. Modify both
  places that set it: `middleware.ts` (refresh) and
  `app/login/actions.ts` (initial creation).
- **HTTP headers** (see `next.config.mjs`): `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  (prod only). No CSP — Next inlines SSR scripts without a nonce, a
  strict CSP would break SSR. To be implemented with SSR nonce if
  ever needed.
- **Shell injection**: every `filePath`/`cwd` interpolated into an
  `sshExec` command must go through `shQuote()` (see §14 gotcha 11).

---

## 14. Known gotchas

1. **`next build --turbopack` breaks `next start` on 15.5.18** → site
   without CSS/JS (404 on `/_next/static/*`). Build without turbopack
   in prod.
2. **`.next` polluted by a dead `next dev`** → `next start` loops on
   "Could not find a production build". `rm -rf .next && next build`.
3. **Drizzle snapshot missing at commit** → migrations can diverge.
   Always commit `drizzle/*.sql` AND `drizzle/meta/`.
4. **`color` added twice** (migrations 0003 and 0004) — the second
   is inert but stays as a marker not to reproduce.
5. **Agent out of date**: if `vps.agentPyzSha !== getBuiltPyzSha()`,
   the UI must offer the update button
   (`POST /api/vps/[id]/agent/update`). Don't forget to bump
   `__version__` in `agent/charon_agent/__init__.py` when touching
   the protocol.
6. **`claude login` is per-VPS** (no shared global OAuth), via
   `<LoginConsole>` (xterm SSH `-tt`).
7. **`alwaysAllow` permissions are in memory** hub-side (per
   session, per tool) — lost on Charon restart. By design:
   permanent retention goes through `permission_mode='auto'`.
8. **better-sqlite3 + Next**:
   `serverExternalPackages: ['better-sqlite3']` is mandatory in
   `next.config.mjs`. Without it, SSR crashes.
9. **SQLite WAL**: 3 files (`.db`, `.db-shm`, `.db-wal`). All
   critical. `PRAGMA foreign_keys=ON` enabled at boot.
10. **`--turbopack` removed from the `"build"` script** (see §3).
    If you reintroduce it in `package.json` — or if you run
    `next build --turbopack` manually — the site will serve its
    HTML with no CSS or JS. Marker: `.next/turbopack` and
    `turbopack-*.js` chunks present.
11. **SSH injection**: every `filePath`/`cwd`/slug interpolated
    into an `sshExec` command **must go through `shQuote()`**
    (exported from `lib/server/claude/sshExec.ts`). Quoting `"$x"`
    is not enough — `$`, `` ` ``, `\\` and `\n` go through.
    shQuote uses POSIX single quotes which are opaque to anything
    but `'`.
12. **Module-level signal handlers**: `sessionOps.ts` registers
    `SIGTERM`/`SIGINT` at import. It's guarded by
    `process.env.NEXT_PHASE !== 'phase-production-build'` to avoid
    `process.exit(0)` during `next build` (which imports modules
    for SSR analysis and receives signals between workers). If you
    add other global handlers at server module import, apply the
    same guard.
13. **SDK `interrupt` does not cancel an in-flight tool**. The SDK
    sends a signal but `receive_response()` stays blocked until
    the current operation finishes. To really cut, use `force_stop`
    (forced cancel of the agent main task, status → `sleeping`
    immediately, resume possible). The button exists in the
    desktop header and the mobile menu. Implemented in agent
    v0.3.0 — if a VPS is on 0.2.0, the UI will show *agent out of
    date*.
14. **Charon-side SSE is live-only — no ring buffer**. On mount /
    reconnect / foreground return, the client must refetch via GET
    `/api/claude/sessions/[id]` (the DB is source of truth).
    Before, SessionStream maintained a 200-event ring buffer
    replayed on every SSE subscribe, BUT the client did a GET
    anyway → events processed twice (race + duplicates in
    history). We removed everything: no ring buffer, no
    `history_begin/end` markers. If you add a new view, **do a GET
    first** — SSE alone is not enough (it only does live).
15. **SSE architecture = a single multiplexed stream per browser**.
    The pattern is: 1 EventSource on `/api/claude/events`
    (singleton `app/globalEventStream.ts`), mutable focus via POST
    `/focus`. No per-session EventSource, no close/reopen on
    switch. Why: the browser caps at 6 connections per origin in
    HTTP/1.1 (Apache in front of Charon doesn't have HTTP/2
    enabled), and close/reopen on switch costs 50-150ms of visible
    latency. Server-side, the `subscribeGlobalSessionEvents` bus
    receives ALL events tagged with sessionId; the
    `eventConnections` registry filters by focus before sending to
    the client. **If you add a hook that wants to listen to server
    events, don't create an EventSource — subscribe to the global
    stream via `subscribeSession(sid, cb)` or `subscribeAll(cb)`**.
16. **Low-volume vs high-volume events**. The server classifies
    events into 2 categories (see `eventConnections.ts` §
    LOW_VOLUME_EVENTS): low-volume (status, mode_changed, ready,
    session_id, permission_request, user_question,
    exit_plan_request, interaction_resolved, error) → sent to all
    connections. High-volume (assistant_text, tool_use,
    tool_result, edit_snapshot, todo_update, thinking, user_echo,
    stop, prefill_input, reconnecting) → only to the focus
    connection. If you add a new event to the protocol, classify
    it explicitly into one of the two categories or it will be
    high-volume by default.
17. **Per-token re-render = laggy streaming**. `assistant_text`
    arrives token by token (100+/sec on Claude Sonnet 4.6). If you
    `setState` on every token, you re-render the subtree 100x/sec.
    `useClaudeSessionStream` batches via `requestAnimationFrame`
    (60Hz max). Don't make the same mistake if you add another
    text stream.
18. **Pessimistic acks on interactions**. `respondPermission` /
    `respondQuestion` / `respondExitPlan` wait for the POST OK
    before removing the card from the queue (before: it was
    optimistic, the UI cleared but if the POST failed, the card
    came back on reload and caused confusion). Unless you have a
    good reason, keep this pattern.
19. **`cmd &;` is a bash syntax error**. If you join a list of
    shell commands with `'; '` and one of the commands ends with
    `&` (background), you produce `cmd & ; next` which trips the
    parser: `bash: -c: syntax error near unexpected token ';'`.
    The real gotcha encountered: `bootstrap.ts §
    installAgentService` was doing `[...].join('; ')` on a nohup
    fallback with a `nohup ... &` in the middle — install was
    silently failing on every fresh VPS where systemd-user was
    unavailable. **Fix**: join with `\n` rather than `'; '` when
    an item can end with a `&`.
20. **`'...\\'...'` does NOT work in bash**. Inside a
    single-quoted string, the backslash is **literal** — you
    can't escape a single quote. The valid POSIX pattern is
    `'...'\''...'` (close, escape, reopen). If you must build a
    command containing a string with `'`s, **base64-encode it**
    instead of quoting (see `bootstrap.ts § installAgentService`
    for the crontab line — base64 bytes → `base64 -d` VPS-side).
21. **systemd-user "Failed to connect to bus" on fresh VPS**. On
    a VPS where root has never had an interactive session,
    `systemctl --user` can't find the dbus bus
    (`/run/user/$UID/bus`). `enable-linger` alone isn't enough —
    you need to **force-start the user manager** with
    `systemctl start user@$(id -u).service` BEFORE the
    `daemon-reload`. Otherwise the bootstrap falls back to nohup
    (which works, but loses systemd's benefits: auto-restart,
    append:log, etc.).
22. **Install sessions = in-memory pool, shell pattern**. An
    install session (`lib/server/install/installSession.ts`) is
    created when the user clicks "install agent" on a VPS. It
    wraps `bootstrapVps()`, broadcasts events to SSE subscribers
    and to the global bus (`subscribeInstallBus`). Max 1 per VPS
    — a 2nd `startInstall(vpsId)` while one is already running
    returns the existing one. On Charon restart: everything is
    lost (in memory). The `install_started` / `install_finished`
    events are classified low-volume → broadcast to all
    connections of the multiplexed SSE to feed
    `<InstallNotificationPopup>`.
23. **SSH failure = abort the whole bootstrap**. Before: if
    `tryVerify()` hit an SSH timeout/refusal/auth, it returned
    `reason: 'other'` and `bootstrapVps()` proceeded to
    `install_sdk` (which re-SSH-failed after 4 minutes of pip
    timeout). Now: `detectSshFailure(r: SshResult)` in
    `bootstrap.ts` recognizes patterns `ssh: connect to host`,
    `Host key verification failed`, `Permission denied (...)`,
    `kex_exchange_identification`, `Could not resolve hostname`,
    and the `[timeout]` sentinel injected by `sshExec`. On a
    match: `tryVerify` returns `reason: 'ssh'` with a readable
    message, and `bootstrapVps` yields `verify: error` + `done:
    error` immediately. If you add a new phase in `bootstrapVps`,
    **call `detectSshFailure` on each `sshExec` result** (see the
    5 existing phases that already do it) — otherwise the gotcha
    returns.
24. **Chats stuck after `systemctl restart charon`**. The SIGTERM
    handler in `sessionOps.ts` just flushes assistant buffers: it
    doesn't touch DB statuses. Consequence: a session that was in
    `'thinking'` at restart time stays `'thinking'` in DB. The
    bug had TWO halves:

    **Backend half**: `autoConnect` only resumed sessions with
    `status='active'` — those in `'thinking'`/`'starting'` were
    ignored, their `SessionStream` never re-attached to the agent
    listener, and the UI showed an eternal spinner. The user had
    to do `force_stop` then `resume` by hand for
    `resumeSession()` to redo the `stream.attach()`. **Fix**: (a)
    `autoConnect` now covers
    `active`/`thinking`/`starting` via `inArray`, and (b) an
    `onStatus('connected')` hook calls
    `reconcileVpsAgentState(vpsId, hello.sessions)` on every SSH
    (re)connection, which uses the session list reported by
    `hello` as source of truth and (re-)attaches a SessionStream
    for each one. Idempotent and executed on every network
    reconnect too. See `lib/server/agent/autoConnect.ts` +
    `lib/server/agent/sessionOps.ts § reconcileVpsAgentState`.

    **Frontend half**: even when the backend resumes streaming,
    the browser didn't refetch the history missed during the SSE
    drop. The SSE is live-only Charon-side (see gotcha 14);
    messages persisted in DB during the gap are not relayed.
    `useClaudeSessionStream` refetched on mount and on
    `visibilitychange` but NOT on SSE reconnect — the user saw
    their chat frozen and had to refresh the page. **Fix** in
    `app/globalEventStream.ts`: `EventSource.onopen` counts opens;
    from the 2nd on (= reconnect), (i) re-POST
    `/api/claude/focus` with the current focus — the EventSource's
    original URL uses a fixed `?focus=` that the browser's
    auto-reconnect replays, which can overwrite the server focus
    if the user has switched session in the meantime —, and (ii)
    notifies the `subscribeReconnect` listeners.
    `useClaudeSessionStream` subscribes and triggers
    `refetchHistory()` → the UI updates itself. If you add
    another hook that maintains state synced with the server DB,
    **subscribe it to `subscribeReconnect` too** otherwise it
    will stay frozen after a backend restart.
25. **`edit_snapshot` and `event` drown `claudeSessionMessages`**. An
    "active" session writes 4 rows per Edit (1 tool_use + 1
    tool_result + 2 before/after snapshots). With 240 Edits → 480
    snapshots. A naive `-200` slice on the table then returned 186
    snapshots + 14 events = 0 messages visible in the chat
    (user/assistant/tool_use shifted out of the window). **Fix**
    (`app/api/claude/sessions/[id]/route.ts § loadMessageWindow`):
    the limit ONLY COUNTS "chat" roles (`NON_PAGINATED_ROLES =
    ['edit_snapshot', 'event']` is filtered out). Snapshots/events
    are loaded as attachments by ID range (`gte(minId), lte(maxId)`)
    because they are emitted temporally between `tool_use` and
    `tool_result`. If you add a new "side-channel" role (e.g. a
    log invisible chat-side), **add it to `NON_PAGINATED_ROLES`**
    otherwise it will consume window slots.
26. **Scroll-up pagination = cursor by `id`, not by index**. The
    client triggers `loadMoreHistory()` when scroll goes below
    400px from the visual top (column-reverse:
    `scrollHeight - clientHeight - |scrollTop| < 400`). The hook
    sends `GET ?before=<oldestChatId>&limit=200` and PREPENDs the
    result. The browser handles scroll anchoring natively when we
    append to the end of the DOM (= visual top in column-reverse),
    so **0 manual scrollTop manipulation**. Safeguards in
    `useClaudeSessionStream`: `loadMoreInflightRef` prevents
    concurrent calls, `hasMore=false` + cursor null disable
    further loadMores. **Note**: a `refetchHistory()`
    (visibilitychange, doResume) RESETS the cursor to the most
    recent window — extended pages are lost both state-side AND
    cache-side (see `sessionCache.fetchAndCache` which replaces
    the entry). Acceptable because visibilitychange is rare; the
    user just scrolls again. For `edits` at merge time: we NEVER
    overwrite an existing entry with an older one of the same
    `file_path` (the live/recent one wins — otherwise we'd lose
    the current diff when loading an earlier Edit on the same
    file).
27. **Post-bootstrap: persist `agentPyzSha` immediately**. The DB
    `vps.agentPyzSha` is normally updated by `AgentClient` on
    `hello` (see `AgentClient.ts § hello`). But this hello
    arrives **lazy** — only when someone asks to use the agent
    (`AgentClientPool.get(vpsId)`), typically at the 1st Claude
    session creation. So after a successful bootstrap, the DB
    keeps the old `agentPyzSha` (often `null`), the UI computes
    `agentOutOfDate=true` and offers "update agent" when we just
    installed the right one. **Fix**: `bootstrapVps` writes
    directly to the DB after the successful `ping_agent` phase
    (duplicates the `AgentClient.hello` code but it's
    intentional — consistent state right after bootstrap ends).
    Client-side, the `install_finished` handler in `ClaudePanel`
    also patches `agentPyzSha: builtPyzSha` locally (by
    construction the pyz we just deployed is the embedded
    version).
28. **`python -m venv` can fail on "ensurepip is not available"** —
    typical of Debian/Ubuntu where the venv module lives in a
    separate OS package (`python3.12-venv` on Ubuntu 24.04,
    `python3.11-venv` on Debian 12, etc.). When the VPS already
    has a python installed but without its venv package, `verify`
    returns `no_sdk` (python found, SDK missing) so the
    `install_python` phase is SKIPped — its `apt-get install
    python3-venv` is never executed. We go straight to
    `install_sdk` and venv blows up with a message like *"The
    virtual environment was not created successfully because
    ensurepip is not available"*. The old `--without-pip` +
    `ensurepip --upgrade` fallback does NOT work in this case
    (`ensurepip --upgrade` depends on exactly the module that's
    missing).

    **Subtle twist**: when ensurepip fails, `python -m venv`
    leaves a **partial venv** behind — the directory exists and
    `bin/python` IS dropped (as a symlink), but pip never got
    installed. So a naive check `[ ! -x ${VENV_PY} ]` is false
    and any retry would skip the venv-creation block entirely,
    then crash on `pip install` with *"No module named pip"*.
    Equally fatal: the first attempt's recovery branch was gated
    on `[ ! -x ${VENV_PY} ]`, so it didn't fire on the first run
    either (since bin/python had been created).

    **Fix** in `bootstrap.ts § install_sdk`: the health check is
    `${VENV_PY} -m pip --version`, not `[ -x ${VENV_PY} ]`. If
    pip doesn't work we (a) wipe `${VENV_DIR}`, (b) retry
    `python -m venv`, (c) if pip is *still* broken AND the log
    mentions ensurepip (or bin/python exists but pip doesn't),
    we `apt-get install -y python$PY_VER-venv` (then fallback
    `python3-venv`) with/without `sudo -n`, (d) wipe + recreate.
    For dnf: `dnf install python$PY_VER`. Final gate verifies
    both bin/python AND pip work; otherwise exit 11 with an
    explicit message. The whole block is idempotent and
    self-healing across retries. If you discover another
    distro/package to cover (Alpine: `py3-virtualenv` for
    example), add a branch in the `if command -v ...`
    condition.
29. **kill→delete refactor: no more "soft-kill"**. History: there
    were `sleep` (reversible pause), `kill` (status `'killed'`
    non-resumable but history kept), and `hardDelete` (DB
    cascade). The header's "pause" button actually called `kill`
    → UX false friend. The merge `kill` ⊕ `hardDelete` →
    definitive deletion (1 single destructive action, with
    `confirm()`) leaves only `sleep` as a reversible state.
    **The DB status `'killed'` no longer exists**; migration
    0008 purged the remnants. **The `status='killed'` event**
    survives only as a transient signal emitted at deletion time
    to notify active SSEs — the `useClaudeSessionStream` hook
    catches it and triggers `onKilled` (= navigation out of
    session). Associated gotchas:
    - If you reintroduce an intermediate status ("archived",
      "frozen", etc.), **don't use `'killed'`** as the name — it
      has a transient meaning and would break the hook.
    - The TS enum `WorkerStatus` still keeps `'killed'` to type
      the transient signal. Don't remove it.
    - Python agent-side (`charon_agent/server.py § kill_session`),
      the RPC removes the session from the dict AND from
      state.json. Charon-side this happens at the right moment
      since we cascade the DB in parallel — but it's
      best-effort: if the agent is down, we have an orphan
      agent-side (SDK session still alive, cleaned up at the
      next agent restart since there's no Charon row → ignored
      by `reconcileVpsAgentState`).
    - If you add a new "kill agent-side but keep the UI" action,
      don't go in circles — that's exactly what we removed. Ask
      yourself: "is `sleep` enough?" Spoiler: yes.
30. **Multi-phase SSH flows MUST multiplex over a single
    `SshSession`**. Every `sshExec()` call spawns a fresh `ssh`
    process — without multiplexing each phase pays a full
    TCP+SSH handshake (200-2000ms of latency per phase, more on
    high-RTT links). Worse: a long phase like `install_sdk`
    (apt-get + pip, 60-180s) can leave the VPS in a state where
    the *next* fresh handshake hits `Connection timed out`
    (observed in the wild after the venv recovery code triggers
    `apt-get install python3.12-venv`). Likely causes: sshd
    `MaxStartups` rate-limit, `conntrack` saturation, fail2ban,
    machine in swap, etc. The handshake never gets to send a
    SYN-ACK in time and the 10s `ConnectTimeout` fires.

    **Fix** (`lib/server/claude/sshExec.ts`):
    `openSshSession(vps)` / `closeSshSession(session)` +
    `opts.session` on `sshExec`. Under the hood, ControlMaster
    + ControlPath + ControlPersist=120 — the first call opens
    the master, all subsequent calls piggyback on the same TCP.
    `bootstrapVps` and `updateVpsAgent` both wrap their whole
    flow in a `try { ... } finally { closeSshSession(...) }`.
    The socket file lives at `tmpdir()/charon-ssh-<8hex>.sock`
    (~30 chars, well under the 108-char `sun_path` limit on
    Linux). If the master crashes mid-flow, `ControlMaster=auto`
    transparently opens a new one — degraded but functional.

    **If you add a new multi-phase SSH flow**, follow the same
    pattern. Single one-shots (`shell.ts`, `claudeLoginCheck.ts`,
    etc.) don't need it — the overhead doesn't matter for one
    SSH connection. Threshold to start caring: ≥3 sequential
    `sshExec` to the same VPS within a few seconds.

| Question | File(s) |
|---|---|
| List of API routes | `app/api/**/route.ts` |
| Client-side fetch wrapper | `lib/api.ts` |
| API request/response types (per method) | `lib/types/api.ts` |
| DB schema | `lib/db/schema.ts` |
| SQL migrations | `drizzle/*.sql` + `drizzle/meta/_journal.json` |
| JSON-RPC protocol (TS) | `lib/server/agent/types.ts` |
| JSON-RPC protocol (Py) | `agent/charon_agent/protocol.py` |
| One session agent-side | `agent/charon_agent/session.py` |
| RPC dispatch agent-side | `agent/charon_agent/server.py` |
| SSH connection + JSON-RPC client | `lib/server/agent/AgentClient.ts` |
| Bridge events ↔ DB ↔ SSE | `lib/server/agent/sessionOps.ts` |
| Reconnect / pool | `lib/server/agent/AgentClientPool.ts` |
| `claude login` check (SSH + DB) + 24h TTL variant | `lib/server/agent/claudeLoginCheck.ts` |
| VPS install phases | `lib/server/claude/bootstrap.ts` |
| SSH one-shot exec + multiplexing session | `lib/server/claude/sshExec.ts` |
| Install session pool (in-memory, ring buffer) | `lib/server/install/installSession.ts` |
| Install routes | `app/api/installs/**` + `app/api/vps/[id]/installs/route.ts` |
| Full-screen install log view | `app/InstallSessionView.tsx` |
| Top-right "install OK/failed" popup | `app/InstallNotificationPopup.tsx` + `app/useInstallNotifications.ts` |
| Copy/open URL overlay in xterm terminals | `app/TerminalUrlOverlay.tsx` + `app/useTerminalUrlOverlay.ts` + `app/terminalUrlDetect.ts` |
| Desktop UI state machine | `app/ClaudePanel.tsx` |
| Client-side SSE handlers | `app/ClaudePanel.tsx` (`es.onmessage`) + `app/useClaudeSessionStream.ts` (used by MobileChat) |
| React session hook (SSE + state + actions + loadMoreHistory pagination) | `app/useClaudeSessionStream.ts` |
| History scroll-up pagination (backend) | `app/api/claude/sessions/[id]/route.ts § loadMessageWindow` |
| React cross-session feed hook (other sessions' perms in real time) | `app/useCrossSessionInteractionFeed.ts` |
| Desktop chat area (consumes the hook) | `app/ClaudeSessionView.tsx` |
| Shared desktop/mobile types | `app/sessionTypes.ts` |
| Rebuild a session's state from DB messages | `app/sessionRebuild.ts` |
| Module-level cache of a session | `app/sessionCache.ts` |
| Per-session textarea drafts (preserved on switch, cleared on F5) | `app/inputDraftStore.ts` (hook `useInputDraft`) |
| Py↔TS protocol alignment check (prebuild script) | `scripts/check-protocol-sync.mjs` |
| Markdown / tool cards | `app/Message.tsx` |
| Diffs / todos / tools | `app/ToolPanel.tsx` |
| Permission popup | `app/PermissionPopup.tsx` |
| AskUserQuestion form | `app/QuestionCard.tsx` |
| ExitPlanMode UI | `app/ExitPlanCard.tsx` |
| VPS sidebar | `app/Sidebar.tsx` |
| VPS organization folders (DnD + collapse) | `lib/db/schema.ts` (`vpsFolders`), `app/api/vps-folders/**`, `app/DataModal.tsx` (DnD), `app/Sidebar.tsx` (grouped rendering) |
| Mobile | `app/m/**` |
| Auth (cookie, scrypt) | `lib/server/auth.ts`, `lib/server/session.ts` |
| pyz build | `agent/build.sh` |
| Boot init (seed + autoConnect) | `lib/server/seed.ts` |
| Data migration v2 → sleeping | `lib/server/migrationV2.ts` |

---

## 16. Commands to know

```bash
# Dev
npm run dev                                # turbopack dev, 127.0.0.1:10556

# Prod (on the server)
npx next build                             # WITHOUT --turbopack!
systemctl restart charon
journalctl -u charon -f

# DB
npm run db:generate                        # after editing schema.ts
npm run db:migrate                         # apply
sqlite3 data/charon.db                     # inspect

# Agent
bash agent/build.sh                        # → agent/dist/charon-agent.pyz
python3 -m charon_agent                    # daemon locally
./agent/dist/charon-agent.pyz --connect    # stdio↔sock proxy mode

# On a VPS (debug)
ssh root@<ip> systemctl --user status charon-agent
ssh root@<ip> tail -f .charon/agent.log
echo '{"id":1,"method":"ping"}' | ssh root@<ip> ~/.charon/charon-agent.pyz --connect
```

---

## 17. When you touch the repo

**Reminder**: if one of these changes alters a fact documented
here, **update this CLAUDE.md in the same commit** (see top
banner).

- **Modify the JSON-RPC protocol**: edit
  `agent/charon_agent/server.py` (dispatch + handlers),
  `agent/charon_agent/protocol.py` (METHODS set),
  `lib/server/agent/types.ts` (TS mirror, **`AgentMethodName` AND
  `AgentEvent` unions**), `lib/server/agent/AgentClient.ts` (the
  method wrapper), and bump `agent/charon_agent/__init__.py`
  `__version__`. Rebuild the `.pyz` (`bash agent/build.sh`) → the
  SHA will change → all VPSes will appear "out of date" in the UI
  until you push the update.
  **→ Update §6 (methods/events) and bump the version.**
  **Automatic safeguard**: `scripts/check-protocol-sync.mjs` is
  run by `npm run build` (prebuild). It compares the Python
  `METHODS` set to the TS `AgentMethodName` union; on drift, the
  build fails with a message pointing to the missing names. No
  need to remember, **the build will remind you**.
- **Add an event**: `_emit("new_event", session_id=..., ...)` in
  `session.py`, add the type in `lib/server/agent/types.ts` and
  the handler in `sessionOps.ts` then in `ClaudePanel.tsx`.
  **→ Add the line to the §6 (events) and §9 (SSE mapping)
  tables.**
- **New DB field**: edit `lib/db/schema.ts`, `npm run db:generate`,
  check the SQL, `npm run db:migrate`, commit the `.sql` and the
  snapshot. **→ Add the migration to the §4 timeline and the
  field to the table detail.**
- **New API route**: create the `route.ts`, add the wrapper in
  `lib/api.ts`. **→ Add the line to the §8 catalog.**
- **New UI component**: prefer editing an existing one (no
  duplication). Most UI state lives in `ClaudePanel.tsx`.
  **→ Add the component to the §11 table if it's a major
  component, and to the Quick lookup §15.**
- **Permissions / SDK hooks**: everything goes through
  `agent/charon_agent/session.py` (`_pre_tool_use`,
  `_post_tool_use`, `_can_use_tool`, `_is_safe_bash`). That's
  where we whitelist/blacklist.
- **Infra change** (systemd unit, reverse proxy, VPS paths, env
  vars): **→ Update §3 (systemd), §3 (.env), §5 (VPS files), and
  add a gotcha in §14 if it's subtle.**
- **Newly discovered footgun**: **→ §14 without hesitation.**
  Warn future agents before they walk into it.

---

Safe travels. When in doubt, also read
`docs/adr-001-charon-agent.md` which explains the **why** of the
architecture choices.
