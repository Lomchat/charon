-- Purge des sessions en status='killed'.
--
-- Contexte : le status `'killed'` était un état intermédiaire entre `sleeping`
-- (pause réversible) et la suppression dure. UX confuse — le bouton "pause"
-- du header appelait en fait `kill` (cf. ancien comportement) et les
-- sessions concernées restaient en DB pour "consultation post-mortem" mais
-- ne pouvaient pas être reprises. La refonte kill→delete a fusionné ce
-- middle state avec la suppression définitive : seul `sleep` est désormais
-- réversible, tout le reste détruit. Cf. CLAUDE.md §10 et §14.
--
-- Effet : DELETE depuis claude_sessions cascade vers messages, permissions,
-- questions et logs grâce aux FK ON DELETE CASCADE déclarées en 0000. On
-- supprime les logs explicitement par défense en profondeur (l'ancien code
-- de killSession ne cascadait pas toujours via les FK selon l'historique).
DELETE FROM `claude_session_logs`
  WHERE `session_id` IN (SELECT `id` FROM `claude_sessions` WHERE `status` = 'killed');
--> statement-breakpoint
DELETE FROM `claude_sessions` WHERE `status` = 'killed';
