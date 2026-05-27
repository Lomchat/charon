-- Migration 0010: add indexes on hot-path foreign keys.
--
-- Context: SQLite creates automatic indexes for PRIMARY KEY but NOT for
-- FOREIGN KEY. As a result, every `WHERE session_id = ?` (or vps_id) query
-- did a full table scan. With the 5s delta polling in the front-end
-- (cf. CLAUDE.md §14 gotcha 24, layer 4) and a growing `claude_session_messages`,
-- this cost was visible. These compound indexes match the actual access
-- patterns:
--
-- - `claude_session_messages(session_id, id)`: window query, delta polling
--   (`?since=K`), pagination (`?before=K`). All filter by session then range
--   over id.
-- - `claude_pending_permissions(session_id, status)`: GET session detail +
--   SSE init snapshot, both filter by (session_id, status='pending').
-- - `claude_pending_questions(session_id, status)`: same shape as permissions.
--   `kind` is post-filtered in JS, too few distinct values to index.
-- - `claude_session_logs(session_id, id)`: auto_resume + debug filter+order.
-- - `vps_paths(vps_id)`: sidebar groupings.
--
-- Idempotent: all `IF NOT EXISTS` guards so re-running the migration after a
-- partial failure is safe.
CREATE INDEX IF NOT EXISTS `idx_claude_session_messages_session_id_id`
  ON `claude_session_messages` (`session_id`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_claude_pending_permissions_session_id_status`
  ON `claude_pending_permissions` (`session_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_claude_pending_questions_session_id_status`
  ON `claude_pending_questions` (`session_id`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_claude_session_logs_session_id_id`
  ON `claude_session_logs` (`session_id`, `id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vps_paths_vps_id`
  ON `vps_paths` (`vps_id`);
