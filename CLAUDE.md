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
- Persistent SSH shells (xterm.js) in addition to Claude sessions — the
  terminal runs inside a `tmux` session on the VPS, so it survives Charon
  restarts and a human can `tmux attach` to the same session from the server
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
├── app/                  # Next.js App Router (UI + API)
│   ├── api/              # API routes (see §8)
│   ├── m/                # mobile routes (/m, /m/select, /m/chat, /m/shell)
│   ├── login/            # login page (master password)
│   ├── ClaudePanel.tsx   # main desktop UI (~1400 lines, state machine)
│   ├── ClaudeSessionView.tsx, useClaudeSessionStream.ts, useCrossSessionInteractionFeed.ts
│   ├── TabBar.tsx, Sidebar.tsx, ToolPanel.tsx, Message.tsx, DataModal.tsx
│   ├── globalEventStream.ts  # singleton SSE conn — see §14 gotcha 15/24
│   ├── sessionTypes.ts, sessionRebuild.ts, sessionCache.ts, inputDraftStore.ts
│   ├── *Modal.tsx, *Popup.tsx, *Card.tsx  # modals/popups/forms
│   ├── LoginConsole.tsx, ShellTerminal.tsx, TerminalUrlOverlay.tsx, terminalUrlDetect.ts
│   ├── *.css             # globals.css, claude.css, agent-ui.css
│   └── layout.tsx, page.tsx, icon.svg
├── lib/
│   ├── api.ts            # API client (fetch wrappers)
│   ├── types/api.ts      # per-method request/response types
│   ├── db/{schema.ts, index.ts}  # Drizzle + better-sqlite3 (WAL, FK ON)
│   └── server/
│       ├── agent/        # AgentClient, AgentClientPool, sessionOps, autoConnect,
│       │                 # eventConnections, builtPyzSha, claudeLoginCheck, types
│       ├── claude/       # bootstrap.ts (install phases), sshExec.ts, types.ts
│       ├── shell/        # persistent SSH shells (tmux on VPS + node-pty attach)
│       ├── install/installSession.ts  # in-memory install pool
│       ├── auth.ts, session.ts, crypto.ts
│       └── seed.ts, migrationV2.ts
├── agent/                # Python daemon (zipapp .pyz, ~36KB)
│   ├── charon_agent/{__main__, server, session, state, protocol, client, __init__}.py
│   ├── build.sh → dist/charon-agent.pyz
│   └── README.md
├── drizzle/              # generated SQL migrations + meta/
├── scripts/{migrate.mjs, check-protocol-sync.mjs}
├── docs/adr-001-charon-agent.md
├── data/charon.db        # SQLite WAL
├── middleware.ts         # auth gate + /login redirect
├── next.config.mjs, tsconfig.json, drizzle.config.ts, package.json
└── /etc/systemd/system/charon.service  (outside the repo)
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

### ⚠ Build rules (see §14 gotchas 1-3 for details)

- **Always chain `npm run build && systemctl restart charon`.** A bare build leaves the running `next-server` serving stale chunk hashes → browser MIME errors / `ChunkLoadError`.
- **Never `next build --turbopack` in prod.** On 15.5.18, `next start` 404s `/_next/static/*`. The `"build"` script stays plain. Dev (`"dev"`) keeps turbopack.
- **If `.next` is polluted** (dead `next dev`, half-built artifacts → no `BUILD_ID`): `systemctl stop charon && rm -rf .next && npm run build && systemctl start charon`. Marker for the turbopack variant: `turbopack-*.js` chunks present, no `static/css/`.

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
serverExternalPackages: ['better-sqlite3', 'node-pty'],  // native modules — otherwise SSR breaks
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
| `claudeSessions` | `id` PK, FK `vpsId` | Claude sessions (status, mode, cwd, name, color, claudeSessionId, lastSeenSeq, lastStopNotifiedSeq) |
| `claudeSessionMessages` | autoincrement, FK `sessionId` | history (role, content, createdAt) |
| `claudePendingPermissions` | `id` PK, FK `sessionId` | pending tool gates |
| `claudePendingQuestions` | `id` PK, FK `sessionId` | `kind` = `question` (AskUserQuestion) or `exit_plan` |
| `claudeSessionLogs` | autoincrement | per-session audit / debug |
| `claudeSettings` | `key` PK | key/value settings (telegram token, VAPID, etc.) |
| `claudePushSubs` | `id` PK, UNIQUE `endpoint` | Web Push endpoints |
| `shells` | `id` PK, FK `vpsId` | persistent SSH shells. The terminal lives in a `tmux` session `charon-<id>` on the VPS; this row is just the index Charon uses to re-list/re-attach after a restart. `tmuxName`, `cwd`, `name`, `color`. Cascade `vps → shells`. |

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
| 0009 | renames the default folder from 'Sans dossier' to 'No folder' for legacy deployments (idempotent UPDATE — no-op if already renamed or user-renamed). |
| 0010 | adds 5 hot-path indexes: `claude_session_messages(session_id, id)`, `claude_pending_permissions(session_id, status)`, `claude_pending_questions(session_id, status)`, `claude_session_logs(session_id, id)`, `vps_paths(vps_id)`. SQLite doesn't auto-index FKs, so every `WHERE session_id = ?` was a full scan before this. The compound `(session_id, id)` matches the chat window / delta polling / pagination queries (filter by session then range over id). `CREATE INDEX IF NOT EXISTS` for idempotency. Hand-written (drizzle-kit generated noisy redeclarations of existing tables — keeping the schema source-of-truth in TS via the `(t) => [index(...)]` form). |
| 0011 | `claude_sessions` += `last_seen_seq` (integer, nullable). Checkpoint of the highest agent-event-log `seq` Charon has persisted; used on reconnect via `subscribe({after_seq})` so the agent replays durably-stored events that fell out of the in-memory ring (agent >= 0.4.0). Null = no checkpoint yet → fallback to `replay: 300` ring tail. Hand-written. |
| 0012 | `claude_sessions` += `last_stop_notified_seq` (integer, nullable). Dedup guard for the "Claude finished" push: the `stop` handler in `sessionOps.ts` previously had NO replay guard (unlike permission/question/exit_plan, which check `isReplaying && replayKnownPendingIds`), so every agent re-subscribe (Charon reboot, SSH reconnect) replayed past `stop` events and re-pushed a duplicate "finished" notification for each session. Now: skip push while `isReplaying`; otherwise only push a stop whose `seq` > this column, then advance + persist it (survives restarts so the dedup is durable). Agents < 0.4.0 (no `seq`) fall back to the `isReplaying` guard alone. Hand-written. |
| 0013 | creates the `shells` table (`id`, `vps_id` FK→`vps` CASCADE, `tmux_name`, `cwd`, `name`, `color`, `created_at`) + index `idx_shells_vps_id`. Backs the persistent-shells refactor: SSH shells used to be in-memory only (one ssh child per shell, lost on any Charon restart); the terminal now lives in a remote `tmux` session and this row is the index for re-listing/re-attaching. Hand-written (drizzle-kit emits noisy table redeclarations; schema source-of-truth stays in TS). |
| 0014 | `claude_sessions` += `model` / `fallback_model` / `effort` (all text, nullable). Per-session Claude config (agent >= 0.5.0). `model` / `fallback_model` are free strings (e.g. `claude-opus-4-7-...`, `claude-opus-4-8-...`); `effort` is one of `low` / `medium` / `high` / `xhigh` / `max` (mirrors `claude_agent_sdk.EffortLevel`). NULL = inherit the global default from `claudeSettings` (`claude.default_model`, `claude.default_fallback_model`, `claude.default_effort`), which itself can be empty → SDK default. **The resolved value is PERSISTED at session-create time** (not re-read from settings later) so a later change to the global default doesn't retroactively alter existing sessions — surprising behavior we explicitly avoid. Changes via `setModel` / `setEffort` take effect at the NEXT SDK start (sleep + resume): the underlying `ClaudeSDKClient` binds model/effort at construction. Hand-written. |

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
~/.charon/charon-agent.pyz      # the daemon (~52KB since 0.4.0)
~/.charon/agent.sock            # Unix socket (chmod 600)
~/.charon/state.json            # persisted sessions (atomic write)
~/.charon/agent.log             # stdout/stderr append-only
~/.charon/events/<sid>.jsonl    # durable per-session event log (>= 0.4.0)
~/.charon/events/<sid>.jsonl.1  # rotated chunk, oldest first (.1 = previous)
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
  (see §6). Ring buffer `RING_SIZE = 2000` events per session
  (`deque(maxlen=2000)`), broadcast via
  `subscribers: dict[session_id, set[Client]]`. State save is debounced
  (`schedule_save()`, 0.2s). The 2000 ceiling covers ~20-40s of high-
  throughput streaming (deltas arrive ~50-100/sec during a response),
  which is well above any expected Charon `systemctl restart` window
  (was 300 before agent 0.3.1, which saturated in ~3-6s).
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
- **`event_log.py`** (>= 0.4.0): durable per-session event log at
  `~/.charon/events/<sid>.jsonl`. Every event emitted by the server
  gets a monotonic per-session `seq` and `ts` attached, then is appended
  to disk BEFORE the in-memory ring buffer and the live broadcast.
  Rotation: 10 MB per file × 3 rotations (~30 MB worst case per session).
  Charon checkpoints the highest seq it has persisted in
  `claude_sessions.last_seen_seq` and passes it as
  `subscribe({after_seq})` on reconnect → the agent replays exactly
  what Charon missed, regardless of whether the ring still holds it.
  Orphan logs (sessions deleted while the agent was offline) are
  cleaned up at boot. Failure modes (disk full, corrupt line) log to
  stderr and continue — the ring is the in-memory fallback for live
  subscribers.
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

### Methods (16)

| Method | Params | Result |
|---|---|---|
| `hello` | `{}` | `{agent_version, agent_pyz_sha, sdk_available, sdk_error, pid, sessions:[SessionInfo]}` |
| `ping` | `{}` | `{pong:true, ts}` |
| `list_sessions` | `{}` | `[SessionInfo]` |
| `start_session` | `{session_id?, cwd, name?, permission_mode?, claude_session_id?, model?, fallback_model?, effort?}` | `{session_id}` — `model` / `fallback_model` are free strings (e.g. `claude-opus-4-8-...`); `effort` ∈ `low\|medium\|high\|xhigh\|max`. All three optional; absent → SDK default. Forwarded to `ClaudeAgentOptions`. Old agents (< 0.5.0) silently ignore the new fields. |
| `subscribe` | `{session_id, replay?:int, after_seq?:int}` | `{ok, replay_count, status, current_seq}` + replay events. `after_seq` (>= 0.4.0) wins over `replay` if both supplied — durable replay from `event_log.jsonl`. `replay` falls back to the ring tail for legacy clients. `current_seq` lets callers checkpoint even when the replay was empty. |
| `unsubscribe` | `{session_id}` | `{ok}` |
| `send_input` | `{session_id, content}` | `{ok}` |
| `interrupt` | `{session_id}` | `{ok}` — soft, may be ignored by the SDK if a tool is in flight |
| `force_stop` | `{session_id}` | `{ok}` — forced cancel: status `sleeping` immediately, resume possible (see §14 gotcha 13) |
| `set_permission_mode` | `{session_id, mode}` | `{ok, mode}` |
| `set_model` | `{session_id, model: str\|null, fallback_model?: str\|null}` | `{ok, model, fallback_model, applied_at_next_start}` — agent >= 0.5.0. Changes are DEFERRED: the live `ClaudeSDKClient` cannot swap models (bound at construction). `applied_at_next_start: true` iff a client is currently running → takes effect on next sleep+resume. Pass `null` to clear back to the global default. |
| `set_effort` | `{session_id, effort: 'low'\|'medium'\|'high'\|'xhigh'\|'max'\|null}` | `{ok, effort, applied_at_next_start}` — agent >= 0.5.0. Same deferred-apply semantics as `set_model`. Invalid values are silently dropped agent-side. |
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

All carry `session_id`. The ring buffer stores up to 2000 per session (was 300 before agent 0.3.1). Since agent 0.4.0, all events (except replay markers `replay_begin` / `replay_end`) also carry `seq` (monotonic per-session integer) and `ts` (Unix seconds, float) added by the durable event log before broadcast. Charon persists the highest seq into `claude_sessions.last_seen_seq` and replays from there on resubscribe.

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
| `model_changed` | `{model: str\|null, fallback_model: str\|null, applied_at_next_start: bool}` — agent >= 0.5.0. Charon persists to `claude_sessions.model` / `.fallback_model`; UI labels the badge as deferred when `applied_at_next_start=true`. |
| `effort_changed` | `{effort: 'low'\|'medium'\|'high'\|'xhigh'\|'max'\|null, applied_at_next_start: bool}` — agent >= 0.5.0. Persisted to `claude_sessions.effort`. |
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

- **No ring buffer on the Charon side**: the multiplexed browser SSE only
  does **live**. On mount / reconnect / foreground return, the client does
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
the work: for each session the agent knows about, it `getOrCreateStream()`
+ `ensureAttached()` + sync DB status. For each DB session "should be
running" that the agent does NOT know about (= the agent was restarted
and lost its state.json), it relaunches via `resumeSession()` (which
falls back to `start_session(claude_session_id=…)`).

**Naming convention**: `sessionOps.ts` exposes two lookups — `peekStream`
(returns null if not in memory; use for READ endpoints) and
`getOrCreateStream` (hydrates from DB if absent; use for WRITE / lifecycle
endpoints). `getStream` is kept as a deprecated alias to
`getOrCreateStream` for transitional code only.

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
- `GET|POST /api/claude/settings` — `ALLOWED_KEYS` in `app/api/claude/settings/route.ts` gates writes. Includes `claude.default_model`, `claude.default_fallback_model`, `claude.default_effort` (used by `startNewSession` to resolve per-session config when the caller doesn't override — see §14 gotcha 35).
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
- `POST /api/vps/[id]/agent/refresh` — manual "reconnect" for a VPS shown as `error`. Two-phase: (1) drop + recreate the `AgentClient` and await a fresh `hello` (bypasses the up-to-5min reconnect backoff, daemon untouched → safe for a live agent with in-flight turns); (2) only if (1) fails, `ensureAgentRunning(vps)` **starts the daemon if it isn't already running** (proxy exit 2 = socket absent = daemon dead) then reconnects. Never `restart`s a live daemon. Persists + returns a definitive `agentStatus` (`{ ok, agentStatus, agentVersion?, agentPyzSha?, error? }`). Client wrapper uses a 50s timeout (the route can take ~40s worst case). See §14 gotcha 34.
- `GET /api/vps/[id]/claude/scan` — Claude sessions found on disk (for import)
- `POST /api/vps/[id]/claude/check-login` — re-checks `claude config get oauth.refresh_token` via SSH + persists `vps.claudeLoggedIn` in DB. Triggered: (1) on `LoginConsole` close UI-side, (2) automatically by `autoConnect` on every `connected` event of an `AgentClient` if `claudeLoggedIn` is null or `claudeLoggedInCheckedAt` older than 24h (TTL). The SSH+DB logic lives in `lib/server/agent/claudeLoginCheck.ts` (`refreshClaudeLoginStatus` + `refreshClaudeLoginStatusIfStale`) to be shared between the route and the auto-check.
- `GET|POST|DELETE /api/vps/[id]/login` — manage `claude login`
- `GET /api/vps/[id]/login/stream` — SSE TUI
- `POST /api/vps/[id]/login/input` — stdin

### Persistent SSH shells (tmux-backed)

The terminal runs inside a `tmux` session named `charon-<id>` on the VPS.
Charon attaches over `ssh -tt … tmux new-session -A -s charon-<id>` driven by
**node-pty** (so `TERM` + the window size forward correctly — fixes htop/vim
"terminal unknown" + gives live resize). The attach is ephemeral and lazily
(re)spawned; the durable terminal is the tmux session. See
`lib/server/shell/shellSession.ts`.

- `GET|POST /api/shells` — list all / (POST unused; create is per-VPS below)
- `GET|PATCH|DELETE /api/shells/[id]` — PATCH name/color (persisted in DB). **DELETE** = `tmux kill-session` on the VPS + drop the row (the shell really ends).
- `GET /api/shells/[id]/stream` — SSE (replays the in-memory ring; on a fresh attach the first output is tmux's full-screen redraw)
- `POST /api/shells/[id]/input` — `{content}` → written to the node-pty attach
- `POST /api/shells/[id]/resize` — `{cols, rows}` → `pty.resize()` → SIGWINCH through SSH → tmux client resizes. Sent by `ShellTerminal` on open + on every xterm `onResize` (deduped on unchanged dims). Like `/input`, consumed via raw fetch (no `api.ts` wrapper).
- `POST /api/vps/[id]/shells` — create a shell on this VPS (`{cwd?}`). Inserts the `shells` row, best-effort `tmux` install, spawns the attach.
- `GET /api/vps/[id]/shells` — list this VPS's shells (DB-backed → survives restart).

Persistence: on Charon boot, `reconcileShellsOnBoot()` (called from
`seedInitialData`, i.e. on first page SSR) SSHes each VPS that has shell rows
and **prunes rows whose tmux session is gone** (inner shell exited / VPS
rebooted). An SSH-level failure (unreachable) leaves rows untouched. Live
sessions are re-attached lazily when a browser opens the shell.

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
- `POST /api/claude/sessions` — create. Body: `{ vpsId, cwd, name?, permissionMode?, model?, fallbackModel?, effort? }`. The three Claude config fields are optional; empty/null inherits the global default (`claude.default_*` in `claudeSettings`). The resolved values are persisted into the session row at creation (a later change to the global default does not retroactively alter existing sessions — see §14 gotcha 35).
- `POST /api/claude/sessions/import` — from scan
- `GET|PATCH|DELETE /api/claude/sessions/[id]` — GET supports `?limit=N` (default 200, cap 1000) and `?before=K` (cursor pagination for scroll-up). The limit only counts "chat" roles (user/assistant/tool_use/tool_result/user_question/exit_plan_request/thinking); `edit_snapshot` and `event` are loaded as attachments by ID range (see §14 gotcha 25). Response: `{ messages, hasMore, oldestChatId, ... }` — `oldestChatId` serves as cursor for the next loadMore. **DELETE** = definitive deletion (DB cascade + best-effort agent kill) — no more `?hard=1`, no more soft-kill (see §10).
- `GET /api/claude/events?conn=<uuid>[&focus=<sid>]` — **single multiplexed SSE**: opened ONCE per browser tab, persistent. Emits initial `status` for all sessions + all pendings + live stream filtered by focus. Session focus changes are handled via POST `/focus` without SSE reconnect.
- `POST /api/claude/focus` — Body `{ conn, sessionId }`. Changes the focus of an SSE connection. The server starts/stops streaming the high-volume events (assistant_text, tool_use, tool_result, edit_snapshot, todo_update, thinking, user_echo, stop, prefill_input, reconnecting) of the targeted session. Low-volume events (status, perms, questions, exit_plans, interaction_resolved, mode_changed, error, ready, session_id) are always sent to all connections.
- `POST /api/claude/sessions/[id]/input` — `{content}` or `{type:'interrupt'}`
- `POST /api/claude/sessions/[id]/permission` — `{id, allow, always?}`
- `POST /api/claude/sessions/[id]/question` — `{id, answers}`
- `POST /api/claude/sessions/[id]/exit-plan` — `{id, decision, feedback?}`
- `POST /api/claude/sessions/[id]/mode` — `{mode}`
- `POST /api/claude/sessions/[id]/model` — `{model: string|null, fallbackModel?: string|null}`. Empty/null clears back to the global default. Routes to agent's `set_model`; takes effect at next sleep+resume (cf. §14 gotcha 35 on deferred apply).
- `POST /api/claude/sessions/[id]/effort` — `{effort: 'low'|'medium'|'high'|'xhigh'|'max'|null}`. Invalid values rejected 400. Same deferred-apply semantics as `/model`.
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

## 9. Browser-side SSE + polling (event mapping)

The browser opens ONE singleton
`EventSource('/api/claude/events?conn=<uuid>[&focus=<sid>]')` via
`app/globalEventStream.ts`. It stays open for the lifetime of the tab.
Switching sessions does **not** reconnect the SSE: the client calls
`POST /api/claude/focus` to update which session receives high-volume
events.

Server-side, `SessionStream` in `sessionOps.ts` persists agent events to
SQLite, emits them on the global session bus, and
`lib/server/agent/eventConnections.ts` filters them:

- Low-volume events (`status`, interactions, `mode_changed`, `error`,
  `ready`, `session_id`) are broadcast to every tab connection.
- High-volume events (`assistant_text`, `tool_use`, `tool_result`,
  `edit_snapshot`, `todo_update`, `thinking`, `user_echo`, `stop`,
  `prefill_input`, `reconnecting`) are sent only to the connection whose
  focus is that session.

The SSE is **live-only** on the Charon side. On mount, reconnect, foreground
return, and every 5s while visible, `useClaudeSessionStream` also calls
`GET /api/claude/sessions/[id]` or
`GET /api/claude/sessions/[id]?since=<lastSeenServerId>`. SQLite is the
source of truth for browser catch-up; SSE is the low-latency fast path.

Client-side (`useClaudeSessionStream.ts`), the routing:

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
| `model_changed` | updates per-session `model`/`fallbackModel` state in `useClaudeSessionStream`; `appliedAtNextStart=true` flips `modelPendingApply` so the header badge shows ⏳ (deferred change). Reset on full refetch. |
| `effort_changed` | same as `model_changed` but for `effort` / `effortPendingApply`. |
| `todo_update` | updates the `todos` tab of `ToolPanel` |
| `edit_snapshot` | stored in `edits` Map (before/after per filePath) for `ToolPanel`/`SplitDiffModal` |
| `stop` | final flush, ready for the next turn |
| `error` | error banner; detects "import error" → offers bootstrap |
| `prefill_input` | pre-fills the textarea |
| `replay_begin/end` | agent-side replay markers consumed by `sessionOps.ts`; not sent to the browser SSE |

Note: `permission_request`/`user_question`/`exit_plan_request`/
`interaction_resolved` arrive through the same singleton SSE, but are
consumed in two places:

1. `useClaudeSessionStream` subscribes to the focused session and keeps the
   inline queue visible in the active chat.
2. `useCrossSessionInteractionFeed` uses `subscribeAll()` from
   `globalEventStream.ts` and keeps the cross-session popup/banner queues.

The two client states are independent display queues fed by the same global
event stream. The GET payload also returns pending interactions, so a missed
SSE still self-heals on refetch/poll.

---

## 10. Typical user journey (golden path)

1. `/` → SSR `app/page.tsx`: `requireSession()` (cookie or redirect `/login`), `seedInitialData()` (v2 migration if needed + `autoConnectAgents()`), loads VPS/paths/sessions/`builtPyzSha`, renders `<ClaudePanel>`.
2. ClaudePanel mount → singleton SSE (`globalEventStream`) opens, focus on selected session.
3. New session: `<NewSessionDialog>` → `POST /api/claude/sessions` → `sessionOps.startNewSession()` → INSERT row (status `starting`) → `AgentClient.start_session()` → agent creates `AgentSession` wrapping `ClaudeSDKClient(cwd, hooks, can_use_tool, resume?)` → `stream.attach()`.
4. UI gets `status=starting` → `ready` → `session_id` (claude_session_id persisted).
5. User types → `POST /input` → agent's `send_input` → `_stdin_queue.put` → `ClaudeSDKClient.query`.
6. Events stream `assistant_text` × N, optional `thinking`, then `tool_use`. If permission needed (mode `normal` + tool not auto-safe), the `_pre_tool_use` hook creates a Future and emits `permission_request` (10min timeout); UI `PermissionPopup` → `respond_permission` → Future resolves → tool runs → `tool_result`.
7. `stop` ends the turn.

### Resume after Charon restart

`autoConnect.ts` covers DB sessions in `active`/`thinking`/`starting`. The `onStatus('connected')` hook on every `AgentClient` calls `reconcileVpsAgentState()` on every SSH (re)connect — uses agent's `hello` as source of truth to re-attach SessionStreams. Sessions not present in the agent are restarted via `start_session(claude_session_id=...)` to resume from on-disk history. The V2 one-shot migration moved any leftover `active` → `sleeping` after the original refactor. Details: §14 gotcha 24.

### Sleep / delete (kill→delete refactor)

Two actions: **`sleep`** (`agent.stop(mark='sleeping')`, DB → `sleeping`, `claude_session_id` kept, resume possible) and **`delete`** (`POST /api/claude/sessions/[id]` DELETE → `deleteSession()`: emits transient `status='killed'` event, detaches stream, DB cascade, best-effort `kill_session` RPC). DB status `'killed'` no longer exists (purged by migration 0008). Details: §14 gotcha 29.

### Importing an existing session

`GET /api/vps/[id]/claude/scan` → agent enumerates `~/.claude/projects/...`. `<ResumeModal>` import creates a `claudeSessions` row (status `sleeping`, `claudeSessionId` filled) without `start_session`. The Resume button later does `start_session(claude_session_id, cwd)`.

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

### `ClaudePanel.tsx` — key state

`ClaudePanel` is now mostly the desktop shell/orchestrator:

- `selectedId`, `selectedShellId`, `selectedInstallId`: mutually exclusive
  current main view.
- `sessions`, `shells`, `installs`: sidebar/tab data, refreshed via API
  calls and global SSE install/session events.
- VPS/folder/path lists: mutable copies of the SSR payload, patched by
  `DataModal` and install/login callbacks.
- Global modals/popups: settings, search, VPS data, resume/import, install
  notifications, login console, context menu.
- Cross-session pending interactions: fed by
  `useCrossSessionInteractionFeed()` over the singleton global SSE.
- Push/service-worker integration: notification taps update the URL/session
  selection.

Per-session chat state no longer lives in `ClaudePanel`. It lives in
`useClaudeSessionStream`, consumed by `<ClaudeSessionView key={selectedId}>`.
That hook owns `messages`, `currentAssistant`, `status`, `permissionMode`,
`toolCalls`, `todos`, `edits`, `files`, pending queues, `assistantBufRef`,
history refetch, delta polling, and stream event handling.

### Secondary components

Most components are self-describing by filename (`app/PermissionPopup.tsx`, `QuestionCard.tsx`, `ExitPlanCard.tsx`, `SearchModal.tsx`, `SettingsModal.tsx`, `Sidebar.tsx`, `Message.tsx`, `ToolPanel.tsx`, etc.). Notable behaviors that aren't obvious from reading the file:

- **`Sidebar.tsx`**: folder `collapsed` state in DB (`PATCH /api/vps-folders/[id]`), per-VPS collapsed in localStorage. "+ Claude session" and "History" are disabled when `agentStatus !== 'ok'`; SSH shell + install agent remain available. Agent action button depends on status: `missing`/`unknown` → "▸ install agent"; `error` → "↻ refresh agent" (reconnect, see §14 gotcha 34) + quiet "reinstall" fallback; `ok` + out-of-date → "⇪ update agent".
- **`TabBar.tsx`**: 2-row VSCode-style strip above the main column (own grid row `tabs`). **Row 1** = VPSes with at least one open entity, in sidebar order; click switches "active VPS". **Row 2** = entities of the active VPS only. Border-top colors: green=active, amber=starting, amber-pulse=thinking, orange-pulse=waiting, grey+italic=sleeping. Only non-active tabs get a × (purely local — entity stays in DB/sidebar; permanent delete goes through the sidebar context menu). Right of row 2: "+ Claude" and "+ SSH" buttons, cwd computed by `defaultCwdFor(vpsId)` (rightmost tab's cwd → fallback `Vps.defaultPath`). "+ Claude" disabled when `agentStatus !== 'ok'`. Active VPS derived from selected entity (`useMemo`), with `lastSelectedByVpsRef` to restore last entity on tab switch. `keptOpenIds` is local. No drag-reorder. Helper `computeTabs(...)` returns `{ vpsTabs, entitiesByVps, flat }`.
- **`DataModal.tsx`**: drag-and-drop via `@dnd-kit` for folders + VPSes (intra/cross-folder). Drag-end → atomic `POST /api/vps-folders/layout`.
- **`SessionContextMenu.tsx`**: for Claude sessions, only "Delete permanently" (no intermediate "kill" since the refactor — see §10). For shells/installs, "Close".
- **`InstallSessionView.tsx`**: full-screen install log (fills `.claude-main`), SSE on `/api/installs/[id]/stream` (ring buffer replay + live). Replaces the old `BootstrapBanner`.
- **`LoginConsole.tsx` / `ShellTerminal.tsx`**: xterm.js terminals; both wire their SSE into `useTerminalUrlOverlay` to detect wrapped URLs and offer copy/open (`terminalUrlDetect.ts` regex handles newlines + up to 4 spaces of wrap; 60-char threshold). `ShellTerminal` also POSTs its dimensions to `/api/shells/[id]/resize` on open + on every `onResize` (fit-driven), so the remote tmux client matches the browser. It's shared by desktop (`ClaudePanel`) and mobile (`app/m/shell/MobileShell.tsx`), so both get persistence + resize for free.

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

- **`sessionTypes.ts`**: shared types (`Msg`, `ToolCallEntry`, `Todo`, `EditSnapshot`, `PermissionRequest`, `PendingQuestion`, `PendingExitPlan`). `sessionId` required everywhere.
- **`sessionRebuild.ts`** (`rebuildStateFromMessages`): rebuilds session state from persisted messages (mount / switch / tab return).
- **`sessionCache.ts`**: module-level session cache (`getCached`, `fetchAndCache`, `prefetchAll`, `invalidate`). `app/m/chatCache.ts` is a back-compat re-export.
- **`inputDraftStore.ts`** (hook `useInputDraft`): in-memory `Map<sessionId, string>` for textarea drafts, persists across session switches on desktop AND mobile. Cleared on F5 (by design).
- **`useClaudeSessionStream.ts`**: wraps singleton-SSE subscription + DB refetch/polling + state + actions for one session. State: `messages`, `currentAssistant`, `status`, `permissionMode`, `toolCalls`, `todos`, `edits`, `files`, `permQueue`, `questionQueue`, `exitPlanQueue`, `prefillInput`, `error`, `sessionMeta`, pagination flags. Actions: `send`, `interrupt`, `forceStop`, `setMode`, `doSleep`, `doResume`, `doDelete`, `respondPermission`/`Question`/`ExitPlan`, `refetchHistory`, `clearError`, `clearPrefillInput`, `loadMoreHistory`.
- **`useCrossSessionInteractionFeed.ts`**: subscribes to `subscribeAll()` from `app/globalEventStream.ts` for all sessions' perm/question/exit_plan/resolved events. Dedup by `id`. Feeds the cross-session `<PermissionPopup>` (desktop) and the "X pending on other sessions" banner (mobile). It does not open another EventSource.
- **`ClaudeSessionView.tsx`**: chat area of the active session (header sleep/resume/interrupt/force-stop — NO delete button; deletion via sidebar right-click), reconnect/error banners, scroll-reverse chat with ↓/↑ pills, ThinkingBar, input bar + mode switch, QuestionCard/ExitPlanCard/InlinePermissionCard, ToolPanel. Consumes `useClaudeSessionStream`. ClaudePanel instantiates with `key={selectedId}`; module-level cache makes switch instant. Mobile mirror: `app/m/chat/MobileChat.tsx`.

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

1. **`next build --turbopack` breaks `next start` (15.5.18)** → 404 on `/_next/static/*`. Marker: `turbopack-*.js` chunks present, no `static/css/`. Fix: `systemctl stop charon && rm -rf .next && npm run build && systemctl start charon`.
2. **`.next` polluted by a dead `next dev`** → `next start` loops on *"Could not find a production build"*. Same fix as #1.
3. **Always restart `charon` after `npm run build`**: a fresh build rewrites `static/` hashes; the live `next-server` keeps serving its old manifest → browser asks dead chunk hashes → MIME `text/html` errors. Chain `npm run build && systemctl restart charon`.
4. **Drizzle**: commit `drizzle/*.sql` AND `drizzle/meta/`. Snapshot drift = migrations diverge.
5. **`color` column** was added twice (migration 0003 + 0004). 0004 is a no-op marker — don't reintroduce real SQL there, create a new migration.
6. **Agent out of date**: if `vps.agentPyzSha !== getBuiltPyzSha()`, UI offers the update button (`POST /api/vps/[id]/agent/update`). Bump `__version__` in `agent/charon_agent/__init__.py` on protocol changes.
7. **`claude login` is per-VPS** (no shared OAuth). Goes through `<LoginConsole>` (xterm SSH `-tt`).
8. **`alwaysAllow` is in-memory hub-side** (per session, per tool) — lost on Charon restart. By design: permanent retention = `permission_mode='auto'`.
9. **Native modules + Next**: `serverExternalPackages: ['better-sqlite3', 'node-pty']` mandatory in `next.config.mjs`. Otherwise SSR crashes / Next tries to bundle the `.node` binary. Both are compiled against the running Node ABI (see gotcha 33).
10. **SQLite WAL** = 3 files (`.db`, `.db-shm`, `.db-wal`), all critical. `PRAGMA foreign_keys=ON` set at boot.
11. **SSH injection**: every `filePath`/`cwd`/slug interpolated into `sshExec` MUST go through `shQuote()` (`lib/server/claude/sshExec.ts`). POSIX single quotes only — `"$x"` is not enough.
12. **Module-level signal handlers in `sessionOps.ts`**: SIGTERM/SIGINT guard with `process.env.NEXT_PHASE !== 'phase-production-build'` to avoid `process.exit(0)` during `next build`. Apply the same guard to any new global handler.
13. **SDK `interrupt` does NOT cancel in-flight tools** — `receive_response()` stays blocked. Use `force_stop` instead (forced cancel, status → `sleeping`, resume possible). Agent ≥ v0.3.0.
14. **Charon-side SSE is live-only — NO ring buffer.** On mount / reconnect / foreground return the client MUST refetch via GET `/api/claude/sessions/[id]` (DB is source of truth). If you add a new view, **GET first** — SSE alone misses history.
15. **One multiplexed SSE per browser**: singleton on `/api/claude/events` (`app/globalEventStream.ts`), focus via POST `/focus`. No per-session EventSource (HTTP/1.1 caps at 6 conns/origin; close/reopen on switch = 50-150ms latency). New hooks: subscribe via `subscribeSession(sid, cb)` / `subscribeAll(cb)`, don't open another EventSource.
16. **Low-volume vs high-volume events** (`eventConnections.ts § LOW_VOLUME_EVENTS`): low-volume (status, mode_changed, ready, session_id, perm/question/exit_plan requests, interaction_resolved, error) → broadcast to all conns. High-volume (assistant_text, tool_use, tool_result, edit_snapshot, todo_update, thinking, user_echo, stop, prefill_input, reconnecting) → focus conn only. Classify every new event explicitly.
17. **Per-token re-render = laggy streaming**. `assistant_text` arrives 100+/sec; `setState` per token re-renders 100×/sec. `useClaudeSessionStream` batches via `requestAnimationFrame` (60Hz). Do the same for any new streaming source.
18. **Pessimistic acks on interactions**: `respondPermission` / `respondQuestion` / `respondExitPlan` wait for POST OK before clearing the queue card (optimistic version caused phantom cards on POST failure). Keep the pattern.
19. **`cmd &;` is a bash syntax error**. Joining shell commands with `'; '` and one ends with `&` produces `cmd & ; next` → parser fails. Use `\n` as separator when any item can end with `&`. Bit by `bootstrap.ts § installAgentService` (nohup fallback).
20. **No `\'` inside single quotes in bash**: backslash is literal. Use the POSIX pattern `'...'\''...'` (close-escape-reopen), or base64-encode the payload (see `bootstrap.ts` crontab line).
21. **systemd-user "Failed to connect to bus" on fresh VPS**: `enable-linger` alone isn't enough — force-start the user manager with `systemctl start user@$(id -u).service` BEFORE `daemon-reload`. Otherwise bootstrap falls back to nohup.
22. **Install sessions are in-memory, max 1 per VPS** (`lib/server/install/installSession.ts`). A 2nd `startInstall(vpsId)` returns the existing one. Lost on Charon restart. `install_started`/`install_finished` are low-volume → fed to `<InstallNotificationPopup>` via the global SSE.
23. **SSH failure → abort bootstrap**. `detectSshFailure(SshResult)` in `bootstrap.ts` recognizes ssh connect/auth/host-key errors + `[timeout]` sentinel. Every new bootstrap phase MUST call it on each `sshExec` result, otherwise we waste 4 min on a doomed `install_sdk` after a verify failure.
24. **Chats stuck / "had to refresh to see new messages"**. The chain of fixes here is long because we ran into the same class of bug — "the SSE was supposed to deliver but didn't" — at four different layers. Read this before tweaking ANY of the live-update code path.

    **Layer 1 — Backend (agent ↔ Charon reconnect)**: SIGTERM doesn't touch DB statuses → sessions in `'thinking'` stay `'thinking'`. `autoConnect` covers `active`/`thinking`/`starting`, AND an `onStatus('connected')` hook calls `reconcileVpsAgentState(vpsId, hello.sessions)` on every SSH (re)connect — uses agent's `hello` as source of truth to re-attach SessionStreams. Idempotent.

    **Layer 2 — Frontend (SSE gap)**: `app/globalEventStream.ts` re-POSTs `/api/claude/focus` on `EventSource.onopen` from the 2nd open onward, and notifies `subscribeReconnect` listeners. `useClaudeSessionStream` subscribes → triggers `refetchHistory()`.

    **Layer 3 — Frontend (browser SSE reconnect is unreliable)**: on a 502 during the restart window, `readyState=CLOSED` and the browser never reconnects. `globalEventStream.ts` runs (a) `onerror`-driven manual reconnect with exponential backoff (1→2→4→8→15s), (b) a 4s liveness watchdog (force reconnect if no event in 20s), (c) reconnect on `online`/`visibilitychange`. Heartbeat is a typed `data: {"type":"heartbeat",...}` event sent every 8s (NOT an SSE comment — comments are JS-invisible to JavaScript). `connId` stays stable across reconnects (server dedupes by it).

    **Layer 4 — Frontend (don't rely on the SSE at all)**: even with all of the above, the SSE is fundamentally fragile — React 19 hydration errors trigger "regenerate entire root", which runs every useEffect cleanup, which removes the `subscribeReconnect` listeners. When the SSE then reconnects, there is no one to fire `refetchHistory()`, and the chat stays frozen on whatever state it had at the React error. We could keep patching individual hydration culprits, but it's whack-a-mole.

    **Final design — defense in depth via polling**:
    - SSE remains the fast path (sub-second latency when it works).
    - **`useClaudeSessionStream` runs a 5s polling loop that is independent of the SSE.** The loop runs `safetyTick`, which is SELF-SUFFICIENT: if the initial full load hasn't succeeded yet (`initialLoadDoneRef` false — e.g. the mount-time refetch raced a Charon restart and 503'd), it does a full `refetchHistory` (retry); once that has produced data it switches to a cheap `GET /api/claude/sessions/[id]?since=<lastSeenServerId>` delta (returns ONLY rows with id > since, sorted ASC). This matters: an earlier version bailed the poll on `since === 0`, so a FAILED initial load left polling permanently disabled and the chat frozen until F5 even though the interval was "running". Now the loop always makes forward progress on its own — it does NOT depend on the SSE or the SSE-triggered refetch ever succeeding.
    - **The poll is a cheap PROBE; when it reports new rows the client does a CLEAN FULL `refetchHistory()`, NOT an incremental merge.** This is the single most important correctness decision in the whole saga. Incremental merging (the old `applyDelta`, now dead code kept for reference) produced corrupted state — duplicate React keys, partial tool_use/tool_result pairs — that threw during render, which the error boundary caught and remounted, which re-ran the poll, which re-corrupted… an infinite remount loop (symptom: `[charon] poll xxx: +N row(s)` repeating with the SAME `since` value, deep `uE/ux` render stacks). A full reload rebuilds the entire chat from scratch via `rebuildStateFromMessages` — exactly what hitting F5 does, and corruption-proof. A `[charon] poll <sid>: +N row(s) since X → clean reload` line is logged when this fires.
    - **The polling cursor is the server's authoritative `maxMessageId`, NOT the max id of the returned window.** The window (`loadMessageWindow`) returns the last 200 CHAT messages + only the `edit_snapshot`/`event` attachments in THAT id range; a busy session accumulates thousands of trailing attachment rows whose ids are HIGHER than the last chat message. If the cursor is the window max, `?since=<windowMax>` returns those thousands of rows on EVERY poll forever (cursor never advances → the remount loop above). The `[id]` GET route returns `maxMessageId = MAX(id) WHERE session_id = ?` across ALL roles; `applyApiData` sets the cursor to it (monotonic — never rewinds). Verified: a real session had `maxMessageId=30589` vs `windowMax=27323`, a 3266-row gap that was being re-fetched every 5s.
    - **The error boundary escalates to `window.location.reload()`** if it catches ≥4 errors within 8s (`SessionErrorBoundary § LOOP_THRESHOLD`). A deterministic render error re-throws on every remount, so remounting is futile — the only thing that always recovers is a clean page load. This is the literal "simulate the manual refresh" nuclear fallback. With the cursor + clean-reload fixes above the loop shouldn't happen, but this guarantees recovery if some other deterministic render bug appears.
    - Triggers for an immediate (non-interval) poll: SSE reconnect, `visibilitychange` (tab returns), `online` event. The setInterval also fires once on mount so session-switch resyncs immediately.
    - 404 from the delta endpoint → calls `onKilled` (= session was deleted server-side and we missed the `status='killed'` SSE event).

    **Invariants** if you touch ANY of these layers:
    - SSE liveness: (1) heartbeat is a JS-visible `data:` event; (2) watchdog threshold ≥ 2× heartbeat interval; (3) `connId` stable across manual reconnects (otherwise the server piles up zombie connections). Debug: `getStreamHealth()`.
    - Polling: (1) `applyDelta` MUST be idempotent — same delta applied twice should produce the same state; (2) `lastSeenServerIdRef` is advanced BEFORE setState so a setState throw doesn't cause re-fetching the same rows; (3) dedup against SSE-added messages is by `(role, content)` — if you change the synthetic-id format in `rebuildStateFromMessages`, also update the `idStr.startsWith('m')` check in `applyDelta`; (4) don't poll for sleeping/killed sessions in the future — for now we poll always (the cost is negligible and it caught a "session resumed by another tab" bug for free); (5) phantom-buffer clear: if `serverStreamingText === ''` AND `assistantBufRef.current` is a prefix of (or equal to) the content of a new assistant row in the delta, we clear `assistantBufRef` + `currentAssistant`. Without this, an SSE drop mid-stream + server-side flush leaves the streaming preview visible alongside the finalized DB message. If you refactor the assistant-text flow (e.g. switch to a different buffer container), keep this check or the phantom returns.
    - Network resilience (the device-sleep class of bug): **every `fetch` MUST be bounded by a timeout** (`lib/api.ts § send` wraps an `AbortController`, default 30s, 12s for the delta poll). A request issued just before the device sleeps (laptop lid, phone background) does NOT reject — the socket is suspended, so the promise hangs until the OS finally tears it down (minutes). A hung promise wedges any inflight-dedup guard built on top of it (`sessionCache.inflight`, `useClaudeSessionStream.inflightPollRef`) → polling silently stops → chat frozen. The timeout frees the guard; on wake (`online`/`visibilitychange`) the hook calls `forcePoll()` which **aborts the in-flight (hung) poll via `pollAbortRef` and starts a fresh one** so resync is ~1s, not 12s. The SSE side mirrors this: `scheduleReconnect` bails out when `navigator.onLine === false` and waits for the `online` event instead of burning the backoff schedule against a dead network.
    - Both `/api/claude/sessions` and `/api/claude/sessions/[id]` GET are wrapped in try/catch → a transient DB hiccup returns a clean retryable **503** (logged server-side), never an unhandled 500. An unhandled 500 serves an HTML error page, which breaks the client's `res.json()` and can cascade into a stuck UI. DB has `busy_timeout=5000` for the rare multi-process lock.
    - **Error boundary (`app/SessionErrorBoundary.tsx`) wraps `<ClaudeSessionView>` (desktop) and `<MobileChat>` (mobile page).** This is the universal safety net: the entire live-update pipeline (SSE subscription, 5s polling interval, reconnect listener) lives inside `useClaudeSessionStream`, which runs inside the chat subtree. If ANY render in that subtree throws — React 19 hydration mismatch (#418), a transient `undefined` while data is mid-flight, a bad markdown/diff parse — React unmounts the subtree, which fires every `useEffect` cleanup, which kills the polling interval + SSE subscription. Without a boundary that is a PERMANENT freeze (only F5 recovers). The boundary catches the error, shows a "reconnecting…" placeholder, and **remounts the subtree after ~1.5s by bumping an internal key** → all effects re-run → `lastSeenServerIdRef` resets to 0 → `refetchHistory` does a full reload → chat self-heals. It also resets on `resetKey` change (sessionId) so switching sessions never inherits a stale error. Keep this boundary; it is what makes "render bug ⇒ auto-recover" instead of "render bug ⇒ frozen until refresh".
    - **SSE `onerror` policy** (`globalEventStream.ts`): reconnect manually ONLY on `readyState === CLOSED` (browser gave up, e.g. after a 502). On `CONNECTING` (transient blip, truncated stream) DO NOTHING — the browser auto-retries, and the watchdog + polling are the backstops. An earlier version tore down on every error including CONNECTING; combined with resetting `backoffMs` in `onopen`, that produced a pathological open→break→reopen loop every 1000ms during network instability (hammering the server, firing refetch every second). Fix: `backoffMs = 0` lives in `onmessage` (reset on real data) NOT `onopen` (which only means the HTTP response started). Don't move it back.
    - Don't remove the polling because "SSE seems to work now." Polling IS the contract that the chat will not freeze. SSE is just the latency optimisation on top.

25. **`edit_snapshot` and `event` rows drown chat in `claudeSessionMessages`** (4 rows per Edit). The window query at `app/api/claude/sessions/[id]/route.ts § loadMessageWindow` counts ONLY chat roles (`NON_PAGINATED_ROLES = ['edit_snapshot', 'event']`); side-channel rows load as attachments by ID range. Add any new side-channel role to `NON_PAGINATED_ROLES`.
26. **Scroll-up pagination = cursor by `id`** (`?before=<oldestChatId>&limit=200`). Triggers when scroll < 400px from visual top (`scrollHeight - clientHeight - |scrollTop| < 400` in column-reverse). Prepends; browser anchors natively — no manual `scrollTop` math. `refetchHistory()` RESETS the cursor (extended pages lost — acceptable, visibilitychange is rare). On `edits` merge: never overwrite a recent entry with an older one for the same `file_path`.
27. **Post-bootstrap: persist `agentPyzSha` immediately in DB**. `AgentClient` updates it on `hello`, but `hello` is lazy (1st session creation). So `bootstrapVps` writes directly after `ping_agent` success (duplicates `AgentClient.hello` code intentionally). Client-side, `install_finished` handler in `ClaudePanel` patches `agentPyzSha: builtPyzSha` locally.
28. **`python -m venv` fails on "ensurepip is not available"** (Debian/Ubuntu: `python3.12-venv` etc. is a separate package). On a VPS with python but no venv package, `verify` returns `no_sdk` → `install_python` is skipped → `install_sdk` blows up. Worse: a failed `python -m venv` leaves a **partial venv** with `bin/python` present but no pip — a naive `[ -x venv_py ]` check passes. Fix in `bootstrap.ts § install_sdk`: health check is `venv_py -m pip --version`; if pip fails, wipe + retry, install `python$PY_VER-venv` if log mentions ensurepip, wipe + retry. Idempotent across retries. Add a branch if you cover a new distro.
29. **kill→delete refactor**: only `sleep` is reversible now. DB status `'killed'` no longer exists (purged by migration 0008). The `status='killed'` event survives ONLY as a transient signal at deletion time — `useClaudeSessionStream` catches it → `onKilled` (navigate out). Implications: (a) don't reuse `'killed'` for a new persistent status; (b) keep the TS enum member (types the signal); (c) agent-side `kill_session` is best-effort cleanup; (d) if tempted to add a new "kill but keep UI" action, ask "is `sleep` enough?" — yes.
30. **Multi-phase SSH = multiplex over one `SshSession`**. Each `sshExec` spawns a fresh `ssh` (200-2000ms handshake) AND a long phase can wedge the VPS into refusing the next connection (sshd MaxStartups, conntrack, fail2ban…). `openSshSession(vps)`/`closeSshSession()` + `opts.session` use ControlMaster/ControlPath/ControlPersist=120 (socket at `tmpdir()/charon-ssh-<8hex>.sock`). `bootstrapVps` and `updateVpsAgent` wrap their whole flow in `try { ... } finally { closeSshSession() }`. Threshold to start caring: ≥3 sequential `sshExec` to the same VPS.
31. **Agent event replay layering** (agent >= 0.4.0). Two complementary mechanisms now coexist:
    - **Ring buffer** (`RING_SIZE = 2000`, `server.py`): in-memory, fast path for `subscribe({replay: N})` (legacy clients). Lost on agent restart.
    - **Durable event log** (`event_log.py`): per-session JSONL at `~/.charon/events/<sid>.jsonl` with monotonic `seq`, rotated at 10MB × 3. Used for `subscribe({after_seq})` (Charon >= the one shipping this gotcha). Survives agent restart. Cleaned up at boot for sessions absent from `state.json`, on `kill_session` for the session being deleted.

    **Invariants** if you touch the event-log code:
    - `_emit` MUST append to the log BEFORE the live broadcast — otherwise subscribers see events without `seq`, defeating Charon's checkpoint.
    - `_recover_seq` scans both the active file AND all rotated files for the max seq. Don't "optimize" it to only scan active: a rotation-then-crash window leaves the highest seq in `.1`, not active.
    - Charon-side checkpoint (`SessionStream.lastSeenSeq` ⇄ `claude_sessions.last_seen_seq`) is throttled: persist on landmark events (`status`, `stop`) and on a 2s debounce otherwise. Worst-case 2s of duplicate replay on Charon crash — absorbed by `_loadReplayDedup`.
    - `AgentClient._pendingAfterSeq` caches the cursor between reconnects. The reconnect path (`_onConnected`) re-issues `subscribe` via `_fireSubscribe(sid)` which reads from this map. Don't bypass with a raw `this.call('subscribe', ...)` — you'd lose the cursor.
    - Replay markers (`replay_begin`, `replay_end`) intentionally lack `seq`. `_trackSeq` is a no-op for them.

    Disk-space ceiling per session: 30MB (3 × 10MB). For 50 active sessions that's 1.5GB worst case, which is fine on any modern VPS. If you need compaction (drop events older than the last persisted seq), it goes in `event_log.py` — but probably YAGNI: sessions get deleted often, cleanup runs at boot and on kill.

32. **Optimistic UI for send / sleep / mode** (don't confuse with the *pessimistic* interaction acks of gotcha 18 — those stay as-is). Every action travels browser → POST → Charon → multiplexed SSH → VPS agent → SDK; waiting for the round-trip (or for the echoing event to come back) made the UI lag "a few seconds" per action. So `useClaudeSessionStream` now updates local state BEFORE the `await`:
    - **`send`**: appends the user bubble + sets `status='thinking'` immediately. To avoid a duplicate when the server's `user_echo` SSE arrives, `send` pushes the trimmed content into `pendingUserEchoRef` (a FIFO-by-content token list); the `user_echo` handler consumes a matching token and suppresses that echo. Echoes WITHOUT a token (message sent from another tab/device) still append. The synthetic `'u…'` id is later upgraded to `'m<dbid>'` by `applyDelta`'s `(role,content)` dedup. On failure we keep the bubble + token (the dominant failure — agent RPC throwing — happens AFTER the server persisted the row and broadcast the echo, so the message is real; a genuinely-unsent phantom self-heals on the next full refetch). **If you change the synthetic-id format or the user_echo path, keep the token dedup or duplicates return.**
    - **`doSleep`**: sets `status='sleeping'` immediately. Safe because `sessionOps.sleepSession` marks the DB row `'sleeping'` *unconditionally* (even if the agent is unreachable), so the optimistic flip is always correct — no revert needed.
    - **`setMode`**: sets the mode immediately, reverts to the previous mode on POST failure (the agent only applies it on success; reconciled by the `mode_changed` SSE).

    Server side, `sleepSession` now (a) broadcasts `status='sleeping'` on the global bus right away (so the sidebar + other tabs flip without waiting) and sets the in-memory `stream.status`, and (b) fires `client.call('sleep_session')` **fire-and-forget** (`.catch()` logs) instead of `await`-ing it — the agent's `stop()` blocks up to 5s on `asyncio.wait_for(main_task, timeout=5.0)` (SDK teardown of the in-flight turn), which used to wedge the HTTP response. The DB + broadcast already reflect the truth; the agent stop is best-effort cleanup. (`resume` was already optimistic via `setStatus('starting')` — this generalises the pattern.)

33. **Persistent SSH shells = remote tmux + node-pty attach** (`lib/server/shell/shellSession.ts`). The old shells were in-memory only (one piped `ssh` child per shell; lost on any Charon restart) and ran `exec $SHELL -l` with **no `TERM`** → ncurses apps (htop, vim, top, nano, less) died with *"Error opening terminal: unknown"* (NOT "command not found"). The redesign:
    - The terminal is a `tmux` session `charon-<id>` on the VPS. Charon attaches via `node-pty.spawn('ssh', ['-tt', …, 'exec tmux -u new-session -A -s charon-<id> [-c <cwd>]'])`. node-pty gives the local ssh a **real controlling tty**, so `TERM` propagates and `pty.resize(cols,rows)` forwards `SIGWINCH` through SSH → the tmux client resizes. Inside tmux, `TERM=screen` (tmux's default `default-terminal` — a universally-present terminfo, so htop works; we deliberately don't set `screen-256color`/`tmux-256color` to avoid touching a shared tmux server's global options — colors are 8/16, acceptable; revisit if 256-color is wanted).
    - **`-tt` is still required**: tmux refuses to attach without a remote PTY. node-pty supplies the *local* controlling tty that makes `-tt` + size-forwarding work.
    - Persistence: the `shells` DB row (migration 0013) is just the index. The attach is ephemeral and **lazily (re)spawned** on subscribe/input/resize — so after a Charon restart the shell re-lists from DB and re-attaches to the SAME tmux session (full screen state preserved via tmux's redraw). A human can `tmux attach -t charon-<id>` from the server and share the exact terminal.
    - **Distinguish detach from exit**: when the node-pty attach exits, the handler runs `tmux has-session`; if alive → it was a network drop → re-attach with backoff (while a viewer is present, capped at `MAX_REATTACH`); if gone → the inner shell exited → mark exited + purge row after a grace period. An SSH-level failure (VPS unreachable) is treated as "alive" (don't declare dead on a hiccup).
    - **Boot reconcile** (`reconcileShellsOnBoot`, called from `seedInitialData` = first page SSR, NOT on API calls): per-VPS `tmux ls`, prune rows whose session is gone. Gotcha-within-gotcha: the prune guard must check `pool.get(id)?.attached` (a live/attaching attach), NOT `pool.has(id)` — because `listShells()` (GET `/api/shells`) hydrates a non-attached instance into the pool just to read `info()`, and a bare `pool.has` would then protect a genuinely-dead shell from pruning forever. On prune, also `pool.delete(id)` so a stale hydrated instance can't `new-session -A`-resurrect a dead session.
    - **node-pty is a native module**: compiled against the running Node ABI (here `/root/.nvm/.../v20.19.5`). It MUST be rebuilt on a Node upgrade (`npm rebuild node-pty`), same constraint as `better-sqlite3`. Install with the v20 toolchain actually first in `PATH` — `npm`'s `#!/usr/bin/env node` shebang otherwise picks the system node (v16 here) and the build targets the wrong ABI (symptom: `Cannot find module '../build/Debug/pty.node'` at load).
    - tmux is installed best-effort **inline in the attach command** (`TMUX_ENSURE`: `if ! command -v tmux; then <apt/dnf/yum/apk/pacman, with apt-get update fallback>; fi; exec tmux …`). Inline (not a separate fire-and-forget SSH) so there's no concurrent apt-lock race and cold re-attach after a restart self-heals too. When tmux is present (the common case + every re-attach) it's a single cheap `command -v` then `exec tmux`. No dedicated bootstrap phase.

34. **False "agent in error" on a healthy VPS** (`lib/server/agent/AgentClient.ts § _handleExit`). The SSH `--connect` proxy is a *transport* tunnel to the agent's Unix socket; the agent daemon runs independently and survives the SSH dropping. The old code wrote `agentStatus='error'` on **every** non-"not found" SSH exit, so a transient drop (network blip, `ServerAliveInterval`×`ServerAliveCountMax`=120s timeout, sshd restart, VPS briefly unreachable) flipped a perfectly healthy agent to `error`. Two amplifiers made it stick visibly: (1) **there is no live SSE push for `agentStatus`** — the browser only reads it at SSR, so the stale `error` persisted until a manual page reload even after Charon reconnected seconds later; (2) the reconnect **backoff caps at 5min**, so the DB genuinely said `error` for minutes. The UI then offered "▸ install agent" (wrong — the agent IS installed).

    **Fixes:**
    - `_handleExit` now records the classification in `AgentClient.lastClassified` (`'ok'|'missing'|'error'`) but only **persists** `error` once `reconnectAttempts >= ERROR_PERSIST_AFTER_ATTEMPTS` (3 ≈ ~12s of genuinely-failed reconnects). `missing` (pyz absent: stderr "not found" / exit 127) stays definitive and is persisted immediately. So a quick reconnect never surfaces as `error`. Don't lower the threshold to 0 or you reintroduce the flapping.
    - New manual endpoint `POST /api/vps/[id]/agent/refresh` (see §8): two-phase. Phase 1 drops the stuck client, recreates it, awaits a fresh `hello` (bypassing the backoff, daemon untouched). Phase 2 (only if Phase 1 fails) calls `ensureAgentRunning(vps)` in `bootstrap.ts` — a `start`-if-not-running (NOT `restart`, so a live daemon's in-flight turns are never killed) covering the dead-daemon case (proxy exits 2 when the socket is absent), then reconnects. On success the hello path persists `ok` + version + sha; on failure it persists the definitive `lastClassified` and returns it. This is the "reconnect / revive now" verdict.
    - Sidebar (`app/Sidebar.tsx § renderVpsCard`): for `agentStatus==='error'` the primary action is now "↻ refresh agent" (calls `runRefreshAgent` in `ClaudePanel.tsx` → patches the local row with the returned status), with a quiet "reinstall" fallback. `missing`/`unknown` keep "▸ install agent". The badge/label text for `error` is now "agent unreachable" (it's a connection issue, not a broken agent). If you add another agent-status surface, mirror this distinction (`error` ≠ "needs reinstall").

35. **Per-session model / effort = DEFERRED apply** (agent >= 0.5.0). `claude_agent_sdk.ClaudeAgentOptions` reads `model`, `fallback_model`, and `effort` at `ClaudeSDKClient` *construction* — there is no SDK-side runtime setter and you cannot resume an existing `claude_session_id` against a different model (the SDK session UUID is bound to a model server-side). Therefore `set_model` / `set_effort` (`agent/charon_agent/session.py § set_model/set_effort`) update the in-memory + state.json attributes and emit `model_changed` / `effort_changed`, but do NOT touch the running client. The emitted event carries `applied_at_next_start: true` whenever a live client exists; the UI (`useClaudeSessionStream § modelPendingApply/effortPendingApply`, badge in `ClaudeSessionView § ModelEffortBadges`) shows a ⏳ marker until the next sleep+resume. Implications:
    - Don't try to "hot-swap" the model by recreating the SDK client without a sleep+resume: the `claude_session_id` would change → fork of session → broken history. If a user really wants immediate effect, the right move is sleep + resume (already optimistic, ~instant in the UI).
    - `resumeSession` MUST re-read `model`/`fallback_model`/`effort` from the DB and pass them to the fallback `start_session(claude_session_id=...)` (cf. `sessionOps.ts § resumeSession`). Without this, the resumed client silently reverts to SDK defaults — every restart would erase the user's per-session config, which is invisible until a `model_changed` SSE shows them as cleared. There is no test for this; reviewers should grep `resumeSession` for the three field passes.
    - Per-session values are **resolved at create time** from `claudeSettings` globals (`claude.default_model`, `claude.default_fallback_model`, `claude.default_effort`) and PERSISTED into the session row. A later edit of the global default in SettingsModal does NOT retroactively change existing sessions — by design (changing a global to "max" effort and silently spinning up 50× spend on every old session would be a footgun). The `_resolveClaudeConfig` helper in `sessionOps.ts` does the resolution once.
    - Old agents (< 0.5.0) silently IGNORE `model`/`fallback_model`/`effort` in `start_session` params (they go through `params.get(...)` which is forgiving). So mixed-agent fleets degrade gracefully: a 0.4.x VPS just falls back to SDK defaults for those sessions. For `set_model` / `set_effort` RPCs on an old agent the call fails with `method not found` (-32601) — surfaced as an error in the UI; treat as "upgrade the agent". Sidebar shows "agent out of date" because `agentPyzSha` differs.
    - **Always-defensive option build** (`session.py § _build_options_with_fallback`): even agents that DO know `model`/`effort` may run against an OLDER `claude-agent-sdk` that doesn't accept one of the fields. Catches the `TypeError: unexpected keyword argument 'effort'`, drops the offending field (in order: `effort` first, then `fallback_model`, then `model`), retries, and emits an `error` event documenting the degradation. Without this, a single old SDK on one VPS would kill all sessions on that VPS the moment the user set an effort. Keep the fallback loop — don't "optimize" by assuming a minimum SDK version.
    - **Valid effort values are duplicated in three places**: `claude_agent_sdk.EffortLevel` (the truth), `agent/charon_agent/session.py § AgentSession.VALID_EFFORTS`, and `lib/server/agent/types.ts § EffortLevel` (re-exported via `lib/types/api.ts § ClaudeEffortLevel`). When SDK adds a new level (e.g. `'extreme'`), update all three or the new value is silently dropped agent-side. The `EFFORT_OPTIONS` arrays in `NewSessionDialog.tsx` / `NewSessionSheet.tsx` / `SettingsModal.tsx` / `ModelEffortBadges` also list them for `<select>` UI — those are display-only, less critical but worth syncing for a complete picture.

## 15. Quick lookup (non-obvious entry points)

Filenames cover most things; this table is for the entries you'd never grep from a cold start.

| Question | File(s) |
|---|---|
| JSON-RPC protocol (TS / Py mirror) | `lib/server/agent/types.ts` ↔ `agent/charon_agent/protocol.py` |
| Bridge events ↔ DB ↔ SSE | `lib/server/agent/sessionOps.ts` |
| Boot init (migration + autoConnect + reconcile) | `lib/server/seed.ts` + `lib/server/agent/autoConnect.ts` |
| `claude login` check (SSH + 24h TTL) | `lib/server/agent/claudeLoginCheck.ts` |
| VPS install phases (async generator) | `lib/server/claude/bootstrap.ts` |
| SSH multiplexing session (mandatory for multi-phase) | `lib/server/claude/sshExec.ts` |
| SSE conn registry + low/high-volume routing | `lib/server/agent/eventConnections.ts` |
| Singleton browser SSE (focus + reconnect + watchdog) | `app/globalEventStream.ts` |
| Chat delta polling (safety net) + abort-on-wake | `app/useClaudeSessionStream.ts § pollDelta/applyDelta/forcePoll` + `?since=` in `app/api/claude/sessions/[id]/route.ts` |
| Auto-recovering error boundary (render error ⇒ remount, not freeze) | `app/SessionErrorBoundary.tsx` (wraps `ClaudeSessionView` + `MobileChat`) |
| History pagination cursor (backend) | `app/api/claude/sessions/[id]/route.ts § loadMessageWindow` |
| Cross-session interaction feed hook | `app/useCrossSessionInteractionFeed.ts` |
| Rebuild a session's UI state from DB rows | `app/sessionRebuild.ts` |
| Module-level session cache (desktop + mobile) | `app/sessionCache.ts` |
| Per-session textarea drafts (memory-only) | `app/inputDraftStore.ts` |
| Py↔TS protocol alignment check (prebuild) | `scripts/check-protocol-sync.mjs` |
| TabBar layout logic | `app/TabBar.tsx` + `computeTabs`/`keptOpenIds`/`activeVpsId`/`lastSelectedByVpsRef` in `ClaudePanel.tsx` |
| VPS folders (DnD + DB-persisted collapse) | `vpsFolders` in `lib/db/schema.ts` + `app/api/vps-folders/**` + `DataModal.tsx` |
| Durable agent event log (rotation, seq, replay) | `agent/charon_agent/event_log.py` + `_emit` in `server.py` + `SessionStream.lastSeenSeq` in `sessionOps.ts` + `_pendingAfterSeq` in `AgentClient.ts` |
| Persistent SSH shells (remote tmux + node-pty attach, resize, reconcile) | `lib/server/shell/shellSession.ts` + `app/ShellTerminal.tsx` + `app/api/shells/[id]/resize` + `shells` table in `lib/db/schema.ts` |
| Agent-status classification (why "error", transient-drop gating, refresh) | `_handleExit`/`lastClassified`/`ERROR_PERSIST_AFTER_ATTEMPTS` in `lib/server/agent/AgentClient.ts` + `app/api/vps/[id]/agent/refresh` + `ensureAgentRunning` in `bootstrap.ts` + §14 gotcha 34 |
| Per-session model / effort (deferred apply, SDK fallback) | `set_model`/`set_effort` in `agent/charon_agent/session.py` + `_build_options_with_fallback` (drops unsupported keys) + `_resolveClaudeConfig` in `lib/server/agent/sessionOps.ts` + `SessionStream.setModel/setEffort` + `app/api/claude/sessions/[id]/model` + `app/api/claude/sessions/[id]/effort` + `ModelEffortBadges` in `ClaudeSessionView.tsx` + §14 gotcha 35 |

---

## 16. Commands to know

```bash
# Dev
npm run dev                                # turbopack dev, 127.0.0.1:10556

# Prod (on the server) — ALWAYS chain build + restart (see §3)
npm run build && systemctl restart charon  # WITHOUT --turbopack!
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
  the handler in `sessionOps.ts` then in `ClaudePanel.tsx`. Since
  agent 0.4.0 the `_emit` path stamps every payload with `seq` and
  `ts` automatically via `event_log.append()`; the new event must
  not carry pre-existing `seq` or `ts` keys (they would clash with
  the durable log's monotonic sequencer). If the event is a pure
  client-side hint (e.g. a UI marker that shouldn't be persisted),
  add it AFTER the broadcast, not inside `_emit`.
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
