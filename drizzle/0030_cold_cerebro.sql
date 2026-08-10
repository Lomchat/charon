ALTER TABLE `claude_session_messages` ADD `wire_content` text;--> statement-breakpoint
ALTER TABLE `claude_session_messages` ADD `snapshot_file_path` text;--> statement-breakpoint
ALTER TABLE `claude_session_messages` ADD `snapshot_phase` text;--> statement-breakpoint
ALTER TABLE `claude_session_messages` ADD `snapshot_tool_use_id` text;--> statement-breakpoint
ALTER TABLE `claude_session_messages` ADD `snapshot_truncated` integer;--> statement-breakpoint
-- Backfill the lightweight API projection and normalized snapshot keys once.
-- The lossless `content` is intentionally left untouched for export and the
-- lazy /edits endpoint.
UPDATE `claude_session_messages`
SET `wire_content` = json_set(
      `content`,
      '$.content', json('null'),
      '$.diff', json('null'),
      '$.contentStripped', json('true')
    ),
    `snapshot_file_path` = json_extract(`content`, '$.file_path'),
    `snapshot_phase` = json_extract(`content`, '$.phase'),
    `snapshot_tool_use_id` = json_extract(`content`, '$.tool_use_id'),
    `snapshot_truncated` = CASE WHEN json_extract(`content`, '$.truncated') THEN 1 ELSE 0 END
WHERE `role` = 'edit_snapshot' AND json_valid(`content`);--> statement-breakpoint
UPDATE `claude_session_messages`
SET `wire_content` = json_set(
      `content`,
      '$.content',
        substr(json_extract(`content`, '$.content'), 1, 12288) ||
        '\n\n… ' ||
        (length(json_extract(`content`, '$.content')) - 16384) ||
        ' characters omitted from live history …\n\n' ||
        substr(json_extract(`content`, '$.content'), -4096),
      '$.content_truncated', json('true'),
      '$.content_bytes', length(json_extract(`content`, '$.content'))
    )
WHERE `role` = 'tool_result'
  AND json_valid(`content`)
  AND length(json_extract(`content`, '$.content')) > 16384;--> statement-breakpoint
UPDATE `claude_session_messages`
SET `wire_content` = json_set(
      `content`,
      '$.input.content',
        substr(json_extract(`content`, '$.input.content'), 1, 12288) ||
        '\n\n… ' ||
        (length(json_extract(`content`, '$.input.content')) - 16384) ||
        ' characters omitted from live history …\n\n' ||
        substr(json_extract(`content`, '$.input.content'), -4096),
      '$.input.content_truncated', json('true'),
      '$.input.content_bytes', length(json_extract(`content`, '$.input.content'))
    )
WHERE `role` = 'tool_use'
  AND json_valid(`content`)
  AND length(json_extract(`content`, '$.input.content')) > 16384;--> statement-breakpoint
CREATE INDEX `idx_claude_session_messages_session_ts_id` ON `claude_session_messages` (`session_id`,`ts_ms`,`id`);--> statement-breakpoint
CREATE INDEX `idx_claude_session_messages_session_chrono_id` ON `claude_session_messages`
  (`session_id`,coalesce(`ts_ms`,`created_at` * 1000),`id`);--> statement-breakpoint
CREATE INDEX `idx_claude_session_messages_session_seq` ON `claude_session_messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_claude_session_messages_snapshot_lookup` ON `claude_session_messages` (`session_id`,`role`,`snapshot_file_path`,`snapshot_phase`,`id`);--> statement-breakpoint
-- Search only the user-visible transcript. Tool results use their bounded
-- wire preview; edit snapshots/events are side channels and would duplicate
-- huge file bodies for little search value.
CREATE VIRTUAL TABLE `claude_session_messages_fts` USING fts5(
  `message_id` UNINDEXED,
  `session_id` UNINDEXED,
  `role` UNINDEXED,
  `content`,
  tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO `claude_session_messages_fts` (`rowid`,`message_id`,`session_id`,`role`,`content`)
SELECT `id`,`id`,`session_id`,`role`,coalesce(`wire_content`,`content`)
FROM `claude_session_messages`
WHERE `role` NOT IN ('edit_snapshot','event');--> statement-breakpoint
CREATE TRIGGER `claude_messages_fts_ai` AFTER INSERT ON `claude_session_messages`
WHEN new.`role` NOT IN ('edit_snapshot','event')
BEGIN
  INSERT INTO `claude_session_messages_fts` (`rowid`,`message_id`,`session_id`,`role`,`content`)
  VALUES (new.`id`,new.`id`,new.`session_id`,new.`role`,coalesce(new.`wire_content`,new.`content`));
END;--> statement-breakpoint
CREATE TRIGGER `claude_messages_fts_ad` AFTER DELETE ON `claude_session_messages`
BEGIN
  DELETE FROM `claude_session_messages_fts` WHERE `rowid` = old.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `claude_messages_fts_au` AFTER UPDATE OF `content`,`wire_content`,`role` ON `claude_session_messages`
BEGIN
  DELETE FROM `claude_session_messages_fts` WHERE `rowid` = old.`id`;
  INSERT INTO `claude_session_messages_fts` (`rowid`,`message_id`,`session_id`,`role`,`content`)
  SELECT new.`id`,new.`id`,new.`session_id`,new.`role`,coalesce(new.`wire_content`,new.`content`)
  WHERE new.`role` NOT IN ('edit_snapshot','event');
END;
