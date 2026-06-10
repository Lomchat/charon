-- Drop the vestigial replay cursor on shells (see CLAUDE.md §14 gotcha 37):
-- shell scrollback lives only in the browser xterm, so the WS bridge always
-- replays the durable-log tail from scratch (after_seq:0 + tail_bytes) and
-- never reads/writes this column. Added by 0015, never consumed since the
-- tail-replay design landed. Requires SQLite >= 3.35 (DROP COLUMN), same
-- floor as 0015.
ALTER TABLE `shells` DROP COLUMN `last_seen_seq`;
