ALTER TABLE `claude_pending_permissions` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `claude_pending_questions` ADD `expires_at` integer;--> statement-breakpoint
UPDATE `claude_pending_permissions`
SET `expires_at` = `created_at` + CASE
  WHEN (SELECT `kind` FROM `claude_sessions` WHERE `id` = `session_id`) = 'codex' THEN 1801
  ELSE 601
END
WHERE `status` = 'pending' AND `expires_at` IS NULL;--> statement-breakpoint
UPDATE `claude_pending_questions`
SET `expires_at` = `created_at` + 1801
WHERE `status` = 'pending' AND `kind` = 'question' AND `expires_at` IS NULL;
