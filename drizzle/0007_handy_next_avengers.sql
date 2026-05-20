-- Ajoute le tracking de l'état `claude login` sur chaque VPS.
-- claude_logged_in : 1 = connecté, 0 = non connecté, NULL = jamais vérifié.
-- claude_logged_in_checked_at : unix ts du dernier check (utile pour TTL si on
-- veut auto-recheck dans le futur).
--
-- Note : drizzle-kit avait généré un .sql qui re-créait les changements des
-- migrations 0005/0006 car les snapshots associés manquaient dans meta/. Le
-- contenu a été remplacé à la main pour ne garder que les vrais ADD COLUMN.
-- Cf. CLAUDE.md §4 pour la timeline des migrations.
ALTER TABLE `vps` ADD `claude_logged_in` integer;--> statement-breakpoint
ALTER TABLE `vps` ADD `claude_logged_in_checked_at` integer;
