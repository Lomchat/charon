-- Migration 0006: organise les VPS en dossiers (drag-and-drop + collapse persisté).
--
-- 1. Crée la table `vps_folders` (id, name, position, collapsed, created_at).
-- 2. Insère un dossier "Sans dossier" (id='default') qui sert de fallback :
--    tous les VPS existants y atterrissent, et c'est aussi la valeur DEFAULT
--    de la nouvelle colonne `vps.folder_id`. Ce dossier est protégé contre
--    la suppression côté API (cf. app/api/vps-folders/[id]/route.ts).
-- 3. Ajoute `folder_id` et `position` sur `vps`. SQLite refuse
--    `ADD COLUMN ... REFERENCES` avec un DEFAULT non-NULL (erreur "Cannot
--    add a REFERENCES column with non-NULL default value"). On omet donc
--    le REFERENCES côté DB — la FK est validée côté API (cf.
--    app/api/vps-folders/[id]/route.ts).
-- 4. Initialise `position` selon l'ordre alphabétique du `name` actuel
--    (matche le tri actuel de la sidebar).

CREATE TABLE `vps_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`collapsed` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `vps_folders` (`id`, `name`, `position`, `collapsed`) VALUES ('default', 'Sans dossier', 0, 0);
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
