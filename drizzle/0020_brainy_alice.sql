ALTER TABLE `claude_session_messages` ADD `model` text;--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `effective_model` text;