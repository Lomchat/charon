CREATE TABLE `telegram_messages` (
	`chat_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`session_id` text,
	`gate_id` text,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_telegram_messages_chat_message` ON `telegram_messages` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_telegram_messages_session` ON `telegram_messages` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_telegram_messages_gate` ON `telegram_messages` (`gate_id`);