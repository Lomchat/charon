-- Add tracking of the `claude login` state on each VPS.
-- claude_logged_in: 1 = logged in, 0 = not logged in, NULL = never checked.
-- claude_logged_in_checked_at: unix ts of the last check (useful for TTL if
-- we want to auto-recheck in the future).
--
-- Note: drizzle-kit had generated a .sql that re-created changes from
-- migrations 0005/0006 because the associated snapshots were missing from
-- meta/. The content was replaced by hand to only keep the real ADD COLUMNs.
-- Cf. CLAUDE.md §4 for the migration timeline.
ALTER TABLE `vps` ADD `claude_logged_in` integer;--> statement-breakpoint
ALTER TABLE `vps` ADD `claude_logged_in_checked_at` integer;
