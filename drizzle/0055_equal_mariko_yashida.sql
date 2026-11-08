ALTER TABLE `agent_sessions` ADD `parent_session_id` text;--> statement-breakpoint
CREATE INDEX `idx_agent_sessions_parent` ON `agent_sessions` (`parent_session_id`);