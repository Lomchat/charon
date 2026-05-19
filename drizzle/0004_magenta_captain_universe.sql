-- No-op : cette migration a été générée par accident en doublon de
-- 0003_add_session_color.sql (même ADD COLUMN color sur claude_sessions).
-- Sur une DB fraîche, exécuter le ADD une seconde fois renvoie "duplicate
-- column name: color". SQLite ne supporte pas IF NOT EXISTS sur ADD COLUMN.
-- On garde le fichier (et son entrée dans meta/_journal.json) pour ne pas
-- réindexer les migrations suivantes ; mais on remplace le SQL par un
-- statement neutre qui ne fait rien. La prochaine fois qu'on a besoin de
-- réellement modifier la table, on créera une nouvelle migration numérotée.
SELECT 1;
