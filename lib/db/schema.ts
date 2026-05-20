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

// Dossiers d'organisation des VPS dans la sidebar/UI.
// Chaque VPS appartient obligatoirement à un dossier (cf. `vps.folderId`).
// Un dossier par défaut (id='default') est créé par la migration 0006 ; il
// est protégé contre la suppression (cf. /api/vps-folders/[id] DELETE).
// `position` ordonne les dossiers entre eux (drag-and-drop dans DataModal).
// `collapsed` est l'état replié/déplié dans la sidebar (persisté DB pour
// être synchro cross-device, contrairement au flag par-VPS qui vit en
// localStorage avec la clé `hub.claude.collapsedVps.v2`).
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
  // Dossier d'appartenance (cf. `vps_folders`). Toujours non-null ; les VPS
  // créés sans folderId explicite tombent dans le dossier 'default' via
  // DEFAULT SQL. La FK n'est pas enforced côté SQLite (ALTER ADD COLUMN
  // limitation), seulement validée côté application.
  folderId: text('folder_id').notNull().default('default').references(() => vpsFolders.id),
  // Ordre dans le dossier (entier monotone, géré via batch reorder).
  position: integer('position').notNull().default(0),
  // Statut de l'agent installé sur ce VPS.
  //   'unknown'  : jamais testé (par défaut)
  //   'ok'       : ping récent réussi
  //   'missing'  : pas d'agent (à installer)
  //   'error'    : agent installé mais ne répond pas
  agentStatus: text('agent_status').notNull().default('unknown'),
  agentVersion: text('agent_version'),
  // Hash du .pyz qui tourne sur le VPS (12 premiers chars du sha256). Sert au
  // dashboard pour détecter "agent out of date" sans dépendre du bump manuel
  // de __version__. Comparé au sha du .pyz embarqué dans le dashboard.
  agentPyzSha: text('agent_pyz_sha'),
  agentLastSeenAt: integer('agent_last_seen_at'),
  // État du `claude login` sur ce VPS. 1 = connecté (oauth.refresh_token
  // présent), 0 = non connecté, NULL = jamais vérifié. Sert à masquer le
  // bouton "claude login" dans la sidebar quand inutile. Mis à jour par
  // - phase `check_login` du bootstrap (cf. bootstrap.ts)
  // - POST /api/vps/[id]/claude/check-login (déclenché à la fermeture de
  //   LoginConsole, ou à la demande)
  claudeLoggedIn: integer('claude_logged_in'),
  claudeLoggedInCheckedAt: integer('claude_logged_in_checked_at'),
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
  // Marqueur visuel : couleur (hex ou nom) appliquée à la bordure gauche
  // de la row dans la sidebar. NULL = pas de marqueur.
  color: text('color'),
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
export type VpsFolder = typeof vpsFolders.$inferSelect;
export type VpsPath = typeof vpsPaths.$inferSelect;
export type ClaudeSession = typeof claudeSessions.$inferSelect;
export type ClaudeSessionMessage = typeof claudeSessionMessages.$inferSelect;
export type ClaudePendingPermission = typeof claudePendingPermissions.$inferSelect;
export type ClaudePendingQuestion = typeof claudePendingQuestions.$inferSelect;
export type ClaudeSessionLog = typeof claudeSessionLogs.$inferSelect;
export type ClaudeSetting = typeof claudeSettings.$inferSelect;
export type ClaudePushSub = typeof claudePushSubs.$inferSelect;
