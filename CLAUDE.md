# CLAUDE.md — Guide to the Charon repo

Read this before starting a task. For the **why**, see
`docs/adr-001-charon-agent.md`.

> ## ⚠ Update this file with every change
>
> This file is the source of truth for future agents. If you change the
> JSON-RPC protocol, DB schema, API routes, repo layout, build/config,
> env vars, deployment topology, agent lifecycle, a major frontend
> component, or discover a footgun (→ §14) — **update the relevant
> section in the same commit**. Renames → also fix §15. Protocol/schema
> → follow the §17 checklist. **Keep this file concise (< 50k chars):
> compress, don't append.** Section and gotcha NUMBERS are referenced
> from code comments — never renumber, only edit in place.

---

## 1. What Charon does

Charon is a **Next.js hub** (App Router, React 19, SQLite) driving
**Claude Code/Agent SDK sessions** on **remote VPSes**. Each VPS runs a
**Python daemon** (`charon-agent`, stdlib-only `.pyz`) hosting the
`ClaudeSDKClient` sessions behind JSON-RPC on a local Unix socket;
Charon reaches it through **one multiplexed SSH per VPS**
(`exec charon-agent.pyz --connect` = stdio↔socket proxy).

Features: desktop multi-session dashboard, mobile UI (`/m/...`),
persistent SSH shells (xterm.js; PTY in a DETACHED holder — survives
Charon AND agent restarts), session survival across Charon restarts
(re-subscribe + durable replay), automated VPS bootstrap (SSE phases),
Web Push + Telegram notifications.

```
Browser ◄─SSE/POST─► Charon (Next.js, AgentClientPool, SQLite)
                       ◄─1 SSH per VPS, JSON-RPC─► charon-agent (asyncio Unix sock, N SDK sessions)
```

---

## 2. Repo layout

```
/srv/charon
├── app/                  # Next.js App Router: api/ (§8), m/ (mobile), login/,
│   │                     # ClaudePanel, ClaudeSessionView, useClaudeSessionStream,
│   │                     # TabBar, Sidebar, ToolPanel, Message, DataModal,
│   │                     # globalEventStream (singleton SSE), sessionRebuild/Cache,
│   │                     # *Modal/*Popup/*Card, LoginConsole, ShellTerminal,
│   │                     # globals.css, claude.css, agent-ui.css, m/mobile.css
├── lib/
│   ├── api.ts            # typed fetch wrappers (pairs in lib/types/api.ts)
│   ├── db/{schema.ts, index.ts}   # Drizzle + better-sqlite3 (WAL, FK ON)
│   └── server/
│       ├── agent/        # AgentClient(Pool), sessionOps, autoConnect, eventConnections,
│       │                 # builtPyzSha, claudeLoginCheck, types, shellNotify, sshShared.js
│       ├── claude/       # bootstrap, sshExec, settings, knownModels, modelSync
│       ├── shell/shellSession.ts, install/installSession.ts
│       └── auth.ts, session.ts, crypto.ts, seed.ts, migrationV2.ts
├── agent/charon_agent/   # Python daemon (zipapp): __main__, server, session, shell,
│   │                     # holder, state, protocol, event_log, client
│   └── build.sh → dist/charon-agent.pyz
├── drizzle/              # SQL migrations + meta/ (commit BOTH)
├── scripts/{migrate.mjs, check-protocol-sync.mjs}
├── data/charon.db, middleware.ts (auth gate)
├── server.js             # custom Next server: Next + WS upgrade for shells
└── /etc/systemd/system/charon.service   (outside the repo)
```

---

## 3. Build, dev, prod

```json
"dev":   "node server.js",   // custom server (Next dev + WS)
"build": "node scripts/check-protocol-sync.mjs && next build",
"start": "node server.js",
"db:generate": "drizzle-kit generate",
"db:migrate":  "node ./scripts/migrate.mjs"
```

**Build rules (details §14.1-3):**
- **Always chain `npm run build && systemctl restart charon`** — a bare
  build leaves the running server with stale chunk hashes → ChunkLoadError.
- **Never `next build --turbopack` in prod** (15.5.18: `next start` 404s
  `/_next/static/*`). Dev keeps turbopack.
- `.next` polluted (no `BUILD_ID`, `turbopack-*.js` chunks):
  `systemctl stop charon && rm -rf .next && npm run build && systemctl start charon`.

Systemd unit: `WorkingDirectory=/srv/charon`, `EnvironmentFile=.env`,
`ExecStart=node /srv/charon/server.js`, `Restart=on-failure`. Logs:
`journalctl -u charon -f`. Local dev: `npm run dev` → 127.0.0.1:10556.

`next.config.mjs`: `serverExternalPackages: ['better-sqlite3']`
(mandatory, §14.9), `reactStrictMode: false`, security headers (§13).

### `.env` keys

| Key | Role |
|---|---|
| `DATABASE_URL` | SQLite path (default `./data/charon.db`) |
| `MASTER_PASSWORD` / `MASTER_SALT` | hub password + scrypt salt |
| `SESSION_SECRET` | session-cookie signing |
| `SYNC_TOKEN` | bearer for `/api/sync` |
| `VAPID_SUBJECT` | Web Push identity (overridable in SettingsModal) |
| `HOST`, `PORT`, `NODE_ENV` | `NODE_ENV=production` enables HSTS + secure cookie |

VAPID key exposed by `/api/claude/push/key`; push keys in `claudeSettings`.

---

## 4. Database

SQLite WAL at `data/charon.db`, `better-sqlite3` (sync) + `drizzle-orm`.
`PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.

### Tables

| Table | Role |
|---|---|
| `users`, `sessions` | single user + browser session cookies |
| `vpsFolders` | sidebar folders. `id='default'` protected (no delete, always last, §14.19-area rules below) |
| `vps` | remote VPSes (detail below) |
| `vpsPaths` | known cwds per VPS |
| `claudeSessions` | Claude sessions: status, mode, cwd, name, color, `claudeSessionId`, `lastSeenSeq`, `lastStopNotifiedSeq`, `model`/`fallbackModel`/`effort` |
| `claudeSessionMessages` | history (role, content, createdAt) |
| `claudePendingPermissions` / `claudePendingQuestions` | pending gates; questions `kind` = `question` \| `exit_plan` |
| `claudeSessionLogs` | per-session audit |
| `claudeSettings` | key/value settings |
| `claudePushSubs` | Web Push endpoints (UNIQUE endpoint) |
| `shells` | persistent shells index (PTY lives in VPS holder, §14.44). `cwd`, `name`, `color`. Rows pruned wherever the agent reports the shell gone (boot reconcile, shell_watch snapshot, failed shell_subscribe) |

Cascades: `vps → vpsPaths/claudeSessions/shells`,
`claudeSessions → messages/permissions/questions/logs`.

### `vps` columns (often modified)

`id, name, ip, sshUser, sshPort(22), defaultPath`,
`folderId('default')` + `position` (DnD ordering; FK NOT SQLite-enforced —
SQLite refuses ADD COLUMN REFERENCES with non-NULL default; validated
API-side), `agentStatus('unknown'|'ok'|'missing'|'error')`,
`agentVersion`, `agentPyzSha` (12-char sha → out-of-date check),
`agentLastSeenAt`, `claudeLoggedIn` (1/0/null), `claudeLoggedInCheckedAt`.

**Default-folder rule**: `id='default'` ("No folder") is always LAST,
not draggable, its `position` updates are ignored server-side; new
folders get `position = max+1`. Enforced in `DataModal.tsx`
(StaticFolder), `Sidebar.tsx` (comparator), `m/select/MobileSelect.tsx`.

### Migrations (`drizzle/`)

0000 initial · 0001 vps agent cols · 0002 vpsPaths refactor · 0003
session color · **0004 no-op** (dup of 0003 — never put real SQL back,
§14.5) · 0005 agent_pyz_sha · 0006 vps_folders + folder_id/position ·
0007 claude_logged_in (its .sql was hand-fixed — always verify generated
SQL) · 0008 purge `status='killed'` rows (data-only, §10) · 0009 rename
default folder · 0010 hot-path indexes (SQLite doesn't auto-index FKs) ·
0011 `last_seen_seq` (durable replay cursor, §14.31) · 0012
`last_stop_notified_seq` (stop-push dedup across replays) · 0013 shells
table (tmux, superseded) · 0014 per-session model/fallback/effort
(§14.35) · 0015 shells: drop tmux_name (needs SQLite ≥3.35) · 0016 drop
vestigial `shells.last_seen_seq` (tail replay, never a cursor, §14.37).

Workflow: edit `lib/db/schema.ts` → `npm run db:generate` → **check the
.sql** → `npm run db:migrate` → commit .sql AND `drizzle/meta/`.

---

## 5. Agent-side (Python pyz)

Build: `bash agent/build.sh` → `agent/dist/charon-agent.pyz` (zipapp,
stdlib-only, executable shebang). `lib/server/agent/builtPyzSha.ts`
computes its sha (12 chars) → compared to `vps.agentPyzSha` for the
"update agent" button.

### Files on the VPS

```
~/.charon/charon-agent.pyz, agent.sock (600), state.json, agent.log
~/.charon/events/<sid>.jsonl(.1)   # durable per-session event log (≥0.4.0)
~/.charon/shells/<id>.jsonl        # durable per-shell log (≥0.7.0)
~/.charon/shells/<id>.sock         # holder control socket (≥0.10.0)
~/.charon/shells/<id>.spool        # offline output spool (agent down)
~/.charon/venv/                    # SDK venv (PEP 668)
~/.config/systemd/user/charon-agent.service  # KillMode=process (§14.44!)
                                   # fallback: nohup setsid + crontab @reboot
```

Prereqs: Python ≥3.10, `claude-agent-sdk` in the venv, `claude login`
done once, systemd ≥230 for `--user` (else nohup fallback).

### Lifecycle

Boot: mkdir `~/.charon` → open socket → load `state.json` (`killed`
ignored, `sleeping` loaded not started, active restored via
`ClaudeSDKClient(resume=...)`) → re-attach shell holders (scan `*.sock`,
attach; stale socks unlinked, dead shells' logs wiped) → accept loop.
SIGTERM: save state, stop sessions (mark `sleeping`), unlink socket —
shell holders untouched (they spool output until the next attach).

`--connect` mode: stdio↔socket proxy (2 threads). Exit codes: 0 clean,
**2 socket absent (daemon dead)**, 3 connect failed.

### Modules

- **`server.py`**: asyncio Unix server, dispatch, per-session ring
  buffer `RING_SIZE=2000`, `subscribers` map, debounced state save.
- **`session.py`**: `AgentSession` wraps `ClaudeSDKClient` — hooks,
  `can_use_tool`, pending perm/question/exit_plan futures, before/after
  file snapshots (max 256KB), SDK → protocol event translation.
- **`shell.py`**: agent-side CLIENT of a detached holder — spawn
  (`start`) / reconnect (`attach` at boot) over the holder sock, relay
  input/resize/kill, busy/idle heuristics (suppressed during spool replay).
- **`holder.py`** (≥0.10.0): detached per-shell process OWNING the PTY +
  bash (`--shell-holder <id>`, `start_new_session=True`). Survives agent
  restarts/updates; spools (8MB cap) while detached, replays on attach.
  Line-JSON: `hello/output/spool_end/exit` up, `input/resize/kill` down.
- **`state.py`**: tolerant load, atomic save.
- **`event_log.py`**: durable per-session JSONL; monotonic `seq`+`ts`
  appended BEFORE ring/broadcast; rotation 10MB×3; orphans cleaned at
  boot. §14.31.
- **`protocol.py`**: error codes, helpers, canonical `METHODS` list.

---

## 6. JSON-RPC protocol (Charon ↔ agent)

Line-delimited JSON over Unix socket / SSH pipes. `id`s allocated by
Charon, 60s timeout in `AgentClient.ts`.

```jsonc
{"id":1,"method":"start_session","params":{...}}      // request
{"id":1,"result":{...}} / {"id":1,"error":{...}}      // response
{"event":"assistant_text","session_id":"…","delta":"…"} // event
```

### Methods

| Method | Notes |
|---|---|
| `hello` | → `{agent_version, agent_pyz_sha, sdk_available, sdk_error, pid, sessions:[SessionInfo]}` |
| `ping` | → `{pong, ts}` |
| `list_sessions` | → `[SessionInfo]` |
| `start_session` | `{session_id?, cwd, name?, permission_mode?, claude_session_id?, model?, fallback_model?, effort?}` → `{session_id}`. effort ∈ low\|medium\|high\|xhigh\|max. Old agents (<0.5.0) ignore the 3 config fields |
| `subscribe` | `{session_id, replay?, after_seq?}` → `{ok, replay_count, status, current_seq}` + replay events. `after_seq` (≥0.4.0, durable log) wins over `replay` (ring tail) |
| `unsubscribe` | `{session_id}` |
| `send_input` | `{session_id, content}` |
| `interrupt` | soft — may be ignored if a tool is in flight (§14.13) |
| `force_stop` | forced cancel → `sleeping`, resume possible |
| `set_permission_mode` | `{session_id, mode}` |
| `set_model` / `set_effort` | ≥0.5.0, DEFERRED apply (`applied_at_next_start`, §14.35). `null` clears to global default |
| `respond_permission` / `respond_question` / `respond_exit_plan` | resolve pending futures |
| `resume_session` | → `{ok, status, noop?}` — noop if already running (§14.36) |
| `sleep_session` | stop, keep `claude_session_id` |
| `kill_session` | stop + remove from state.json |

**Shell RPCs**: `shell_list`, `shell_start {cwd?,name?,cols?,rows?}`,
`shell_input`, `shell_resize`, `shell_subscribe {shell_id, after_seq?,
tail_bytes?}` (`tail_bytes` = replay only the log SUFFIX; §14.37),
`shell_unsubscribe`, `shell_kill`, plus the global output-free
`shell_watch {}` → `{ok, shells}` / `shell_unwatch` (registers for
`shell_status/exit/idle` of ALL shells, NOT `shell_output`; §14.42). A
`shell_subscribe` error -32000 is MEANINGFUL: server.js prunes the
phantom row + `{type:'gone'}` + close 1000 (§14.44). TS `AgentMethodName`
↔ Python `METHODS` enforced by `check-protocol-sync.mjs` at build.

### Error codes

`-32700` parse · `-32600` invalid request · `-32601` method not found ·
`-32602` invalid params · `-32603` internal · `-32000` session not
found · `-32001` session dead · `-32010` SDK unavailable.

### Events (agent → Charon)

All carry `session_id`, plus `seq` + `ts` from the durable log — EXCEPT
replay markers and the TRANSIENT shell hints `shell_idle` /
`shell_status` busy-active (broadcast-only, §14.42).

| Event | Payload (excerpt) |
|---|---|
| `status` | `{status: starting\|active\|thinking\|sleeping\|error\|killed}` — `'killed'` is a transient deletion signal only (§10) |
| `session_id` | `{claude_session_id}` (SDK UUID) |
| `ready` | SDK opened |
| `assistant_text` | `{delta}` |
| `thinking` | `{text}` |
| `tool_use` / `tool_result` | `{id,name,input}` / `{tool_use_id,content,is_error}` |
| `permission_request` / `user_question` / `exit_plan_request` | pending interactions |
| `todo_update` | `{todos}` |
| `edit_snapshot` | `{phase:'before'\|'after', tool_use_id, file_path, content, size, truncated}` |
| `mode_changed` | `{mode}` |
| `model_changed` / `effort_changed` | `{..., applied_at_next_start}` (≥0.5.0) |
| `stop` | `{subtype}` |
| `error` | `{msg, fatal?}` |
| `interrupted` | `{forced?}` |
| `replay_begin` / `replay_end` | replay markers (no seq) |

**Shell events** (`session_id` = shell id; 16-hex vs 32-hex — no
collision): `shell_status {status: active|busy|exited, cols, rows, pid}`
(busy/active TRANSIENT, recomputed on subscribe), `shell_output {data}`
(raw PTY utf-8, high-volume, NOT fanned to watchers), `shell_exit
{code}` (durable), `shell_idle {idle_seconds, burst_seconds,
burst_bytes}` (TRANSIENT "finished a burst" → push/Telegram; §14.42).

---

## 7. Hub-side: connection to the agent

### `lib/server/agent/AgentClient.ts` — one per VPS

Long-running ssh (`BatchMode`, `ServerAliveInterval=30`, newest python
3.13→3.10, `--connect`), line-JSON parser, `pending` map (60s timeout),
per-session `subscribers`, reconnect backoff `[1,3,8,20,60,120,300]s`.
On reconnect: `hello` → sha compare → update vps row + re-subscribe
(cursor from `_pendingAfterSeq`, §14.31).

### `AgentClientPool.ts`
`Map<vpsId, AgentClient>` memoized on `globalThis` (survives HMR), lazy.

### `sessionOps.ts` — agent events ⇄ DB ⇄ browser SSE

- **No Charon-side ring buffer**: browser SSE is live-only; clients
  refetch `GET /api/claude/sessions/[id]` on mount/reconnect/foreground
  (DB = source of truth, §14.14).
- **Replay dedup**: during `replay_begin→replay_end`, events already in
  DB (tool_use_id, text hash…) are filtered.
- Persistence: `assistant_text` accumulated, flushed on
  `stop`/`tool_use`/`permission_request`; other events inserted directly.
- Notifications (push + Telegram) on perm/question/exit_plan/stop.
- `alwaysAllow`: in-memory per-session set (§14.8).
- Key fns: `startNewSession`, `resumeSession`, `sleepSession`,
  `deleteSession`, `importExistingSession`, `reconcileVpsAgentState`.
- Lookups: `peekStream` (null if not in memory — READ endpoints) vs
  `getOrCreateStream` (hydrates from DB — WRITE/lifecycle endpoints).

### `autoConnect.ts` — boot (via `seed.ts`, first page SSR)

1. Launch every `AgentClient` (non-blocking).
2. `onStatus('connected')` hook → `reconcileVpsAgentState(vpsId,
   hello.sessions)` on EVERY (re)connect — re-attaches SessionStreams
   after a Charon restart (else eternal spinner, §14.24 layer 1). Also
   arms `ensureShellIdleWatch` (§14.42) +
   `refreshClaudeLoginStatusIfStale` (24h TTL login check).
3. Opportunistic `resumeSession()` for DB sessions in
   active/thinking/starting; on RPC timeout degrade to `sleeping`.

`reconcileVpsAgentState`: for each agent-known session,
`getOrCreateStream` + `ensureAttached` + sync status; for each DB
"should-be-running" session unknown to the agent, relaunch via
`resumeSession()` (falls back to `start_session(claude_session_id=…)`).

### `lib/server/claude/bootstrap.ts` — VPS setup phases (SSE)

`verify` (SDK import) → `detect_os` → `install_python` → `install_sdk`
(venv, PEP 668; pip health check + ensurepip retry, §14.28) →
`install_claude_cli` (claude.ai/install.sh, warn-only) → `install_agent`
(base64-pipe the pyz) → `install_service` (systemd-user, nohup fallback)
→ `ping_agent` (persists `agentVersion`/`agentPyzSha` immediately,
§14.27) → `check_login` (warn-only). Each phase must call
`detectSshFailure` (§14.23). `updateVpsAgent`: redeploy pyz + restart +
ping; rewrites the systemd unit (KillMode, §14.44).
`ensureAgentRunning(vps)`: start-if-not-running (never restarts a live
daemon).

---

## 8. API routes (catalog)

All under `/api/`, auth via middleware (except `/api/sync`, Bearer
`SYNC_TOKEN`).

### Auth & settings
- `POST /api/login/*`, `POST /logout`
- `GET|POST /api/claude/settings` — writes gated by `ALLOWED_KEYS`.
  Notable: `claude.default_model/_fallback_model/_effort` (§14.35),
  `claude.api_key` (catalog sync ONLY, §14.43), `shell.notify_idle`,
  `notif.global_enabled`. Internal (not writable, stripped from GET):
  `claude.models_cache(_at)`.
- `POST /api/claude/telegram/test`; `GET /api/claude/push/key`,
  `POST /api/claude/push/subscribe|unsubscribe`
- `GET /api/claude/models` — `mergeModels(seed, cached-live)` + kicks
  throttled `refreshModelsIfStale()` (§14.43). Returns `{models, efforts}`.
- `POST /api/claude/models/refresh` — forced sync, graceful `ok:false`.

### VPS / folders / paths
- `POST /api/vps` (optional `folderId`, auto `position`),
  `PATCH|DELETE /api/vps/[id]`, `POST /api/vps/[id]/test`
- `GET|POST /api/vps-folders`, `PATCH /api/vps-folders/[id]`
  (`{name?, collapsed?}`), `DELETE` (refused for `default`),
  `POST /api/vps-folders/layout` (atomic re-layout after DnD; rejects
  unknown folderIds; ignores `default` position)
- `GET|POST /api/vps-paths`, `PATCH|DELETE /api/vps-paths/[id]`

### VPS agent
- `GET /api/vps/[id]/claude/check` (ping+hello), `GET .../claude/bootstrap`
  (SSE), `POST .../claude/setup`, `POST .../agent/update` (redeploy pyz)
- `POST /api/vps/[id]/agent/refresh` — two-phase reconnect for `error`:
  (1) recreate client + await hello (bypasses backoff); (2) on failure
  only, `ensureAgentRunning` then reconnect. Never restarts a live
  daemon. 50s client timeout. §14.34.
- `GET /api/vps/[id]/claude/scan` — on-disk sessions (import)
- `POST /api/vps/[id]/claude/check-login` — refresh `claudeLoggedIn`
  (`claudeLoginCheck.ts`, shared with autoConnect's 24h TTL check)
- `GET|POST|DELETE /api/vps/[id]/login` + `.../login/stream` (SSE TUI)
  + `.../login/input` — `claude login` console

### Shells (holder PTY, WebSocket transport — §14.37/44)
- `GET /api/shells`; `GET|PATCH|DELETE /api/shells/[id]` (PATCH
  name/color; DELETE = `shell_kill` + drop row)
- `POST /api/vps/[id]/shells` (`{cwd?, name?, cols?, rows?}`),
  `GET /api/vps/[id]/shells`
- **`/api/shells/[id]/ws`** — WebSocket handled by `server.js` (not a
  Next route). Binary frames = raw shell bytes; text frames = JSON
  control (`resize` up; `status|exit|gone|idle|replay_begin|replay_end`
  down; `gone` = shell gone everywhere, close 1000, no reconnect). Auth:
  direct SQLite read of `sessions` (middleware doesn't run on Upgrade).
  On open: `shell_subscribe {after_seq:0, tail_bytes:512KB}` — the TAIL
  of the durable log, NEVER a cursor (§14.37); browser `term.reset()`s
  on `replay_begin`. The old POST input/resize + SSE stream routes are GONE.

### Installs (in-memory, max 1/VPS, §14.22)
- `GET /api/installs(/[id])`, `DELETE /api/installs/[id]`,
  `GET /api/installs/[id]/stream` (SSE ring replay + live),
  `POST /api/installs/[id]/retry`
- `GET|POST /api/vps/[id]/installs` — POST returns the existing run if
  one is in flight. `install_started/finished` flow through the global
  SSE (low-volume) → `<InstallNotificationPopup>`.

### Claude sessions
- `GET /api/claude/sessions` (filters vpsId/status)
- `POST /api/claude/sessions` — `{vpsId, cwd, name?, permissionMode?,
  model?, fallbackModel?, effort?}`; config resolved from globals and
  PERSISTED at create (§14.35)
- `POST /api/claude/sessions/import`
- `GET|PATCH|DELETE /api/claude/sessions/[id]` — GET: `?limit=N`
  (default 200, cap 1000), `?before=K` (scroll-up cursor), `?since=K`
  (delta poll). Limit counts CHAT roles only; `edit_snapshot`/`event`
  load as attachments by id range (§14.25). Returns `{messages, hasMore,
  oldestChatId, maxMessageId, …}`. **`edit_snapshot` content is STRIPPED
  in every mode** (§14.41). DELETE = definitive (cascade + best-effort
  agent kill, §10).
- `GET /api/claude/sessions/[id]/edits` — lazy diff content: LATEST
  before/after per file (JSON1 groupwise-max), 16MB budget, fetched once
  per session view (§14.41).
- `GET /api/claude/events?conn=<uuid>[&focus=<sid>]` — THE single
  multiplexed SSE per tab. Initial statuses + pendings + live filtered
  by focus.
- `POST /api/claude/focus` — `{conn, sessionId}`: switch which session
  gets high-volume events, no SSE reconnect.
- `POST /api/claude/sessions/[id]/input` (`{content}` or
  `{type:'interrupt'}`), `/permission` (`{id, allow, always?}`),
  `/question`, `/exit-plan`, `/mode`, `/model` (`{model, fallbackModel?}`,
  null clears), `/effort` (validated via `isKnownEffort`), `/sleep`,
  `/resume`, `/force-stop`, `/revert` (`{filePath, content}`)
- `GET /api/claude/sessions/[id]/export` (JSONL, keeps full content),
  `GET /api/claude/search`

### Misc
- `GET /api/local-agent/status`, `POST /api/local-agent/update`
- `POST /api/sync` (Bearer)

---

## 9. Browser-side SSE + polling

ONE singleton `EventSource('/api/claude/events…')` via
`app/globalEventStream.ts`, open for the tab's lifetime; session switch
= `POST /focus`, never a reconnect. `eventConnections.ts`: low-volume →
all conns; high-volume → focused conn only (§14.16). SSE is
**live-only**; on mount/reconnect/foreground + every 5s,
`useClaudeSessionStream` refetches the session GET (`?since=` delta) —
SQLite is the catch-up source of truth, SSE the fast path (§14.24).

Client routing (`useClaudeSessionStream.ts`): `status` → pill
(`'killed'` → `onKilled` redirect); `user_echo` → append (optimistic
dedup §14.32); `assistant_text` → rAF-batched buffer; `thinking`/
`tool_use`/`tool_result` → messages + `toolCalls` pairing; perm/
question/exit_plan requests → queues → Popup/Card;
`interaction_resolved` → dequeue; `mode/model/effort_changed`
(`*PendingApply` ⏳ badge when deferred); `todo_update` → ToolPanel;
`edit_snapshot` → `edits` Map (live event KEEPS content; GET strips —
§14.41); `stop` → flush; `error` → banner; `prefill_input`;
`vps_status` (`sessionId`=vpsId) → live agent badge (§14.34);
`shell_status` (`sessionId`=shellId) → `shells[].liveStatus` (§14.42).

Interactions feed two independent client queues from the same SSE:
`useClaudeSessionStream` (focused inline cards) and
`useCrossSessionInteractionFeed` (`subscribeAll()`, cross-session
popups/banner). The GET payload also returns pendings → self-heals.

---

## 10. Golden path & lifecycle

`/` → SSR (`requireSession`, `seedInitialData` = migration +
`autoConnectAgents`) → `<ClaudePanel>` → singleton SSE. New session:
POST → `startNewSession()` → INSERT (`starting`) → `start_session` →
agent wraps `ClaudeSDKClient` → `status=starting` → `ready` →
`session_id` persisted. Input → `send_input` → SDK query; permission
gates via futures + `PermissionPopup` (10min timeout); `stop` ends the
turn.

**Restart resume**: `autoConnect` + the `onStatus('connected')`
reconcile hook (§7). **Sleep vs delete**: `sleep` = reversible
(`sleeping`, keeps `claude_session_id`); `delete` = transient
`status='killed'` event + stream detach + DB cascade + best-effort
`kill_session`. No persistent `'killed'` status (§14.29). **Import**:
scan → row `sleeping` + `claudeSessionId`; Resume does
`start_session(claude_session_id, cwd)`.

---

## 11. Frontend

Desktop 3-col layout (`claude.css`): Sidebar 280px | chat | ToolPanel
340px, header on top.

**`ClaudePanel.tsx`** = desktop shell/orchestrator: `selectedId` /
`selectedShellId` / `selectedInstallId` (mutually exclusive), sidebar
data, modals, cross-session feed, push/SW integration, `mountedShellIds`
(persistent shell layer, §14.37). Per-session chat state lives in
`useClaudeSessionStream`, consumed by
`<ClaudeSessionView key={selectedId}>`.

Notable component behaviors:
- **`Sidebar.tsx`** (V1 "boxed-VPS folder tree", `cs-*` CSS in claude.css):
  folder → VPS-panel → session/shell cards. **Shows a VPS ONLY if it has a
  visible session/shell** (or a running install); folders with none are
  hidden — there is NO path tree anymore. IP under each VPS name; per-VPS
  ＋Agent/＋Shell + history icon; global ＋Agent/＋Shell in the sticky
  toolbar. **"show paused" toggle** (localStorage `hub.claude.showPaused.v1`,
  default ON) hides sleeping sessions / exited shells (and any VPS/folder
  left empty). Folder collapse in DB, per-VPS collapse in localStorage
  (`hub.claude.collapsedVps.v2`). "+ Claude"/"History" need
  `agentStatus==='ok'` (shell works without). Per-VPS agent action bar:
  missing/unknown → "install"; error → "↻ refresh" (+ reinstall);
  ok+outdated → "update"; ok+not-signed-in → "claude login". The ＋ buttons
  still open `NewSessionDialog`/`NewShellDialog` (the unified 3-step wizard
  is not wired in prod yet).
- **`TabBar.tsx`**: 2 rows (VPSes with open entities / entities of the
  active VPS); status colors; local × on non-active tabs; "+ Claude"/
  "+ SSH" use `defaultCwdFor(vpsId)`; helper `computeTabs(...)`.
- **`DataModal.tsx`**: @dnd-kit DnD → atomic `POST /api/vps-folders/layout`.
- **`SessionContextMenu.tsx`**: sessions → "Delete permanently" only.
- **`LoginConsole.tsx`**: xterm over SSE for `claude login`, OAuth-URL
  overlay (`terminalUrlDetect.ts`).
- **`ShellTerminal.tsx`**: xterm over WS, reconnect backoff; tail replay
  → `term.reset()` on `replay_begin` + "restoring…" overlay; 10k-line
  scrollback; `active` prop (mounted-but-hidden, skip `fit()`);
  `reassertSize` on focus/visibility (§14.37). Shared with mobile.

**Mobile (`app/m/`)**: `/m/select` (sessions grouped folder→VPS, same
DB-persisted folder collapse; long-press sheet; `.m-quicknav` chips
strip, logic in `app/m/quickNav.tsx § computeQuickNavGroups`), `/m/chat`
(condensed panel; ⧉ opens a `.m-sessions-sheet` overlay reusing
`computeQuickNavGroups`, polls 5s while open), `/m/shell` (fullscreen
xterm, always `active`).

**`lib/api.ts`**: typed fetch wrappers; request/response pairs in
`lib/types/api.ts` — add both when adding a route.

**Shared desktop ↔ mobile**: `sessionTypes.ts`, `sessionRebuild.ts`,
`sessionCache.ts`, `inputDraftStore.ts`, `useClaudeSessionStream.ts`,
`useCrossSessionInteractionFeed.ts`, `ClaudeSessionView.tsx` (isolated
`memo` `<ChatInputBar>` + `memo(Message)` — §14.38; mobile mirror
`MobileChat.tsx` with `MobileInputBar`/`memo(MobileMessage)`).

---

## 12. Auth, crypto, session

Single user (row created from `MASTER_PASSWORD`+`MASTER_SALT` at seed).
Login validates via scrypt → `sessions` row (24h sliding TTL) →
`charon_session` cookie → redirect to **sanitized `?next=`**
(`sanitizeNextPath` in `lib/nextPath.ts`, §14.40). `middleware.ts`
validates the cookie on everything except `_next`/`favicon`/`/login`/
`/api/sync`; unauth API → 401, else redirect
`/login?next=<path+search>`. Helpers: `lib/server/auth.ts`,
`session.ts` (`requireSession`/`requireApiSession`), `crypto.ts`
(AES-256-GCM, scrypt key).

---

## 13. Security

- Agent socket chmod 600, no network port — SSH key = authorization.
- Secrets in `.env`, never committed.
- Cookie: `httpOnly`, `sameSite:'lax'`, `secure` in prod — set in BOTH
  `middleware.ts` (refresh) and `app/login/actions.ts` (creation).
- Headers in `next.config.mjs`: X-Frame-Options DENY, nosniff,
  Referrer-Policy, Permissions-Policy, HSTS (prod). No CSP (Next inlines
  SSR scripts without nonce).
- Every `filePath`/`cwd` interpolated into `sshExec` goes through
  `shQuote()` (§14.11).

---

## 14. Known gotchas

1. **`next build --turbopack` breaks `next start`** (15.5.18) → 404 on
   `/_next/static/*`. Fix: stop, `rm -rf .next`, plain build, start.
2. **`.next` polluted by a dead `next dev`** → "Could not find a
   production build". Same fix as #1.
3. **Always `npm run build && systemctl restart charon`** — stale chunk
   hashes otherwise (MIME/ChunkLoadError).
4. **Drizzle**: commit `drizzle/*.sql` AND `drizzle/meta/`.
5. **Migration 0004 is a no-op marker** (dup of 0003) — never put real
   SQL back there; create a new migration.
6. **Agent out of date**: `vps.agentPyzSha !== getBuiltPyzSha()` → UI
   update button. Bump `__version__` on protocol changes.
7. **`claude login` is per-VPS** (no shared OAuth) — `<LoginConsole>`.
8. **`alwaysAllow` is in-memory hub-side** — lost on restart, by design
   (permanent = `permission_mode='auto'`).
9. **`serverExternalPackages: ['better-sqlite3']` is mandatory**; the
   native module is ABI-bound — rebuild on Node upgrade.
10. **SQLite WAL = 3 files** (`.db`, `.db-shm`, `.db-wal`), all critical.
11. **SSH injection**: `shQuote()` (POSIX single quotes) on every
    interpolated value — `"$x"` is not enough.
12. **Module-level signal handlers** must guard
    `process.env.NEXT_PHASE !== 'phase-production-build'` (else
    `process.exit` during build).
13. **SDK `interrupt` does NOT cancel in-flight tools** — use
    `force_stop` (→ `sleeping`, resumable).
14. **Charon-side SSE is live-only — NO ring buffer.** Any view must GET
    the session first; SSE alone misses history.
15. **One multiplexed SSE per browser** (singleton in
    `globalEventStream.ts`, focus via POST). New hooks use
    `subscribeSession`/`subscribeAll` — never open another EventSource.
16. **Low- vs high-volume events** (`eventConnections.ts §
    LOW_VOLUME_EVENTS`): low → all conns; high (assistant_text,
    tool_use/result, edit_snapshot, todo_update, thinking, user_echo,
    stop, prefill_input, reconnecting) → focused conn only. Classify
    every new event explicitly.
17. **Per-token re-render = laggy streaming**: batch streaming setState
    via rAF (see `useClaudeSessionStream`). Same for any new stream.
18. **Pessimistic acks on interactions**: clear the card only after POST
    OK (optimistic version caused phantom cards).
19. **`cmd &;` is a bash syntax error** — join script lines with `\n`
    when any item can end with `&`.
20. **No `\'` inside bash single quotes** — use `'...'\''...'` or base64.
21. **systemd-user on fresh VPS**: `enable-linger` isn't enough — also
    `systemctl start user@$(id -u).service` BEFORE `daemon-reload`.
22. **Install sessions: in-memory, max 1 per VPS**, lost on restart; a
    2nd `startInstall` returns the existing one.
23. **`detectSshFailure` on every bootstrap `sshExec`** — abort early
    on connect/auth/host-key/timeout, don't waste minutes on doomed phases.
24. **Live-update reliability ("chat frozen until F5")** — defense in
    depth; read before touching ANY of this path.
    - Backend: the `onStatus('connected')` reconcile (§7).
    - SSE client (`globalEventStream.ts`): re-POST focus on reopen;
      manual reconnect ONLY on `readyState===CLOSED` (on CONNECTING do
      NOTHING — the browser retries; an earlier version looped open/
      close every 1s); `backoffMs=0` reset lives in `onmessage`, NOT
      `onopen`; liveness watchdog (force reconnect after 20s silence;
      heartbeat is a typed `data:` event every 8s — SSE comments are
      JS-invisible); reconnect on `online`/`visibilitychange`; stable
      `connId`; **auto page reload when `onmessage` fires after >15s of
      silence** (`AUTO_RELOAD_THRESHOLD_MS` — "if a refresh fixes it,
      simulate the refresh"; don't tune down).
    - Polling (`useClaudeSessionStream`): a 5s loop INDEPENDENT of the
      SSE. `safetyTick` is self-sufficient: full `refetchHistory` until
      the initial load succeeds, then cheap `?since=` delta. **The poll
      is a PROBE: new rows ⇒ clean FULL `refetchHistory()`, never an
      incremental merge** (the old merge corrupted state → infinite
      remount loop). **Cursor = the server's `maxMessageId`** (MAX(id)
      across ALL roles), NOT the window max — trailing attachment rows
      otherwise re-fetch forever. Immediate poll on SSE reconnect /
      visibilitychange / online / mount. Delta 404 → `onKilled`.
    - **Every fetch is timeout-bounded** (`lib/api.ts § send`, 30s / 12s
      delta) — a request issued before device sleep never rejects and
      wedges the inflight guards; on wake `forcePoll()` aborts the hung
      poll. `scheduleReconnect` bails when `navigator.onLine===false`.
    - Session GETs try/catch → clean retryable 503, never an HTML 500.
    - **`SessionErrorBoundary`** wraps ClaudeSessionView + MobileChat:
      a render throw otherwise kills the polling interval permanently.
      Catches → remounts after ~1.5s; escalates to
      `window.location.reload()` at ≥4 errors/8s.
    - Phantom buffer: if the delta finalizes an assistant row that
      prefixes `assistantBufRef`, clear the buffer or the streaming
      preview doubles the message.
    - **Don't remove the polling because "SSE works now"** — polling IS
      the no-freeze contract; SSE is the latency optimization.
25. **`edit_snapshot`/`event` rows drown pagination**: the window query
    counts only chat roles (`NON_PAGINATED_ROLES`); side-channel rows
    load as attachments by id range. Add new side-channel roles there.
26. **Scroll-up pagination**: `?before=<oldestChatId>&limit=200`,
    triggers <400px from visual top (column-reverse); browser anchors
    natively. `refetchHistory()` resets the cursor. On `edits` merge,
    never overwrite a newer entry for the same file_path.
27. **Post-bootstrap, persist `agentPyzSha` immediately** (hello is
    lazy); client patches local state on `install_finished`.
28. **`python -m venv` fails without the venv package** (ensurepip), and
    leaves a PARTIAL venv (bin/python, no pip). Health check is
    `venv_py -m pip --version`; wipe + retry + install `pythonX.Y-venv`
    on ensurepip mention (`bootstrap.ts § install_sdk`).
29. **kill→delete refactor**: only `sleep` is reversible. `'killed'` is
    not a persistent status (don't reuse it as one); it survives only as
    the transient deletion signal → `onKilled`. Keep the TS enum member.
30. **≥3 sequential `sshExec` to one VPS → multiplex** via
    `openSshSession`/`closeSshSession` (ControlMaster, ControlPersist=120)
    in a try/finally — fresh handshakes are slow and can trip
    MaxStartups/fail2ban.
31. **Agent event replay layering**: in-memory ring (RING_SIZE=2000,
    lost on agent restart) + durable log (`event_log.py`, seq, 10MB×3).
    Invariants: `_emit` appends to the log BEFORE broadcast;
    `_recover_seq` must scan rotated files too; Charon's checkpoint
    (`lastSeenSeq` ⇄ DB) persists on landmark events + 2s debounce
    (dup window absorbed by replay dedup); reconnects re-subscribe via
    `_fireSubscribe`/`_pendingAfterSeq` — never a raw
    `call('subscribe')`; replay markers carry no seq.
32. **Optimistic UI for send/sleep/mode** (interactions stay pessimistic,
    #18). `send`: append bubble + `thinking` immediately; dedup against
    the server's `user_echo` via `pendingUserEchoRef` content tokens
    (echoes without a token — other tab — still append); keep the
    bubble on failure. `doSleep`: optimistic flip is always safe
    (`sleepSession` marks DB `sleeping` unconditionally and fires the
    agent RPC fire-and-forget — the agent stop can block 5s). `setMode`:
    revert on POST failure. If you change the synthetic-id format or
    user_echo path, keep the token dedup.
33. *(superseded — earlier shell designs; see #37.)*
34. **False "agent in error" on a healthy VPS**: the SSH proxy is just
    transport; the daemon survives drops. `_handleExit` persists `error`
    only after `ERROR_PERSIST_AFTER_ATTEMPTS` (3) failed reconnects
    (don't lower it); `missing` (exit 127/"not found") stays immediate.
    `vps_status` global events keep badges live (no F5). `error` ≠
    "needs reinstall" — the UI offers "↻ refresh agent"
    (`/agent/refresh`, two-phase, §8) for it; keep that distinction on
    any new surface.
35. **Per-session model/effort = DEFERRED apply**: the SDK binds
    model/effort at client construction; `set_model`/`set_effort` update
    state + emit `*_changed {applied_at_next_start}`; effect at next
    sleep+resume (don't hot-swap — recreating the client forks the
    claude_session_id). **`resumeSession` MUST re-read model/fallback/
    effort from DB and pass them to the fallback `start_session`** or
    resume silently reverts to SDK defaults. Values are resolved from
    `claude.default_*` at CREATE time and persisted (later global edits
    don't retro-apply — by design). Old agents ignore the start_session
    fields; `set_model`/`set_effort` → -32601 = "upgrade the agent".
    Agent-side `_build_options_with_fallback` drops kwargs an older SDK
    rejects (effort → fallback_model → model) and emits an `error` —
    keep the loop. Effort DISPLAY is catalog-driven (#43); VALIDATION is
    still duplicated: SDK `EffortLevel`, agent `VALID_EFFORTS` (silent
    drop), TS `CANONICAL_EFFORTS`/`isKnownEffort`.
36. **"Can't resume" = in-memory status desync**: agent's
    `resume_session` is a NOOP (no `status` event) when already running,
    so a drifted `SessionStream.status` never self-corrected. Fix:
    `resumeSession` adopts the RPC response's status (`resolvedStatus`)
    + reconciles/broadcasts/persists; the reconcile guard also compares
    `stream.status`, not just the DB row. **Invariant: the RPC response,
    not a future event, is the post-resume source of truth.** Diagnose:
    `printf '{"id":1,"method":"list_sessions"}\n' | ssh root@<ip>
    '~/.charon/charon-agent.pyz --connect'`.
37. **Persistent shells = holder PTY + WebSocket** (see #44 for
    survival). Key facts:
    - PTY output flows through `_emit` → durable log
      `~/.charon/shells/<id>.jsonl`. `server.js` bridges WS ↔ its OWN
      ssh+`--connect` proxy per WS (isolated from the TS pool). Binary
      frames = raw bytes; text = JSON control.
    - **Replay = log TAIL (`after_seq:0 + tail_bytes:512KB`), NEVER a
      cursor**: the only copy of rendered scrollback is the browser
      xterm, destroyed on unmount — an incremental cursor yields a blank
      terminal. The tail makes reopen instant and bounds egress
      (trade-off: older scrollback gone, first chunk may start
      mid-ANSI). Browser MUST `term.reset()` on `replay_begin`; don't
      resurrect a `last_seen_seq` cursor. On `exit` close 1000 (= don't
      reconnect); anything else → backoff reconnect.
    - **Terminals stay mounted across switches** (`mountedShellIds` +
      `active` prop; hidden = `display:none`, skip `fit()`). Lazy (only
      shells opened this page-load).
    - **One PTY = one size**: last resize wins across devices.
      `reassertSize()` re-pushes dims on focus/visibility →
      last-active-wins. No ping-pong ONLY because agent `resize()` emits
      no `shell_status` — do NOT make ShellTerminal react to incoming
      status cols/rows.
    - **Reverse proxy MUST forward `Upgrade: websocket`** — the Apache
      vhost needs the RewriteRule → `ws://127.0.0.1:10556` block
      (mod_proxy_wstunnel) BEFORE the catch-all ProxyPass, else endless
      "reconnecting…".
    - `npm run dev|start` both run `server.js`; no node-pty, no tmux.
38. **Typing lag = non-memoized messages + input state colocated with
    the list** (no React Compiler). Fix is BOTH: `memo(Message)` /
    `memo(MobileMessage)` (markdown+highlight is expensive per message)
    AND the textarea isolated in `memo`-wrapped `<ChatInputBar>` /
    `<MobileInputBar>` owning `useInputDraft`. Don't pass fresh inline
    objects as `<Message>` props (defeats memo — parent useMemos them).
    Keep `prefillInput` non-null until the input bar mounts and calls
    `clearPrefillInput()`. Counterpart of #17 (streaming): never O(N)
    work per tick.
39. **`rebuildStateFromMessages` must re-pair `tool_result` →
    `toolCall.result`** (Map keyed by the SDK tool id), mirroring the
    live handler — else after any refetch every tool looks unresolved
    and the ThinkingBar flashes the PREVIOUS turn's last tool.
    `currentTool` is turn-scoped (ignores tools with `startedAt <
    turnStartedAt`); keep `turnStartedAt` declared before `currentTool`
    (TDZ). Change the live pairing ⇒ change the rebuild pairing.
40. **Login preserves `?next=`** (mobile users were bounced to desktop):
    middleware sets `?next=<path+search>` (bare for `/`);
    `app/login/page.tsx` (server component) + hidden field in
    `LoginForm` + `actions.ts` `redirect(next)`. **`sanitizeNextPath`
    (`lib/nextPath.ts`) runs on BOTH read sites** (open-redirect guard:
    `//evil.com`, control chars, `/login` loops → `/`). It must live in
    a PLAIN module, not a `'use server'` file.
41. **`edit_snapshot` content is STRIPPED from the session GET** (real
    incident: 16.5GB/day egress → VPS suspended; one session serialized
    to 59MB and the GET loops every 5s). `stripEditSnapshotContent`
    nulls content (keeps metadata + `contentStripped:true`) in **every
    GET mode — keep it on any new mode**. Diff content comes lazily from
    `GET .../edits` (latest per file, 16MB budget), fetched once per
    view. Client: skeleton edits refilled by `loadEdits`; `mergeEdits`
    is **grow-only** (a reload's null skeleton never clobbers loaded
    content); `editsLoadAttemptedRef` bounds to one fetch per file
    (termination — don't remove). Live SSE `edit_snapshot` still carries
    content. Export keeps full content (one-shot — don't share the strip).
42. **Shell lifecycle over a global output-free watch** — two consumers:
    idle "finished" notifications and live busy/active status.
    - Heuristics (`shell.py § _monitor_idle`, agent-side constants —
      rebuild pyz to change): `shell_idle` after 6s quiet iff the burst
      was consequential (≥3s OR ≥8KB) and no input ≥6s. `shell_status
      busy` on the idle→active output edge if output starts >1s after
      the last keystroke; clear to `active` after 1.5s quiet.
    - **Transport**: NEVER re-stream `shell_output` through Next (the
      #41 egress trap). The persistent AgentClient registers ONE
      `shell_watch` per VPS (fan-out of everything EXCEPT shell_output);
      `shellNotify.ts` gates on `notif.global_enabled` +
      `shell.notify_idle` and pushes; it also `emitGlobalShellStatus` →
      global SSE → `liveStatus` (blue tab). `server.js` separately
      forwards `{type:'idle'}` to the browser.
    - **`shell_idle` + busy/active are TRANSIENT** (no seq, not logged)
      — a tail replay must never resurrect stale frames. Only
      `shell_exit` is durable; current status is recomputed on every
      `shell_subscribe`.
    - The watch is armed ONLY by autoConnect's `connected` hook +
      `agent/refresh` — autoConnect runs on first page SSR, not on API
      calls. `shell_watch`/`unwatch` are separate methods so old agents
      -32601 cleanly. `liveStatus` is bus-fed, NOT seeded (a mid-burst
      shell shows non-busy until the next edge — accepted).
43. **Auto-updating model list — the Claude Code OAuth token CANNOT
    call `GET /v1/models`** (401; verified — don't re-test). Only a real
    `x-api-key` (`claude.api_key`) works, used for the catalog read ONLY
    — sessions keep per-VPS OAuth. Design: seed (`knownModels.ts`, owns
    aliases + labels) ∪ live cache (`modelSync.ts`, 24h TTL, forced via
    Settings → `invalidateModels()` client-side). **Do NOT allowlist
    families** (an `opus|sonnet|haiku` regex silently dropped
    `claude-fable-5` — accept any `^claude-`). The sync captures
    per-model `capabilities.effort` → `<EffortPicker>` derives options
    (∪ `CANONICAL_EFFORTS` fallback); `/effort` validates via
    `isKnownEffort`. `<ModelPicker>` keeps the `✎ custom id` escape hatch.
44. **Shells survive agent restarts: the detached holder** (≥0.10.0).
    The PTY+bash live in `--shell-holder <id>` (start_new_session),
    agent = client over `<id>.sock`; offline output spools (8MB) and
    replays on attach (ordered before live; busy/idle suppressed during
    replay). Footguns:
    - **`KillMode=process` in the systemd-user unit is LOAD-BEARING**
      (setsid does NOT escape the cgroup; default KillMode slaughters
      holders on agent restart). `bootstrap.ts` writes it and
      `updateVpsAgent` REWRITES the unit on every update. Fleet VPS
      losing shells on update → check the unit on disk.
    - **`pkill -f 'charon-agent.pyz$'` — the `$` anchor is load-bearing**
      (holders' cmdline continues past `.pyz`); two sites in bootstrap.ts.
    - **The holder never lazy-imports** (zipapp gets replaced on update;
      post-swap imports load mismatched code). All imports at top.
    - **Phantom-shell pruning, three paths, all needed**: Charon boot
      (`reconcileShellsOnBoot`), every agent (re)connect
      (`onShellSnapshot` → shellNotify reconcile + `exited` emit), live
      failure (`server.js` on shell_subscribe -32000 → prune row +
      `{type:'gone'}` + close 1000). New death-detection points follow
      the same recipe — anything else reintroduces the infinite
      "reconnecting…" loop.
    - `lib/server/agent/sshShared.js` (plain CJS): single source of the
      agent ssh argv for AgentClient.ts AND server.js, with per-VPS
      ControlMaster mux (stale control socket degrades to direct).

---

## 15. Quick lookup (non-obvious entry points)

| Question | File(s) |
|---|---|
| Protocol TS/Py mirror | `lib/server/agent/types.ts` ↔ `agent/charon_agent/protocol.py` |
| Events ⇄ DB ⇄ SSE bridge | `lib/server/agent/sessionOps.ts` |
| Boot init (migrate + autoConnect + reconcile) | `lib/server/seed.ts`, `autoConnect.ts` |
| SSE conn registry, low/high routing | `lib/server/agent/eventConnections.ts` |
| Singleton browser SSE (reconnect/watchdog/auto-reload) | `app/globalEventStream.ts` |
| Delta polling + abort-on-wake | `useClaudeSessionStream.ts § pollDelta/forcePoll` + `?since=` in the `[id]` route |
| Pagination window / snapshot strip | `app/api/claude/sessions/[id]/route.ts § loadMessageWindow / stripEditSnapshotContent` + `edits/route.ts` |
| Durable event log replay | `event_log.py` + `lastSeenSeq` (sessionOps) + `_pendingAfterSeq` (AgentClient) |
| Shells (holder, WS bridge, xterm) | `holder.py` + `shell.py` + `server.js` + `app/ShellTerminal.tsx` |
| Phantom-shell prune | `STMT_DELETE_SHELL`/`gone` (server.js) + `onShellSnapshot` (AgentClient) + `shellNotify.ts` |
| Shared ssh argv + ControlMaster | `lib/server/agent/sshShared.js` |
| Shell idle notify + busy status | `_monitor_idle` (shell.py) + `shell_watch` fan-out (server.py) + `shellNotify.ts` |
| Agent-status classification / refresh | `_handleExit`/`ERROR_PERSIST_AFTER_ATTEMPTS` (AgentClient) + `agent/refresh` route + `ensureAgentRunning` |
| Model/effort deferred apply | `set_model`/`_build_options_with_fallback` (session.py) + `_resolveClaudeConfig` (sessionOps) |
| Model catalog sync / effort options | `lib/server/claude/modelSync.ts` + `knownModels.ts` + `app/EffortPicker.tsx` |
| Resume noop reconcile | `resumeSession § resolvedStatus` (sessionOps) + noop in `server.py` |
| Login `?next=` + open-redirect guard | `lib/nextPath.ts § sanitizeNextPath` + `middleware.ts` + `app/login/*` |
| Mobile quick-nav (shared select strip + chat overlay) | `app/m/quickNav.tsx § computeQuickNavGroups` |

---

## 16. Commands to know

```bash
npm run dev                                # dev, 127.0.0.1:10556
npm run build && systemctl restart charon  # prod — ALWAYS chained, NO --turbopack
journalctl -u charon -f
npm run db:generate && npm run db:migrate  # after editing schema.ts
sqlite3 data/charon.db
bash agent/build.sh                        # rebuild the .pyz
# VPS debug:
ssh root@<ip> systemctl --user status charon-agent
ssh root@<ip> tail -f .charon/agent.log
echo '{"id":1,"method":"ping"}' | ssh root@<ip> ~/.charon/charon-agent.pyz --connect
```

---

## 17. When you touch the repo

If a change alters a fact documented here, **update this CLAUDE.md in
the same commit** (top banner).

- **JSON-RPC protocol**: edit `server.py` (dispatch), `protocol.py`
  (METHODS), `lib/server/agent/types.ts` (`AgentMethodName` AND
  `AgentEvent`), `AgentClient.ts` (wrapper); bump `__version__`; rebuild
  the pyz (sha change → fleet shows "out of date"). → update §6. The
  prebuild `check-protocol-sync.mjs` fails the build on METHODS drift.
- **New event**: `_emit(...)` in `session.py` (it stamps `seq`/`ts` —
  the payload must not pre-carry those keys; pure client-side hints go
  AFTER the broadcast, not inside `_emit`), type in `types.ts`, handlers
  in `sessionOps.ts` + client. → update §6 + §9 tables.
- **DB field**: `schema.ts` → generate → **check the SQL** → migrate →
  commit .sql + meta. → update §4.
- **New API route**: `route.ts` + wrapper in `lib/api.ts` + types in
  `lib/types/api.ts`. → update §8.
- **Permissions/SDK hooks**: `agent/charon_agent/session.py`
  (`_pre_tool_use`, `_can_use_tool`, `_is_safe_bash`).
- **Infra change**: → update §3/§5, gotcha in §14 if subtle.
- **New footgun**: → §14, in place, keep numbering.
