import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
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
  agentVersion: text('agent_version'),
  // Hash of the .pyz running on the VPS (first 12 chars of the sha256). Used
  // by the dashboard to detect "agent out of date" without depending on the
  // manual bump of __version__. Compared to the sha of the .pyz embedded in
  // the dashboard.
  agentPyzSha: text('agent_pyz_sha'),
  agentLastSeenAt: integer('agent_last_seen_at'),
  // State of `claude login` on this VPS. 1 = logged in (oauth.refresh_token
  // present), 0 = not logged in, NULL = never checked. Used to hide the
  // "claude login" button in the sidebar when not needed. Updated by:
  // - `check_login` phase of the bootstrap (cf. bootstrap.ts)
  // - POST /api/vps/[id]/claude/check-login (triggered when the
  //   LoginConsole closes, or on demand)
  claudeLoggedIn: integer('claude_logged_in'),
  claudeLoggedInCheckedAt: integer('claude_logged_in_checked_at'),
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
]);

export const claudeSessions = sqliteTable('claude_sessions', {
  id: text('id').primaryKey(),
  claudeSessionId: text('claude_session_id'),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  cwd: text('cwd').notNull(),
  name: text('name'),
  // Visual marker: color (hex or name) applied to the left border of
  // the row in the sidebar. NULL = no marker.
  color: text('color'),
  status: text('status').notNull(),
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
  // Durable "the user asked this session to sleep" intent (0/1). Set by
  // sleepSession / forceStopSession; cleared when the agent confirms 'sleeping'
  // or on resume. Guards against reconcileVpsAgentState RESURRECTING a session
  // whose sleep RPC never reached the agent (agent was down at sleep time, then
  // restored the session as 'active' from state.json → reconcile would
  // otherwise flip the DB back to 'active'). cf. CLAUDE.md §14.46.
  sleepRequested: integer('sleep_requested').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  lastUsedAt: integer('last_used_at')
});

export const claudeSessionMessages = sqliteTable('claude_session_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
}, (t) => [
  // Hot path: window query (session_id + id range), delta polling
  // (session_id + id > since), pagination (session_id + id < before).
  // The autoincrement PK already indexes `id` alone, but the FK on
  // session_id has no automatic index in SQLite. The compound
  // (session_id, id) is the right shape for every chat read query.
  index('idx_claude_session_messages_session_id_id').on(t.sessionId, t.id),
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
export type ClaudeSessionMessage = typeof claudeSessionMessages.$inferSelect;
export type ClaudePendingPermission = typeof claudePendingPermissions.$inferSelect;
export type ClaudePendingQuestion = typeof claudePendingQuestions.$inferSelect;
export type ClaudeSessionLog = typeof claudeSessionLogs.$inferSelect;
export type Shell = typeof shells.$inferSelect;
export type ClaudeSetting = typeof claudeSettings.$inferSelect;
export type ClaudePushSub = typeof claudePushSubs.$inferSelect;
