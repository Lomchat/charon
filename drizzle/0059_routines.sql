CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`days` text NOT NULL,
	`time` text NOT NULL,
	`timezone` text NOT NULL,
	`vps_id` text NOT NULL,
	`cwd` text NOT NULL,
	`kind` text DEFAULT 'claude' NOT NULL,
	`model` text,
	`effort` text,
	`permission_mode` text,
	`prompt` text NOT NULL,
	`keep_runs` integer DEFAULT 4 NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_session_id` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`vps_id`) REFERENCES `vps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `routine_id` text;