ALTER TABLE `claude_session_messages` ADD `ts_ms` integer;--> statement-breakpoint
-- Backfill (§14.71). `ts_ms` becomes THE chronological sort key, replacing
-- `seq` — which cannot be one, because the agent's per-session seq restarts
-- at 1 whenever its event log is recreated, burying the whole new epoch in
-- the middle of the transcript.
--
-- `created_at` (INSERT time, seconds) is the best available proxy for rows
-- written before this column existed, and for the ordering problem it is an
-- exact fix: within a session, insert order IS the true chronological order.
-- That repairs the already-corrupted history in the data itself rather than
-- leaving it to a heuristic. Second granularity means whole turns share one
-- value; `orderChronologically` breaks those ties by id, which is correct.
--
-- The one case it cannot recover is a row REPAIRED by the replay engine
-- before 0026 (inserted late, belonging earlier): its created_at is the
-- repair time, so it stays at the end. Rare, cosmetic, unrecoverable — the
-- event ts was never stored. From now on such rows carry their real ts.
UPDATE `claude_session_messages` SET `ts_ms` = `created_at` * 1000 WHERE `ts_ms` IS NULL;
