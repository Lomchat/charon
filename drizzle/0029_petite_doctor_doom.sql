ALTER TABLE `claude_sessions` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tabs` ADD `vps_pos` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tabs` ADD `group_pos` integer DEFAULT 0 NOT NULL;