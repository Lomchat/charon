-- Migration 0006: organize VPS into folders (drag-and-drop + persisted collapse).
--
-- 1. Create the `vps_folders` table (id, name, position, collapsed, created_at).
-- 2. Insert a "No folder" folder (id='default') used as a fallback:
--    all existing VPS land there, and that's also the DEFAULT value
--    of the new `vps.folder_id` column. This folder is protected against
--    deletion on the API side (cf. app/api/vps-folders/[id]/route.ts).
-- 3. Add `folder_id` and `position` on `vps`. SQLite refuses
--    `ADD COLUMN ... REFERENCES` with a non-NULL DEFAULT (error "Cannot
--    add a REFERENCES column with non-NULL default value"). We therefore
--    omit the REFERENCES on the DB side — the FK is validated on the API
--    side (cf. app/api/vps-folders/[id]/route.ts).
-- 4. Initialize `position` by alphabetical order of the current `name`
--    (matches the current sidebar sort).

CREATE TABLE `vps_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`collapsed` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `vps_folders` (`id`, `name`, `position`, `collapsed`) VALUES ('default', 'No folder', 0, 0);
--> statement-breakpoint
ALTER TABLE `vps` ADD `folder_id` text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
ALTER TABLE `vps` ADD `position` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `vps` SET `position` = (
	SELECT COUNT(*) FROM `vps` AS `v2`
	WHERE `v2`.`name` < `vps`.`name`
	   OR (`v2`.`name` = `vps`.`name` AND `v2`.`id` < `vps`.`id`)
);
