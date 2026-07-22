ALTER TABLE `claude_sessions` ADD `kind` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `vps` ADD `codex_available` integer;--> statement-breakpoint
ALTER TABLE `vps` ADD `codex_sdk_version` text;--> statement-breakpoint
ALTER TABLE `vps` ADD `codex_logged_in` integer;--> statement-breakpoint
ALTER TABLE `vps` ADD `codex_logged_in_checked_at` integer;