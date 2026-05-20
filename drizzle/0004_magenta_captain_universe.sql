-- No-op: this migration was accidentally generated as a duplicate of
-- 0003_add_session_color.sql (same ADD COLUMN color on claude_sessions).
-- On a fresh DB, running the ADD a second time returns "duplicate column
-- name: color". SQLite does not support IF NOT EXISTS on ADD COLUMN.
-- We keep the file (and its entry in meta/_journal.json) so we don't
-- reindex subsequent migrations; but we replace the SQL with a neutral
-- statement that does nothing. Next time we actually need to modify the
-- table, we'll create a new numbered migration.
SELECT 1;
