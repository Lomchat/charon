DROP INDEX IF EXISTS `idx_claude_session_messages_conversation_chrono`;--> statement-breakpoint
DROP TRIGGER `claude_messages_fts_ai`;--> statement-breakpoint
DROP TRIGGER `claude_messages_fts_ad`;--> statement-breakpoint
DROP TRIGGER `claude_messages_fts_au`;--> statement-breakpoint
DROP INDEX `claude_push_subscriptions_endpoint_unique`;--> statement-breakpoint
DROP INDEX `idx_claude_pending_permissions_session_id_status`;--> statement-breakpoint
DROP INDEX `idx_claude_pending_questions_session_id_status`;--> statement-breakpoint
DROP INDEX `idx_claude_session_attachments_session_id_id`;--> statement-breakpoint
DROP INDEX `idx_claude_session_logs_session_id_id`;--> statement-breakpoint
DROP INDEX `idx_claude_session_messages_session_chrono_id`;--> statement-breakpoint
DROP INDEX `idx_claude_session_messages_session_id_id`;--> statement-breakpoint
DROP INDEX `idx_claude_session_messages_session_seq`;--> statement-breakpoint
DROP INDEX `idx_claude_session_messages_session_ts_id`;--> statement-breakpoint
DROP INDEX `idx_claude_session_messages_snapshot_lookup`;--> statement-breakpoint
DROP INDEX `uq_claude_sessions_vps_id_handle`;--> statement-breakpoint
ALTER TABLE `claude_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
ALTER TABLE `claude_session_messages` RENAME TO `session_messages`;--> statement-breakpoint
ALTER TABLE `claude_session_messages_fts` RENAME TO `session_messages_fts`;--> statement-breakpoint
ALTER TABLE `claude_pending_permissions` RENAME TO `session_pending_permissions`;--> statement-breakpoint
ALTER TABLE `claude_pending_questions` RENAME TO `session_pending_questions`;--> statement-breakpoint
ALTER TABLE `claude_session_attachments` RENAME TO `session_attachments`;--> statement-breakpoint
ALTER TABLE `claude_session_logs` RENAME TO `session_logs`;--> statement-breakpoint
ALTER TABLE `claude_settings` RENAME TO `app_settings`;--> statement-breakpoint
ALTER TABLE `claude_push_subscriptions` RENAME TO `push_subscriptions`;--> statement-breakpoint
ALTER TABLE `agent_sessions` RENAME COLUMN `claude_session_id` TO `native_session_id`;--> statement-breakpoint
ALTER TABLE `agent_sessions` RENAME COLUMN `codex_config` TO `provider_config`;--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `idx_session_pending_permissions_session_id_status` ON `session_pending_permissions` (`session_id`, `status`);--> statement-breakpoint
CREATE INDEX `idx_session_pending_questions_session_id_status` ON `session_pending_questions` (`session_id`, `status`);--> statement-breakpoint
CREATE INDEX `idx_session_attachments_session_id_id` ON `session_attachments` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_session_logs_session_id_id` ON `session_logs` (`session_id`, `id`);--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_chrono_id` ON `session_messages` (session_id,coalesce(ts_ms,created_at * 1000),id);--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_id_id` ON `session_messages` (`session_id`, `id`);--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_seq` ON `session_messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_session_messages_session_ts_id` ON `session_messages` (`session_id`,`ts_ms`,`id`);--> statement-breakpoint
CREATE INDEX `idx_session_messages_snapshot_lookup` ON `session_messages` (`session_id`,`role`,`snapshot_file_path`,`snapshot_phase`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_agent_sessions_vps_id_handle` ON `agent_sessions` (`vps_id`,`handle`);--> statement-breakpoint
CREATE TRIGGER session_messages_fts_ai AFTER INSERT ON session_messages WHEN new.role NOT IN ('edit_snapshot','event') BEGIN INSERT INTO session_messages_fts(rowid,message_id,session_id,role,content) VALUES(new.id,new.id,new.session_id,new.role,coalesce(new.wire_content,new.content)); END;--> statement-breakpoint
CREATE TRIGGER session_messages_fts_ad AFTER DELETE ON session_messages BEGIN DELETE FROM session_messages_fts WHERE rowid=old.id; END;--> statement-breakpoint
CREATE TRIGGER session_messages_fts_au AFTER UPDATE OF content,wire_content,role ON session_messages BEGIN DELETE FROM session_messages_fts WHERE rowid=old.id; INSERT INTO session_messages_fts(rowid,message_id,session_id,role,content) SELECT new.id,new.id,new.session_id,new.role,coalesce(new.wire_content,new.content) WHERE new.role NOT IN ('edit_snapshot','event'); END;
