ALTER TABLE `claude_session_messages` ADD `assistant_final` integer;--> statement-breakpoint
ALTER TABLE `claude_sessions` ADD `pending_assistant_message_id` integer;