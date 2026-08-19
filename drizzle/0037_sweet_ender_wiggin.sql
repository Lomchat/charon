CREATE TABLE `session_scheduled_resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_message_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	`content` text NOT NULL,
	`run_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`client_message_id` text NOT NULL,
	`user_message_id` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `claude_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `claude_session_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `claude_session_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_message_id`) REFERENCES `claude_session_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_session_scheduled_resumes_source` ON `session_scheduled_resumes` (`source_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_session_scheduled_resumes_message` ON `session_scheduled_resumes` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_session_scheduled_resumes_due` ON `session_scheduled_resumes` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `idx_session_scheduled_resumes_session` ON `session_scheduled_resumes` (`session_id`,`status`);