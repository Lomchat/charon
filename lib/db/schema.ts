import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  keyCheck: text('key_check').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull()
});

// Folders for organizing VPSes in the sidebar/UI.
// Every VPS necessarily belongs to a folder (cf. `vps.folderId`).
// A default folder (id='default') is created by migration 0006; it is
// protected from deletion (cf. /api/vps-folders/[id] DELETE).
// `position` orders the folders among themselves (drag-and-drop in DataModal).
// `collapsed` is the collapsed/expanded state in the sidebar (persisted in DB
// to be synced cross-device, unlike the per-VPS flag that lives in
// localStorage with the key `hub.claude.collapsedVps.v2`).
export const vpsFolders = sqliteTable('vps_folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  collapsed: integer('collapsed').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

export const vps = sqliteTable('vps', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ip: text('ip').notNull(),
  sshUser: text('ssh_user').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  defaultPath: text('default_path'),
  // Parent folder (cf. `vps_folders`). Always non-null; VPSes
  // created without an explicit folderId fall into the 'default' folder via
  // DEFAULT SQL. The FK is not enforced on the SQLite side (ALTER ADD COLUMN
  // limitation), only validated on the application side.
  folderId: text('folder_id').notNull().default('default').references(() => vpsFolders.id),
  // Order within the folder (monotone integer, managed via batch reorder).
  position: integer('position').notNull().default(0),
  // Status of the agent installed on this VPS.
  //   'unknown'  : never tested (default)
  //   'ok'       : recent ping succeeded
  //   'missing'  : no agent (to install)
  //   'error'    : agent installed but unresponsive
  agentStatus: text('agent_status').notNull().default('unknown'),
  // Classified reason for the LAST agentStatus='error' persist, so the UI can
  // tell "the VPS itself is unreachable" apart from "SSH is fine but the agent
  // daemon is down". Format: '<code>: <first stderr line>' where code ∈
  //   'ssh-auth'        — SSH reached the host but auth failed (key refused)
  //   'ssh-unreachable' — SSH could not reach the host (down/network/firewall)
  //   'daemon-down'     — SSH ok, pyz present, but the daemon isn't running
  //                       (--connect exit 2/3: socket absent / connect failed)
  //   'error'           — anything else (generic drop)
  // NULL when agentStatus is 'ok' (cleared on every hello) or 'missing' (SSH
  // provably worked — the remote command ran and said "no pyz"). Written by
  // AgentClient._handleExit + the agent/refresh route; consumed by
  // app/vpsHealth.tsx (parseAgentLastError) for the health chips.
  agentLastError: text('agent_last_error'),
  agentVersion: text('agent_version'),
  // Hash of the .pyz running on the VPS (first 12 chars of the sha256). Used
  // by the dashboard to detect "agent out of date" without depending on the
  // manual bump of __version__. Compared to the sha of the .pyz embedded in
  // the dashboard.
  agentPyzSha: text('agent_pyz_sha'),
  // Version of the `claude-agent-sdk` python package installed in the VPS's
  // venv, as reported by the agent's `hello` (>= 0.12.0). Compared to the
  // PyPI latest (settings `sdk.latest_version`, cf. sdkSync.ts) to flag
  // outdated fleets. NULL = unknown (old agent / never connected). Old
  // agents' hellos must NOT null-clobber this (cf. AgentClient.ts).
  sdkVersion: text('sdk_version'),
  agentLastSeenAt: integer('agent_last_seen_at'),
  // State of `claude login` on this VPS. 1 = logged in (oauth.refresh_token
  // present), 0 = not logged in, NULL = never checked. Used to hide the
  // "claude login" button in the sidebar when not needed. Updated by:
  // - `check_login` phase of the bootstrap (cf. bootstrap.ts)
  // - POST /api/vps/[id]/claude/check-login (triggered when the
  //   the login modal closes, or on demand)
  claudeLoggedIn: integer('claude_logged_in'),
  claudeLoggedInCheckedAt: integer('claude_logged_in_checked_at'),
  // ── Codex (OpenAI) availability on this VPS (multi-agent support). ──
  // codexAvailable: 1/0/NULL — whether the `openai-codex` Python SDK is
  // importable in the VPS venv, as reported by the agent's `hello`
  // (codex_available, agent >= 0.15.0). NULL = unknown / old agent.
  // Old-agent hellos (no codex_* fields) must NOT null-clobber these
  // (cf. AgentClient.ts, §14.53 no-null-clobber rule).
  codexAvailable: integer('codex_available'),
  // Version of `openai-codex` in the venv (hello.codex_sdk_version). Compared
  // to the PyPI latest (settings `codex.latest_version`) to flag outdated
  // fleets, mirroring sdkVersion for Claude.
  codexSdkVersion: text('codex_sdk_version'),
  // Version of the standalone @openai/codex app-server selected by the
  // Python SDK via CodexConfig.codex_bin. The Python wrapper can lag the CLI,
  // so this is a separate freshness axis (hello.codex_cli_version).
  codexCliVersion: text('codex_cli_version'),
  // State of `codex login` on this VPS. 1 = logged in (~/.codex/auth.json has
  // tokens), 0 = not, NULL = never checked. Mirrors claudeLoggedIn.
  codexLoggedIn: integer('codex_logged_in'),
  codexLoggedInCheckedAt: integer('codex_logged_in_checked_at'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

// Known paths on each VPS — used to group sessions in the sidebar.
// The `label` is optional (auto-derived from the path's basename if absent).
// One row per (vps_id, path) pair — no UNIQUE SQL constraint to stay
// flexible on the sync side; dedup is done at insert (sync) / UI time.
export const vpsPaths = sqliteTable('vps_paths', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  label: text('label'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
}, (t) => [
  // Sidebar groupings: GET /api/vps-paths filtered by vpsId.
  index('idx_vps_paths_vps_id').on(t.vpsId),
  // Natural key (P2.4): one row per (vps, path). The application paths
  // (/api/sync, POST /api/vps-paths) deduped applicatively before — the
  // constraint makes races impossible. Migration 0024 deduped existing
  // rows (keep MIN(id)) before creating the index.
  uniqueIndex('uq_vps_paths_vps_id_path').on(t.vpsId, t.path),
]);

export const claudeSessions = sqliteTable('claude_sessions', {
  id: text('id').primaryKey(),
  claudeSessionId: text('claude_session_id'),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  // Sidebar order INSIDE a VPS. 0 for every pre-existing row, which sorts
  // them by createdAt exactly as before — the list only changes once
  // something is actually dragged.
  position: integer('position').notNull().default(0),
  cwd: text('cwd').notNull(),
  name: text('name'),
  // Visual marker: color (hex or name) applied to the left border of
  // the row in the sidebar. NULL = no marker.
  color: text('color'),
  status: text('status').notNull(),
  // Agent-type discriminator: 'claude' (default) | 'codex'. Determines which
  // backend drives the session (ClaudeSDKClient vs the Codex app-server via
  // openai-codex) and how the hub resolves config/model/effort/mode + which
  // logo the sidebar paints. For a Codex session, claudeSessionId holds the
  // Codex THREAD id (the resume handle), permissionMode holds a Codex sandbox
  // mode ('read-only' | 'workspace-write' | 'full-access'), effort is a Codex
  // reasoning-effort, model is a Codex model id, and fallbackModel is unused
  // (Codex has no fallback-model concept). cf. CLAUDE.md §14.59.
  kind: text('kind').notNull().default('claude'),
  permissionMode: text('permission_mode').notNull().default('normal'),
  // Last `seq` from the agent's durable event log that Charon has
  // successfully persisted. Used on reconnect to call
  // subscribe({after_seq: lastSeenSeq}) — the agent then replays
  // exactly the missed events instead of being bound by the
  // in-memory ring (cf. agent/charon_agent/event_log.py).
  // Null until the first event from an agent >= 0.4.0 lands.
  lastSeenSeq: integer('last_seen_seq'),
  // Highest `seq` of a `stop` event for which we've already emitted a
  // "Claude finished" push notification. Prevents re-notifying the same
  // finish when the agent replays events on reconnect (Charon reboot, SSH
  // reconnect). A genuinely new finish has a higher seq → notifies once.
  // Null = never notified a finish yet.
  lastStopNotifiedSeq: integer('last_stop_notified_seq'),
  // Durable "finished but you haven't opened it yet" marker (0/1). Set to 1
  // when a turn ends (`stop`) and nobody is currently viewing the session, so
  // the sidebar can paint a green "finished — unread" glow that SURVIVES
  // reloads and is shared across devices (DB is the source of truth, not a
  // per-device localStorage flag). Cleared back to 0 when the user opens /
  // focuses the session (POST /api/claude/focus → markSessionRead), live across
  // tabs via the `session_unread` SSE event. Independent of
  // lastStopNotifiedSeq (which dedups PUSH notifications) — this one is a
  // passive in-app cue, only for Claude sessions. cf. CLAUDE.md §14.47.
  unreadStop: integer('unread_stop').notNull().default(0),
  // Per-session Claude model / fallback / effort. All three NULL by default
  // → use the global default from claude_settings; if the global default is
  // also NULL, the agent passes nothing to ClaudeAgentOptions and the SDK
  // applies its own default.
  // - model / fallback_model: free strings (model IDs like
  //   'claude-opus-4-7-...', 'claude-opus-4-8-...'). fallback_model is used
  //   by the SDK when the primary is rate-limited.
  // - effort: one of 'low' | 'medium' | 'high' | 'xhigh' | 'max' (mirrors
  //   claude_agent_sdk.EffortLevel). Invalid values are dropped agent-side.
  // Changes apply at the NEXT SDK start (sleep+resume) — the underlying
  // Claude SDK session is bound to a model at construction.
  model: text('model'),
  fallbackModel: text('fallback_model'),
  effort: text('effort'),
  codexConfig: text('codex_config'),
  // Codex app-server archive state. Archived rows stay in SQLite with their
  // complete Charon transcript, but disappear from the normal sidebar/list;
  // the resume/import modal can unarchive them through the SDK. Claude rows
  // always keep the default 0 because Claude has no native archive primitive.
  archived: integer('archived').notNull().default(0),
  // The model id Anthropic ACTUALLY used on the last assistant turn, captured
  // from the agent's `effective_model` event (AssistantMessage.model — API
  // truth, not the configured value above: aliases resolve, fallback_model can
  // kick in, the SDK may pick a default). Persisted so it survives Charon
  // restarts (the agent only re-emits on CHANGE) — hydrates
  // SessionStream.effectiveModel, which stamps each flushed assistant message
  // row (claude_session_messages.model). NULL until the first turn on an
  // agent >= 0.6.0.
  effectiveModel: text('effective_model'),
  // Durable "the user asked this session to sleep" intent (0/1). Set by
  // sleepSession / forceStopSession; cleared when the agent confirms 'sleeping'
  // or on resume. Guards against reconcileVpsAgentState RESURRECTING a session
  // whose sleep RPC never reached the agent (agent was down at sleep time, then
  // restored the session as 'active' from state.json → reconcile would
  // otherwise flip the DB back to 'active'). cf. CLAUDE.md §14.46.
  sleepRequested: integer('sleep_requested').notNull().default(0),
  // Durable MIRROR of sleepRequested: "this session was put to sleep by an
  // AGENT UPDATE and must be brought back up" (0/1). Set by runAgentUpdateFlow
  // on its pre-update snapshot (BEFORE the SIGTERM), cleared when a resume
  // succeeds, when the agent reports the session running (reconcile), or when
  // the user explicitly sleeps it (their intent wins). Recovery sweeps
  // (autoConnect boot + reconcile-on-connect) resume any 'sleeping' session
  // carrying this flag — the old fire-and-forget resume promises died with a
  // hub restart mid-update and left sessions asleep forever (real incident:
  // WS_MASTER 2026-07-22). cf. CLAUDE.md §14.62.
  resumePending: integer('resume_pending').notNull().default(0),
  // Tools the user answered "always allow" for, as a JSON array of tool names.
  //
  // §14.8 recorded this set as in-memory "by design", the permanent escape
  // hatch being permission_mode='auto'. In practice the hub restarts far more
  // often than a session's lifetime (every deploy), so the answer was re-asked
  // for work the user had already approved minutes earlier.
  //
  // Deliberately NOT the SDK's `updated_permissions`: its only persistent
  // destination is `localSettings`, i.e. `.claude/settings.local.json` inside
  // the user's repo — which Charon does not even load (setting_sources is
  // ['project']), so the rule would be written and never read again. Keeping
  // the authority hub-side also keeps it revocable from the UI.
  alwaysAllowTools: text('always_allow_tools'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  lastUsedAt: integer('last_used_at')
});

export const claudeSessionMessages = sqliteTable('claude_session_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  // Compact representation used by the looping chat API. `content` remains
  // the lossless source for export/replay and lazy detail endpoints, while
  // oversized tool results and edit snapshots can have a metadata/preview
  // form here. NULL means "the full content is already cheap".
  wireContent: text('wire_content'),
  // Normalized edit-snapshot metadata. Besides avoiding json_extract over
  // hundreds of MB in /edits, these columns let SQLite's index identify the
  // latest snapshot for each file/phase before reading any file body.
  snapshotFilePath: text('snapshot_file_path'),
  snapshotPhase: text('snapshot_phase'),
  snapshotToolUseId: text('snapshot_tool_use_id'),
  snapshotTruncated: integer('snapshot_truncated'),
  // For role='assistant' rows only: the model id Anthropic actually served
  // this message with (stamped at flush time from the stream's
  // effectiveModel — see sessionOps._flushAssistant). Lets the UI label every
  // assistant bubble with the true model ("who is speaking"), immune to the
  // model's own hallucinated self-identification. NULL on other roles, on
  // rows persisted before this column existed, and until the agent (>= 0.6.0)
  // has reported an effective model.
  model: text('model'),
  // Durable-log seq of the agent event that produced this row (the flush
  // trigger for accumulated assistant text). THE replay-idempotence anchor
  // (P0.2/P0.3): on replay_begin the stream loads MAX(seq) and skips any
  // replayed event with seq <= that — dedup by event IDENTITY, not by
  // content (two legitimate identical "Done." answers can never be
  // confused again). NULL on rows persisted before 2026-07-22, on user
  // rows (hub-originated, no agent event), and with pre-0.4.0 agents
  // (no seq → legacy content dedup applies).
  seq: integer('seq'),
  // WHEN this row's event actually happened, in unix MILLISECONDS — the
  // agent's `ts` (durable log, emitted next to `seq`) rounded to ms, and
  // `Date.now()` for hub-originated rows (user messages).
  //
  // THE chronological sort key (§14.71). It exists because `seq` cannot be
  // one: seq is per-session and RESTARTS AT 1 whenever the agent's event log
  // is recreated, which silently buried every reply of the new epoch in the
  // middle of the transcript (8 of 16 live sessions were in that state).
  // Wall-clock time has no epochs. It also orders a REPAIRED row correctly
  // for free — the row is inserted late but carries the ts of the moment it
  // belongs to — which is exactly what `seq` was being abused for.
  //
  // NOT `created_at`: that one is INSERT time at SECOND granularity (a
  // repaired row would sort at the end, and a whole turn shares one value).
  // Backfilled from `created_at * 1000` by migration 0026, so no row is NULL
  // in practice; the column stays nullable only so the backfill and any
  // pre-0026 writer degrade instead of failing.
  // The CLI transcript's own UUID for this message (assistant rows only).
  //
  // Forking branches at a transcript entry, and the SDK identifies that entry
  // by ITS uuid — not by anything Charon assigns. Without this column the only
  // possible fork is "the whole conversation"; with it, "fork from here" is a
  // per-message action. Null on user rows, side-channel rows, and everything
  // persisted before agent 0.39.0.
  cliUuid: text('cli_uuid'),
  tsMs: integer('ts_ms'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
}, (t) => [
  // Hot path: window query (session_id + id range), delta polling
  // (session_id + id > since), pagination (session_id + id < before).
  // The autoincrement PK already indexes `id` alone, but the FK on
  // session_id has no automatic index in SQLite. The compound
  // (session_id, id) is the right shape for every chat read query.
  index('idx_claude_session_messages_session_id_id').on(t.sessionId, t.id),
  // Chronological page seek — replaces a full-session JS sort per GET.
  index('idx_claude_session_messages_session_ts_id').on(t.sessionId, t.tsMs, t.id),
  // Durable replay checks select only identities for one session.
  index('idx_claude_session_messages_session_seq').on(t.sessionId, t.seq),
  // Latest before/after snapshot per path without parsing every JSON body.
  index('idx_claude_session_messages_snapshot_lookup')
    .on(t.sessionId, t.role, t.snapshotFilePath, t.snapshotPhase, t.id),
]);

export const claudePendingPermissions = sqliteTable('claude_pending_permissions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  toolInput: text('tool_input').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  respondedAt: integer('responded_at')
}, (t) => [
  // GET session detail + SSE init snapshot filter by (session_id, status='pending').
  index('idx_claude_pending_permissions_session_id_status').on(t.sessionId, t.status),
]);

// Pending interactive questions (AskUserQuestion). We persist them so we can
// re-emit them to clients that reconnect or switch tabs.
// kind='question' = AskUserQuestion, kind='exit_plan' = ExitPlanMode review.
export const claudePendingQuestions = sqliteTable('claude_pending_questions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull().default('pending'),
  answers: text('answers'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  respondedAt: integer('responded_at'),
}, (t) => [
  // GET session detail + SSE init snapshot filter by (session_id, status='pending').
  // `kind` is post-filtered in JS — too few distinct values to add to the index.
  index('idx_claude_pending_questions_session_id_status').on(t.sessionId, t.status),
]);

// Files the user attached to a session (drag & drop / paperclip). Charon does
// NOT feed these to the model as inline content blocks: it drops the file on
// the VPS filesystem and writes the PATH into the prompt. Both backends then
// pick it up with their own built-in tool — Claude Code's `Read` (images, PDF,
// notebooks, text) and Codex's `view_image` (+ shell for everything else). That
// is why NO mime filtering happens anywhere: whether a given file is usable is
// the agent's call, not ours.
//
// Two copies exist and they serve different masters:
//  - `remotePath` on the VPS (under <cwd>/.charon-uploads/) is what the AGENT
//    reads. Inside the cwd on purpose: Codex sandbox levels are scoped to the
//    workspace and `view_image` resolves relative to it, so a path outside is a
//    gamble on both backends.
//  - `localPath` on the hub (data/uploads/<sessionId>/) is what the USER
//    re-downloads from the Files tab. It also means the attachment list stays
//    meaningful after the VPS is wiped or the session is moved.
// Deleting the session cascades this table; the hub blobs are swept by
// deleteSession, the remote copy is left to the VPS (best-effort unlink only
// on explicit per-file delete).
export const claudeSessionAttachments = sqliteTable('claude_session_attachments', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  // Original filename as sent by the browser, sanitised to a single path
  // segment (no separators, no leading dot-dot). Display + download name.
  name: text('name').notNull(),
  // Absolute path on the VPS — the exact string injected into the prompt.
  // Unique per session (collisions get a numeric suffix at upload time), so a
  // re-upload of the same name never silently shadows an older attachment the
  // conversation still references.
  remotePath: text('remote_path').notNull(),
  // Path of the hub-side copy, relative to the uploads root. Nullable so a row
  // survives its blob going missing (manual cleanup, disk restore).
  localPath: text('local_path'),
  size: integer('size').notNull(),
  // Browser-reported MIME. Informational ONLY — never used to accept, reject
  // or route a file. Empty string when the browser doesn't know.
  mime: text('mime'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => [
  // The Files tab lists by session, newest first.
  index('idx_claude_session_attachments_session_id_id').on(t.sessionId, t.createdAt),
]);

export const claudeSessionLogs = sqliteTable('claude_session_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id'),
  level: text('level').notNull(),
  event: text('event').notNull(),
  detail: text('detail'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
}, (t) => [
  // auto_resume + debug queries filter by sessionId then order by id.
  index('idx_claude_session_logs_session_id_id').on(t.sessionId, t.id),
]);

// Persistent SSH shells. The PTY (bash) lives in a DETACHED holder process
// on the VPS (agent/charon_agent/holder.py, agent >= 0.10.0) so it survives
// both Charon AND agent restarts; the agent re-attaches to holders at boot.
// This table is the Charon-side index: one row per shell, used to re-list
// (over WebSocket via server.js) and to materialise the sidebar entry.
// Rows are pruned when the agent doesn't know the shell anymore (VPS
// reboot, bash exited): at Charon boot (reconcileShellsOnBoot), on every
// agent (re)connect (shellNotify's shell_watch snapshot reconcile), and on
// a failed shell_subscribe (server.js prunes + tells the browser 'gone').
// No replay cursor here: shell scrollback lives only in the browser xterm,
// so every WS (re)connect replays the durable-log TAIL from scratch
// (`after_seq:0 + tail_bytes` — see CLAUDE.md §14 gotcha 37). The old
// vestigial `last_seen_seq` column was dropped in migration 0016.
export const shells = sqliteTable('shells', {
  id: text('id').primaryKey(),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  cwd: text('cwd'),
  name: text('name'),
  color: text('color'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
}, (t) => [
  // GET /api/vps/[id]/shells + boot reconcile filter by vpsId.
  index('idx_shells_vps_id').on(t.vpsId),
]);

/**
 * Open editor tabs — the workspace layout, persisted (§14.78).
 *
 * Before this table the tab bar WAS the session list: every non-sleeping
 * session was a tab and you could not close one without touching the session.
 * Tabs are now their own thing — closing one is a view operation, and the
 * session keeps running and stays in the sidebar.
 *
 * Grouping is `(vpsId, path)`. The path level is what makes several projects on
 * one VPS legible, and it is also the natural home for a file: a file tab and
 * the session that edits it belong to the same folder.
 *
 * `ref` is polymorphic ON PURPOSE rather than four nullable FK columns: with
 * NULLs, SQLite's UNIQUE would not dedupe (NULL != NULL) and the "one tab per
 * thing" rule would have to live in application code. Session/shell/install
 * tabs hold the entity id; file tabs hold the path relative to `path`. There
 * is no FK — the referent lives in three different tables, and `reconcileTabs`
 * is what drops rows whose thing is gone.
 *
 * A single row holds `active = 1`. Enforced in one transaction hub-side rather
 * than by a partial unique index, which SQLite would let us create but which
 * would turn every switch into a constraint dance.
 */
export const tabs = sqliteTable('tabs', {
  id: text('id').primaryKey(),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  // Group key. The session/shell cwd, or the containing folder for a file.
  // '' for the pathless (installs), which get their own group.
  path: text('path').notNull(),
  // 'session' | 'shell' | 'install' | 'file'
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  // 0 = temporary (italic, one per group, replaced by the next open),
  // 1 = pinned. cf. §14.78.
  pinned: integer('pinned').notNull().default(0),
  /** Order within the (vpsId, path) group — row 3. */
  position: integer('position').notNull().default(0),
  /** Order of this VPS in row 1, and of this group in row 2.
   *
   *  Denormalised on purpose: every row of a VPS carries the same `vpsPos`,
   *  every row of a group the same `groupPos`. A second table would need a
   *  join on every read of a strip that is re-rendered constantly, and both
   *  values are only ever written by one statement scoped to exactly the rows
   *  that must agree (`WHERE vps_id = ?` / `… AND path = ?`), so they cannot
   *  drift. Row 1's order is the TAB BAR's own — dragging a tab must not
   *  reshuffle the sidebar, which keeps `vps.position`. */
  vpsPos: integer('vps_pos').notNull().default(0),
  groupPos: integer('group_pos').notNull().default(0),
  active: integer('active').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (t) => [
  index('idx_tabs_vps_id').on(t.vpsId),
  // One tab per thing per group — what makes "open" idempotent.
  uniqueIndex('uq_tabs_vps_path_kind_ref').on(t.vpsId, t.path, t.kind, t.ref),
]);

export const claudeSettings = sqliteTable('claude_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`)
});

export const claudePushSubs = sqliteTable('claude_push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  authKey: text('auth_key').notNull(),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  lastUsedAt: integer('last_used_at')
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Vps = typeof vps.$inferSelect;
export type VpsFolder = typeof vpsFolders.$inferSelect;
export type VpsPath = typeof vpsPaths.$inferSelect;
export type ClaudeSession = typeof claudeSessions.$inferSelect;
export type ClaudeSessionMessageRow = typeof claudeSessionMessages.$inferSelect;
// Internal compact-storage fields are deliberately not part of the API type:
// route projections expose `wireContent ?? content` under the original
// `content` key and never leak a second copy or implementation metadata.
export type ClaudeSessionMessage = Omit<ClaudeSessionMessageRow,
  'wireContent' | 'snapshotFilePath' | 'snapshotPhase' |
  'snapshotToolUseId' | 'snapshotTruncated'>;
export type ClaudePendingPermission = typeof claudePendingPermissions.$inferSelect;
export type ClaudePendingQuestion = typeof claudePendingQuestions.$inferSelect;
export type ClaudeSessionAttachment = typeof claudeSessionAttachments.$inferSelect;
export type ClaudeSessionLog = typeof claudeSessionLogs.$inferSelect;
export type Shell = typeof shells.$inferSelect;
export type TabRow = typeof tabs.$inferSelect;
export type ClaudeSetting = typeof claudeSettings.$inferSelect;
export type ClaudePushSub = typeof claudePushSubs.$inferSelect;
