CREATE TABLE `session_notification_settings` (
	`session_id` text PRIMARY KEY NOT NULL,
	`telegram` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `claude_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
