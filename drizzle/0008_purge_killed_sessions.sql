-- Purge sessions with status='killed'.
--
-- Context: the `'killed'` status was an intermediate state between `sleeping`
-- (reversible pause) and hard deletion. Confusing UX — the "pause" button
-- in the header actually called `kill` (cf. old behavior) and the affected
-- sessions stayed in DB for "post-mortem inspection" but could not be
-- resumed. The kill→delete refactor merged this middle state with permanent
-- deletion: only `sleep` is now reversible, everything else destroyed.
-- Cf. CLAUDE.md §10 and §14.
--
-- Effect: DELETE from claude_sessions cascades to messages, permissions,
-- questions and logs thanks to the FK ON DELETE CASCADE declared in 0000.
-- We delete logs explicitly as defense in depth (the old killSession code
-- didn't always cascade via FKs depending on history).
DELETE FROM `claude_session_logs`
  WHERE `session_id` IN (SELECT `id` FROM `claude_sessions` WHERE `status` = 'killed');
--> statement-breakpoint
DELETE FROM `claude_sessions` WHERE `status` = 'killed';
