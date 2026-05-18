ALTER TABLE `vps` ADD `agent_status` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `vps` ADD `agent_version` text;--> statement-breakpoint
ALTER TABLE `vps` ADD `agent_last_seen_at` integer;