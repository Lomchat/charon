-- Fresh installs default to the SMALL display size (app/density.ts). A hub
-- already in use that never chose a size keeps the one it has been showing:
-- it gets an explicit 'default' row. A fresh DB has neither settings nor VPS
-- rows when its migrations run, so nothing is written there.
INSERT INTO `app_settings` (`key`, `value`)
SELECT 'app.density', 'default'
WHERE NOT EXISTS (SELECT 1 FROM `app_settings` WHERE `key` = 'app.density')
  AND (EXISTS (SELECT 1 FROM `app_settings`) OR EXISTS (SELECT 1 FROM `vps`));
