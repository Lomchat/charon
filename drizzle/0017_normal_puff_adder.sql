-- HAND-FIXED (cf. CLAUDE.md §4 / §17 — drizzle/meta snapshots had drifted, so
-- `db:generate` re-emitted CREATE TABLE shells + already-applied ADD COLUMNs +
-- indexes that all exist in the DB. Running those verbatim would error. The
-- ONLY real delta in this migration is the new `sleep_requested` column. The
-- regenerated 0017 meta snapshot is a full, correct schema snapshot, so it also
-- realigns the baseline for future `db:generate` runs.
ALTER TABLE `claude_sessions` ADD `sleep_requested` integer DEFAULT 0 NOT NULL;
