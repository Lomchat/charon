CREATE TABLE `tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`vps_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`vps_id`) REFERENCES `vps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tabs_vps_id` ON `tabs` (`vps_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tabs_vps_path_kind_ref` ON `tabs` (`vps_id`,`path`,`kind`,`ref`);