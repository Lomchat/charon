-- Migration 0013: persistent SSH shells backed by remote tmux sessions.
--
-- Context: SSH shells used to be in-memory only (one ssh child per shell,
-- piped stdio, no DB) — lost on any Charon restart, SSH drop, or kill, and
-- impossible to re-attach to from the VPS itself. The new design runs the
-- shell inside a `tmux` session on the VPS (named `charon-<id>`): Charon
-- attaches over `ssh -tt … tmux new-session -A -s charon-<id>` (via node-pty
-- so TERM + window size forward correctly), and a human can `tmux attach`
-- to the very same session from the server.
--
-- This table is the index Charon needs to list + re-attach after a restart;
-- the durable terminal state is the tmux session on the VPS. Rows are pruned
-- at boot when their tmux session no longer exists (reconcileShellsOnBoot)
-- and deleted on explicit close (tmux kill-session + DELETE).
--
-- Hand-written (drizzle-kit emits noisy redeclarations of the existing
-- tables; schema source-of-truth stays in lib/db/schema.ts). `IF NOT EXISTS`
-- on the index for idempotency across partial-failure retries.
CREATE TABLE `shells` (
	`id` text PRIMARY KEY NOT NULL,
	`vps_id` text NOT NULL,
	`tmux_name` text NOT NULL,
	`cwd` text,
	`name` text,
	`color` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`vps_id`) REFERENCES `vps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_shells_vps_id` ON `shells` (`vps_id`);
