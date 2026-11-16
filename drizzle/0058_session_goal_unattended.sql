ALTER TABLE `agent_sessions` ADD `unattended` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `goal` text;--> statement-breakpoint
-- Ultracode became its own switch beside effort (CLI 2.1.284 stopped it
-- pinning xhigh): the old pseudo-effort becomes xhigh + the switch.
UPDATE `agent_sessions` SET `provider_config` = json_set(CASE WHEN json_valid(`provider_config`) THEN `provider_config` ELSE '{}' END, '$.ultracode', json('true')), `effort` = 'xhigh' WHERE `effort` = 'ultracode';--> statement-breakpoint
INSERT INTO `app_settings` (`key`, `value`) SELECT 'claude.default_ultracode', 'true' WHERE EXISTS (SELECT 1 FROM `app_settings` WHERE `key` = 'claude.default_effort' AND `value` = 'ultracode') ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`;--> statement-breakpoint
UPDATE `app_settings` SET `value` = 'xhigh' WHERE `key` = 'claude.default_effort' AND `value` = 'ultracode';
