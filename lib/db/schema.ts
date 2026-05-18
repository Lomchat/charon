import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
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

export const vps = sqliteTable('vps', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ip: text('ip').notNull(),
  sshUser: text('ssh_user').notNull(),
  sshPort: integer('ssh_port').notNull().default(22),
  defaultPath: text('default_path'),
  // Statut de l'agent installé sur ce VPS.
  //   'unknown'  : jamais testé (par défaut)
  //   'ok'       : ping récent réussi
  //   'missing'  : pas d'agent (à installer)
  //   'error'    : agent installé mais ne répond pas
  agentStatus: text('agent_status').notNull().default('unknown'),
  agentVersion: text('agent_version'),
  agentLastSeenAt: integer('agent_last_seen_at'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

// Paths connus sur chaque VPS — sert à grouper les sessions dans la sidebar.
// Le `label` est optionnel (auto-dérivé du basename du path si absent).
// Une ligne par couple (vps_id, path) — pas d'unique contrainte SQL pour
// rester souple côté sync ; la dédup est faite à l'insert (sync) / l'UI.
export const vpsPaths = sqliteTable('vps_paths', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  label: text('label'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

export const claudeSessions = sqliteTable('claude_sessions', {
  id: text('id').primaryKey(),
  claudeSessionId: text('claude_session_id'),
  vpsId: text('vps_id').notNull().references(() => vps.id, { onDelete: 'cascade' }),
  cwd: text('cwd').notNull(),
  name: text('name'),
  status: text('status').notNull(),
  permissionMode: text('permission_mode').notNull().default('normal'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  lastUsedAt: integer('last_used_at')
});

export const claudeSessionMessages = sqliteTable('claude_session_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

export const claudePendingPermissions = sqliteTable('claude_pending_permissions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => claudeSessions.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  toolInput: text('tool_input').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  respondedAt: integer('responded_at')
});

// Questions interactives (AskUserQuestion) en attente. On les persiste pour
// pouvoir les re-émettre aux clients qui se reconnectent ou changent d'onglet.
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
});

export const claudeSessionLogs = sqliteTable('claude_session_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id'),
  level: text('level').notNull(),
  event: text('event').notNull(),
  detail: text('detail'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`)
});

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
export type VpsPath = typeof vpsPaths.$inferSelect;
export type ClaudeSession = typeof claudeSessions.$inferSelect;
export type ClaudeSessionMessage = typeof claudeSessionMessages.$inferSelect;
export type ClaudePendingPermission = typeof claudePendingPermissions.$inferSelect;
export type ClaudePendingQuestion = typeof claudePendingQuestions.$inferSelect;
export type ClaudeSessionLog = typeof claudeSessionLogs.$inferSelect;
export type ClaudeSetting = typeof claudeSettings.$inferSelect;
export type ClaudePushSub = typeof claudePushSubs.$inferSelect;
