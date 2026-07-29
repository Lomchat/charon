CREATE TABLE `claude_session_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`remote_path` text NOT NULL,
	`local_path` text,
	`size` integer NOT NULL,
	`mime` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `claude_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_claude_session_attachments_session_id_id` ON `claude_session_attachments` (`session_id`,`created_at`);