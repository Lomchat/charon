ALTER TABLE `claude_sessions` ADD `handle` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claude_sessions_vps_id_handle` ON `claude_sessions` (`vps_id`,`handle`);