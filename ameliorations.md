# Backlog courant — Charon

> Issu de l'audit contradictoire du 22 juillet 2026 (Codex ↔ Claude).
> **Archive intégrale du débat, verdicts et preuves :
> [`docs/audits/2026-07-22-review.md`](./docs/audits/2026-07-22-review.md)**
> (sections 13-23 : les quatre sujets structurels — replay exact,
> idempotence, backpressure holder, secrets — sont FERMÉS avec tests).
>
> Règle héritée du débat : un invariant distribué n'est « fait » que
> lorsqu'un test automatisé reproduit sa panne. Colonne « preuve » = ce
> qui doit exister pour cocher.

## Ouvert

| ID | Prio | Sujet | Raison / preuve attendue |
|---|---|---|---|
| A1 | P2 | Compression CLAUDE.md < 60k chars | Obligation du bandeau du fichier (~76k actuel). Session dédiée, ne pas renuméroter §/gotchas |
| A2 | P2 | Sauvegarde/restauration SQLite (P2.3) | Backup API + restauration testée automatiquement ; rétention messages/logs/events |
| A3 | P2 | Smokes CI : WS via le vrai server.js + image Docker (8.2/8.4) | Un job CI qui boot l'image et ouvre un WS shell ; P0.1 restera « vérifié à la main » d'ici là |
| A4 | P2 | Validation runtime uniforme des API (P2.5) | Schémas partagés, 404 vs null, limites de taille body, JSON malformé |
| A5 | P2 | Strict Mode React (P2.11) | Chantier effets idempotents (souscriptions singleton) puis flip ; test mount/unmount/remount |
| A6 | P2 | Image standalone (P2.13) | `output:'standalone'` + custom server à valider ; budget de taille ; test better-sqlite3 dans l'image |
| A7 | P2 | Tests migrations depuis DBs historiques (8.2/P2.4) | Fixtures de DBs anciennes représentatives, migration en CI |
| A8 | P2 | Doc : Dockerfile/tests/CI dans CLAUDE.md §2 (P3.1) | À faire pendant A1 |
| B1 | P3 | États de livraison UI des prompts (P1.1 résiduel) | Design schéma+UI `pending/accepted/failed` ; retry manuel d'un failed |
| B2 | P3 | FTS5 recherche (P2.1) | Si volumétrie le justifie ; LIKE+limit 80 suffit aujourd'hui |
| B3 | P3 | Refactor machines d'état (P2.7) | EN DERNIER ; les tests de panne existent maintenant — les étendre avant chaque extraction |
| B4 | P3 | a11y (P2.10) | Passe complète modales/focus/clavier + axe-core si publication grand public |
| B5 | P3 | Fingerprint SSH UI + durcissement premier accès (P1.3 résiduel) | Confirmation de fingerprint à l'ajout d'un VPS |
| B6 | P3 | XFF trust config + limiteur global + Host allowlist (P1.4 résiduel) | Le rate-limit login existant est forgeable via XFF derrière un proxy naïf |
| B7 | P3 | Readiness distincte + relance admin du seed (P1.6/P3.3 résiduels) | `/api/health?ready=1` authed vérifiant DB+seed+agents |
| B8 | P3 | Bundle : analyzer, budget JS, dynamic import des modales (P2.12) | xterm déjà dynamique ; SearchModal/DataModal/LoginConsole statiques |
| B9 | P3 | Observabilité proportionnée (P3.2) | 2-3 compteurs (gaps, reconnexions, orphelins) exposés dans la santé VPS — pas de dashboards |
| B10 | P3 | Playwright + artefacts CI (8.4) | devDependency épinglée ; retirer le `npm i --no-save` du smoke |
| B11 | P3 | Fusion complète des constructeurs ssh (P1.2 résiduel) | sshExec garde ses opts propres (clé+known_hosts déjà partagés) |
| C1 | cond. | Matérialiser une `order_key` | SEULEMENT si une session dépasse ~50k lignes (bench §23.2 : 100k = 265 ms la fenêtre) — même règle que `chronologicalKeys` |

## Risques acceptés / choix assumés (ne pas « corriger » sans nouveau débat)

- **Polling 5s intouchable** — c'est le contrat anti-freeze (CLAUDE.md §14.24).
- **`client_message_id` non persisté à travers un restart agent** — fenêtre
  resume-only ; le persister coûterait un write/prompt.
- **Pas de UNIQUE(session_id, seq)** — les lignes historiques partagent des
  seqs (paires flush pré-stamping premier-delta).
- **Pas de CHECK SQLite** — ADD CONSTRAINT impossible, rebuild 12 étapes
  disproportionné ; validation applicative.
- **Pas de DLQ / outbox / dashboards** — disproportionné en mono-utilisateur.
- **Secrets : fail-open en DEV uniquement** (prod = fail-closed lecture ET
  écriture ; changer MASTER_* invalide les secrets → re-saisie).
- **Logs & notifications non transactionnels** avec les lignes de messages
  (perte cosmétique possible sur panne DB, jamais de transcript).
- **Fenêtre de transition pré/post-0023** : un replay chevauchant le
  déploiement du stamping peut retomber sur la dedup-contenu (one-shot, passé).

## Réflexes de maintenance (hérités du débat)

1. Toute modif du replay/de la pagination → étendre
   `tests/replayExactness.test.ts` / `tests/messageWindow.test.ts` AVANT.
2. Toute modif du holder/des files agent → re-passer
   `agent/tests/test_holder_load.py` (8 s).
3. `bash agent/build.sh` est reproductible : ne commiter le pyz QUE si la
   source agent a changé (le sha pilote l'auto-update fleet, §14.53).
4. CI = référence (matrice py 3.10/3.13, audit bloquant, pyz-à-jour vérifié).
