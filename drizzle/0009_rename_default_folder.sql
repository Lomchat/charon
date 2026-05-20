-- Migration 0009: rename the default folder from 'Sans dossier' (its
-- original French label) to 'No folder' for existing deployments. New
-- deployments already get 'No folder' via the updated 0006 INSERT.
--
-- Idempotent: only updates the row if it still has the legacy value,
-- so re-running this migration is a no-op. Custom user-renamed folders
-- (rare for the 'default' folder, since the UI does not expose a rename
-- for it) are left alone.
UPDATE `vps_folders`
   SET `name` = 'No folder'
 WHERE `id` = 'default'
   AND `name` = 'Sans dossier';
