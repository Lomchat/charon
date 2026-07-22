-- Dedupe first (keep the oldest row per (vps_id, path)) so the unique
-- index can build on databases that accumulated duplicates before the
-- constraint existed. No-op on clean DBs.
DELETE FROM `vps_paths` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `vps_paths` GROUP BY `vps_id`, `path`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_vps_paths_vps_id_path` ON `vps_paths` (`vps_id`,`path`);
