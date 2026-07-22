# Plan d'amélioration de Charon

> Audit initial : 22 juillet 2026 (review externe GPT).
> **Contre-analyse : 22 juillet 2026 (Claude)** — chaque constat a été vérifié
> dans le code (références fichier:ligne). Verdicts inline sous chaque item :
> ✅ confirmé · ⚠️ partiel/nuancé · ❌ erreur factuelle. Synthèse et
> recalibrage des priorités en section 0.
> Périmètre : hub Next.js, API, SQLite, agent Python, protocole JSON-RPC,
> SSH, shells persistants, frontend, tests, CI et déploiement.

Ce document transforme la review technique du dépôt en backlog ordonné.
Il décrit les problèmes observés, leur impact et les corrections proposées.
Il ne signifie pas que les correctifs ont déjà été implémentés.

## 0. Contre-analyse — synthèse (22 juillet 2026)

Review de très bonne qualité : l'immense majorité des constats est exacte au
niveau du code, y compris les plus techniques (curseur en `finally`, dedup par
contenu, gap de rotation silencieux, `crypto.ts` mort). Quatre réserves :

1. **Quelques erreurs factuelles** (corrigées inline) : pas de N+1 sur la
   liste des sessions (P2.2), le rate-limit login existe déjà (P1.4), la clé
   privée VAPID est déjà masquée (P0.7), le web-push purge déjà les subs
   410 (P2.6), SearchModal a déjà un debounce (P2.8), le commentaire CI est
   trompeur dans l'AUTRE sens (8.4).
2. **Calibrage** : la review évalue Charon comme un service multi-tenant.
   C'est un hub mono-utilisateur dont la prod réelle tourne déjà en
   `node server.js` (unit systemd vérifiée) — P0.1 ne casse que les chemins
   de déploiement *documentés/publics*. Plusieurs P0 sont recalibrés P1.
3. **Surdimensionnement** : dead-letter queue, outbox, observabilité complète
   avec dashboards — disproportionné pour un hub single-user. Les fixes
   structurels simples (seq par message, files bornées) suffisent.
4. **Invariants ignorés** : certaines actions contredisent des contrats
   load-bearing documentés dans CLAUDE.md §14 (ex. P2.12 « ralentir le
   polling » vs §14.24 « polling IS the no-freeze contract »). Marqué inline.

### Tableau des verdicts

| Item | Verdict | Priorité review → recalibrée |
|---|---|---|
| P0.1 Docker/systemd | ✅ | P0 (repo publié) — prod réelle non affectée |
| P0.2 curseur `finally` | ⚠️ délibéré, impact étroit | P0 → **P1** (fusionner avec P0.3) |
| P0.3 dedup par contenu | ✅ le vrai risque replay | P0 (fix structurel : seq/message) |
| P0.4 gap rotation | ✅ silencieux de bout en bout | P0 → **P1** (bump protocole requis) |
| P0.5 backpressure | ✅ aux 3 étages | P0 → **P1** (commencer côté agent) |
| P0.6 lifecycle shells | ✅ intégralement | P0 → **P1** (ressources, pas données) |
| P0.7 secrets | ✅ et pire que décrit | P0 (masking = quick win) |
| P1.1 idempotence prompts | ⚠️ plausible, doublon peu probable | P1 |
| P1.2 SSH centralisé | ⚠️ 4 sites, bugs keyPath concrets | P1 |
| P1.3 validation SSH | ✅ | P1 |
| P1.4 frontières HTTP/WS | ⚠️ rate-limit existe déjà | P1 |
| P1.5 touchSession | ✅ | P1 → **P2** (fix trivial quand même) |
| P1.6 seed retryable | ✅ assumé dans le code | P1 |
| P1.7 settings fantômes | ✅ zéro consommateur | P1 → **P2** (supprimer, pas implémenter) |
| P1.8 validation config | ✓ raisonnable | P1 → P2 |
| P2.1 FTS5 | ⚠️ LIKE confirmé, limite existe | P2 |
| P2.2 N+1 | ❌ sessions / ✅ shells (N minuscule) | P2 → P3 |
| P2.4 contraintes schéma | ✅ absences confirmées | P2 |
| P2.6 web push | ⚠️ purge 410 existe déjà | P2 |
| P2.8 course recherche | ⚠️ course oui, debounce existe | P2 (fix 5 lignes) |
| P2.9 login par frappe | ✅ mais usage rarissime | P2 → **P3** |
| P2.11 Strict Mode | ⚠️ désactivation documentée/intentionnelle | P2 |
| P2.12 polling | ⚠️ **contredit §14.24 CLAUDE.md** | ne pas toucher au 5s |
| P2.13 image standalone | ✅ | P2 |
| P2.14 protos/deps | ✅ three/xyflow en deps de PROD | P2 |
| P2.15 pyz reproductible | ✅ + **impact auto-update fleet** | P2 → **P1 effectif** |
| P2.16 audit deps | ⚠️ npm audit CI existe (non bloquant) | P2 |
| 8.4 commentaires CI | ❌ inversé (nie des tests existants) | corriger l'énoncé |
| P3.1 doc | ✅ + CLAUDE.md à 71k/60k | P3 |

### Quick wins recommandés — ✅ TOUS RÉALISÉS le 22/07/2026

1. ✅ **Masquer `telegram.bot_token` + `claude.api_key` dans GET settings** (P0.7).
2. ✅ **Dockerfile + service.example → `node server.js`** ; server.js copié,
   devDeps prunées, .next/cache exclu (P0.1).
3. ✅ **Kill compensatoire + « stop vs forget » shells + kill best-effort au
   DELETE VPS** (P0.6).
4. ✅ **Borne port 1..65535, refus des valeurs en `-`, séparateur `--` dans
   les argv ssh** — hub + `/api/sync` (P1.3).
5. ✅ **`ssh.private_key_path` appliqué dans server.js, sshExec et test route**
   + known_hosts dédié (P1.2).
6. ✅ **Garde de fraîcheur dans SearchModal** (P2.8).
7. ✅ **Throttle `touchSession`** (30 min) (P1.5).
8. ✅ **`session.max_active`/`retention.killed_days` supprimés** (P1.7).
9. ✅ **Commentaire ci.yml corrigé + `npm audit` bloquant + matrice py
   3.10/3.13** (8.4/P2.16).
10. ✅ **build.sh déterministe** (zip trié, date fixe, perms fixes) (P2.15).

### Chantiers structurels — état au 22/07/2026

1. ✅ **Seq durable par message** (migration 0023 ; SANS contrainte unique —
   voir P0.3, la proposition était fausse) — P0.2+P0.3 réglés, curseur
   retenu (`_durableCursor`), holdback sur échec de persist.
2. ✅ **`earliest_seq`/gap au subscribe** (agent 0.18.0 + `replay_gap`
   hub-side ; la flotte auto-roll — 4 VPS déjà à jour, les autres suivent
   dès qu'ils sont quiet).
3. ✅ **File bornée par client côté agent** + bufferedAmount/maxPayload/
   Origin server.js + drop SSE (P0.5, P1.4 partiel).
4. ✅ **Chiffrement at-rest des settings** : hash HMAC des tokens de session
   + secrets `enc:v1:` AES-GCM (migration idempotente au boot, decrypt
   transparent, fail-closed sur changement d'env) — P0.7 COMPLET.
5. ✗ **FTS5, image standalone, Strict Mode** — confort, non fait.
6. ✗ **Refactor machines d'état (P2.7)** — volontairement non fait (en
   dernier, après les tests de panne).

### Bilan d'exécution (22/07/2026 — deux passes)

14 commits, chacun buildé + déployé + vérifié en prod avant push.

**Complets** : P0.1 · P0.2 · P0.3 · P0.4 · P0.5 · P0.6 · **P0.7 (chiffrement
at-rest inclus)** · P1.1 (cœur) · P1.2 · P1.3 · P1.5 · P1.6 · P1.7 · P1.8 ·
P2.2 · P2.6 · P2.8 · P2.9 · P2.14 · P2.15 · P2.16.
**Partiels** : P1.4 (WS Origin + maxPayload + garde mutations ✅ ; XFF
trust / limiteur global / Host allowlist ✗) · P2.4 (unique vps_paths ✅ ;
CHECK ✗ — rebuild de table SQLite disproportionné) · 8.3/8.4 (fuite holder
corrigée, matrice py, audit bloquant, check pyz commité ; smokes
Docker/WS/Playwright ✗) · P3.3 (health à deux niveaux ✅ ; readiness ✗).

Découvertes en route : fuite d'un holder détaché par run de tests
d'intégration (11 orphelins purgés) ; `dotenv` en devDeps cassait les
migrations Docker post-prune ; la contrainte UNIQUE (session,seq) proposée
par la review aurait cassé les paires flush légitimes ;
`cleanupExpiredSessions` n'avait aucun appelant ; `charon.db` était en 644
world-readable (trouvé par le configCheck dès son premier run) ; un
dependabot.yml complet existait déjà (raté par la review ET la
contre-analyse).

**Reste ouvert (gros chantiers assumés)** : FTS5 (P2.1), rétention/backup
(P2.3), validation runtime uniforme (P2.5), refactor machines d'état (P2.7 —
en dernier, après tests de panne), a11y (P2.10), Strict Mode (P2.11),
analyzer/budget bundle (P2.12), image standalone (P2.13), scénarios de
panne + smokes Docker/WS/Playwright (8.2/8.4), observabilité (P3.2),
compression CLAUDE.md sous 60k (P3.1).

À noter : `todo.md` (« audit Codex ») recoupe partiellement ce backlog —
fusionner ou archiver.

## 1. Résumé exécutif

Charon repose sur une architecture solide : agent distant persistant,
reconnexion automatique, journal durable, SQLite en WAL, protocole vérifié
entre Python et TypeScript, interface responsive unique et prise en charge
parallèle de Claude et Codex.

Les risques principaux se trouvent toutefois hors du chemin nominal :

1. les déploiements Docker et systemd documentés ne lancent pas le serveur
   WebSocket nécessaire aux shells ;
2. le replay peut perdre silencieusement des événements ;
3. les écritures réseau ne disposent pas de backpressure bornée ;
4. des shells distants peuvent devenir orphelins ;
5. plusieurs secrets sont stockés et renvoyés en clair malgré la
   documentation ;
6. la livraison des prompts et de certaines commandes RPC n'est pas
   idempotente ;
7. les scénarios de panne distribuée sont encore peu testés.

L'ordre conseillé est de sécuriser d'abord les données et le cycle de vie des
ressources, puis la sécurité, les performances et enfin les refactorings de
maintenabilité.

## 2. Niveaux de priorité

| Priorité | Signification |
|---|---|
| **P0** | Risque de fonctionnalité cassée, perte de données, fuite de secret ou épuisement de ressources. À corriger avant de considérer le service fiable en production. |
| **P1** | Risque important de cohérence, de sécurité ou d'exploitation. À traiter dans le sprint suivant. |
| **P2** | Performance, maintenabilité, accessibilité, qualité et réduction de dette. |
| **P3** | Confort d'exploitation et améliorations progressives. |

## 3. P0 — Correctifs prioritaires

### P0.1 — Lancer le bon serveur en Docker et systemd

> 🔎 **Verdict : ✅ CONFIRMÉ.** `Dockerfile:88` lance `next start` ; le stage
> runner ne copie pas `server.js` ; `node_modules` copiés INTÉGRAUX avec
> devDeps (le commentaire « pruned to production » l.45 est mensonger) ;
> `.next/cache` embarqué (le `.dockerignore` n'exclut que le `COPY . .` du
> builder). `docs/charon.service.example:25` = `next start` aussi.
> **Nuance** : la prod réelle (`/etc/systemd/system/charon.service`) lance
> déjà `node server.js` — le bug ne touche que les chemins de déploiement
> documentés pour les utilisateurs externes du repo publié. P0 maintenu à ce
> titre, fix trivial.

**Constat**

- `server.js` est le seul composant qui gère l'upgrade WebSocket de
  `/api/shells/[id]/ws`.
- `Dockerfile` lance actuellement `next start` et ne copie pas `server.js`.
- `docs/charon.service.example` lance également `next start`.

**Impact**

L'application HTTP peut sembler fonctionner alors que les shells WebSocket
sont indisponibles dans les méthodes de déploiement documentées.

**Actions** *(✔ fait le 22/07/2026 — sauf smoke test)*

- [x] Copier `server.js` dans l'image de production.
- [x] Remplacer `next start` par `node server.js` dans Docker.
- [x] Remplacer `next start` par `node server.js` dans l'unité systemd.
- [x] Exécuter les migrations dans une étape explicite avant le démarrage
      *(déjà le cas : `docker/entrypoint.sh` lance `scripts/migrate.mjs`)*.
- [x] Vérifier que le service systemd peut lire la clé SSH ;
      `ProtectHome=true` peut bloquer `/root/.ssh` *(→ `ProtectHome=read-only`
      + `ReadWritePaths=/root/.ssh` + commentaire explicatif)*.
- [x] *(bonus P2.13)* `npm prune --omit=dev` + suppression de `.next/cache`
      dans l'image ; `dotenv` déplacé en dependencies (migrate.mjs l'importe —
      le prune l'aurait cassé).
- [ ] Ajouter un smoke test Docker ouvrant réellement un WebSocket de shell.

**Fichiers concernés**

- `server.js`
- `Dockerfile`
- `docker/entrypoint.sh`
- `docs/charon.service.example`

### P0.2 — Ne jamais avancer le curseur après un traitement échoué

> 🔎 **Verdict : ⚠️ CONFIRMÉ factuellement, mais nuancé.**
> `sessionOps.ts:471-482` : `_trackSeq(ev)` bien dans un `finally` — mais
> c'est un choix DÉLIBÉRÉ documenté dans le commentaire (« a thrown handler
> still advances — replaying the same event would just hit the same
> exception »). De plus `_persist`/`_persistSeqNow` avalent leurs erreurs DB
> (best-effort) : un échec de persistance ne throw jamais, donc le scénario
> « throw → événement marqué consommé » est étroit ; un échec DB est perdu
> silencieusement QUEL QUE SOIT le curseur. Le vrai fix n'est pas de séparer
> deux curseurs mais le fix structurel de P0.3 (seq par message + contrainte
> unique) qui rend le rejeu idempotent — après quoi retenir le curseur
> devient sûr. **DLQ = surdimensionné** pour un hub mono-user.
> **Recalibré P1, fusionné avec P0.3.**

**Constat**

`SessionStream._onAgentEvent()` suit actuellement le numéro de séquence dans
un bloc `finally`. Un événement dont la persistance ou le traitement échoue
peut donc être marqué comme consommé.

**Impact**

Après reconnexion, Charon demande les événements suivants et peut perdre
définitivement l'événement fautif.

**Actions**

*(✔ fait le 22/07/2026 via le chantier « seq par message » — voir P0.3.)*

- [x] Séparer `lastReceivedSeq` de `lastPersistedSeq` *(mieux : le curseur
      DURABLE est retenu par `_durableCursor()` = min(lastSeenSeq,
      pendingAssistantSince−1, persistHoldbackSeq−1) — un crash re-livre le
      texte non flushé au lieu d'en perdre les premières secondes)*.
- [x] Avancer le curseur durable uniquement après traitement réussi *(un
      `_persist` en échec épingle le curseur → le restart rejoue l'événement
      et la ligne a une seconde chance ; le seq-gate rend le rejeu
      idempotent)*.
- [ ] ~~Ajouter des retries bornés avec backoff.~~ *(remplacé par le
      holdback+rejeu — plus simple, même garantie)*
- [ ] ~~Stocker les événements impossibles à traiter dans une dead-letter
      queue.~~ *(surdimensionné — voir verdict)*
- [x] Rendre cet état visible dans les logs, la santé VPS et l'interface
      *(replay_gap : log warn + ligne event persistée + bannière erreur UI)*.
- [ ] Ajouter un test injectant une erreur DB au milieu d'un replay.

**Fichier principal** : `lib/server/agent/sessionOps.ts`

### P0.3 — Dédupliquer par identité d'événement, jamais par contenu

> 🔎 **Verdict : ✅ CONFIRMÉ — le risque replay le plus réel de la review.**
> `sessionOps.ts:307-311` : des `Set<string>` de contenus BRUTS (pas même de
> hash) ; `_loadReplayDedup()` (l.1064-1108) charge TOUT l'historique de la
> session sans fenêtre ; actif uniquement entre `replay_begin`/`replay_end`
> (vidé à `replay_end`, aucune dedup en live). `_flushAssistant()`
> l.1020-1022 : un « Done. » légitime jamais persisté, arrivant en replay et
> identique à un message d'un tour antérieur, est silencieusement perdu.
> `claude_session_messages` n'a AUCUNE colonne seq (`schema.ts:198-219`) —
> l'idempotence ne repose sur aucune contrainte DB. Le fix « seq par
> message + UNIQUE(session_id, seq) » est le bon et règle P0.2 au passage.
> Préserver le cas « prefix-extend » (l.1032-1044) lors du chantier.

**Constat**

Le replay charge les contenus assistant historiques dans un `Set` et ignore
une réponse identique. Deux réponses légitimes telles que « Done. » peuvent
donc être confondues.

**Impact**

Une réponse valide peut disparaître du transcript lorsqu'elle arrive par
replay.

**Actions**

*(✔ fait le 22/07/2026 — migration 0023 `claude_session_messages.seq` ;
vérifié en prod après restart : zéro doublon `(session,seq)` hors paires
flush légitimes, stamping actif sur les nouvelles lignes.)*

- [x] Persister l'identité durable de l'événement ou son `seq` *(chaque ligne
      porte le seq de l'événement producteur ; le flush assistant porte le
      seq de son déclencheur)*.
- [ ] ~~Ajouter une contrainte unique `(session_id, event_seq)`.~~
      *(**la proposition était subtilement fausse** : un même événement
      produit légitimement DEUX lignes — flush assistant + sa propre ligne —
      même seq, rôles différents. Le gate `MAX(seq)` à replay_begin donne la
      même garantie sans la contrainte.)*
- [x] Associer les fragments de texte à un tour ou intervalle de séquences
      *(pendingAssistantSince → curseur retenu → re-livraison intégrale)*.
- [x] Supprimer la déduplication globale par hash ou contenu *(reléguée en
      fallback pour agents sans seq / lignes pré-0023 — jamais utilisée dès
      que le seq-gate s'applique)*.
- [ ] Tester plusieurs réponses textuellement identiques dans des tours
      différents.

**Fichier principal** : `lib/server/agent/sessionOps.ts`

### P0.4 — Détecter les trous causés par la rotation du journal

> 🔎 **Verdict : ✅ CONFIRMÉ de bout en bout.** `event_log.py § read_since`
> (l.190-211) filtre `s > after_seq` et commence simplement au plus vieux
> événement conservé — aucun `earliest_seq`, aucun marqueur ; `_recover_seq`
> ne calcule que le max. Côté hub, le résultat du RPC `subscribe`
> (`replay_count`, `current_seq`) est IGNORÉ (`AgentClient.ts:308-316`) et
> `_trackSeq` accepte n'importe quel saut. Gap 100 % silencieux.
> **Recalibré P1** (nécessite bump `__version__` + rebuild pyz + rollout ;
> scénario = longue coupure hub pendant que l'agent produit — réel mais
> rare). L'atténuation « reconstruction depuis le transcript SDK » existe
> déjà partiellement via l'import/scan.

**Constat**

`event_log.py` renvoie les événements encore disponibles, mais ne signale pas
que les premiers événements demandés ont déjà été supprimés par rotation.

**Impact**

Après une longue coupure, le hub peut accepter un saut de séquence et présenter
un transcript incomplet sans avertissement.

**Actions**

*(✔ fait le 22/07/2026 — agent 0.18.0 : `event_log.earliest_seq()` (cache
invalidé à la rotation) + subscribe → `{earliest_seq, gap}` ; hub :
`replay_gap` synthétisé par AgentClient → log + ligne event + bannière.)*

- [x] Retourner `earliest_seq`, ~~`latest_seq`~~ (= `current_seq`, déjà là)
      et `gap` lors du subscribe.
- [x] Comparer le premier événement reçu à `requested_seq + 1` *(équivalent
      côté agent : seqs DENSES → `earliest > after_seq+1` prouve le trou)*.
- [x] Ajouter un événement ou état explicite `replay_gap`.
- [x] Afficher un avertissement *(bannière erreur non-fatale + ligne
      persistée)* — reconstruction SDK : non (l'import/scan existe déjà en
      manuel).
- [x] Rendre la rétention et les quotas configurables *(fait le 22/07 —
      env `CHARON_EVLOG_MAX_BYTES`/`CHARON_EVLOG_ROTATIONS`, agent 0.19.0)*.
- [x] Ajouter un test avec rotation et curseur antérieur au plus vieux
      fichier *(4 tests earliest_seq, dont rotation-drop + reopen)*.

**Fichiers concernés**

- `agent/charon_agent/event_log.py`
- `agent/charon_agent/server.py`
- `lib/server/agent/AgentClient.ts`
- `lib/server/agent/sessionOps.ts`

### P0.5 — Mettre en place une vraie backpressure

> 🔎 **Verdict : ✅ CONFIRMÉ aux trois étages.** Agent :
> `server.py:1021-1034` — `create_task` par événement, sérialisé par un lock
> mais files de tâches non bornées (un drain bloqué accumule tâches +
> payloads sans cap). Holder : `holder.py:316-327` fire-and-forget drain
> assumé par commentaire ; en revanche le spool EST déjà borné
> (`SPOOL_MAX_BYTES` 8MB, l.83, newest-wins). Hub : `server.js` — zéro
> `bufferedAmount`, pas de `maxPayload` ; SSE `enqueue` sans `desiredSize`
> (seul le focus-filtering réduit le volume). **Recalibré P1** : en
> mono-user, le risque réel n° 1 est l'OOM de l'AGENT (un shell verbeux +
> hub bloqué) — commencer par la file bornée côté agent, le reste ensuite.

**Constat**

- L'agent crée une tâche `asyncio` par envoi JSON.
- Le holder programme des `drain()` sans file bornée.
- Le serveur WebSocket ne surveille pas systématiquement
  `ws.bufferedAmount`.

**Impact**

Un client lent ou une connexion SSH bloquée peut accumuler des tâches et des
buffers jusqu'à épuiser la mémoire du hub ou de l'agent.

**Actions**

*(✔ l'essentiel fait le 22/07/2026 — agent 0.18.0 + server.js + SSE ;
vérifié : WS smoke complet (replay, input, kill), tests py OK. Bonus
découvert en route : les tests d'intégration FUYAIENT un holder par run —
11 orphelins tués, cleanup ajouté au test.)*

- [x] Créer une file bornée par client, mesurée en événements et en octets
      *(agent : 10k events / 32MB par client)*.
- [x] Utiliser une seule coroutine writer par connexion *(remplace la
      task-par-événement ; bonus : ordre strict replay→réponse RPC)*.
- [ ] Définir des high/low watermarks *(agent : overflow = déconnexion
      sèche, pas de watermark — le curseur durable rend ça sans perte ;
      server.js : high/low 4MB/512KB sur bufferedAmount)*.
- [x] Déconnecter proprement les consommateurs trop lents *(agent :
      shutdown + le hub se reconnecte)*.
- [x] Reprendre les clients déconnectés via le journal durable *(déjà le
      design — subscribe after_seq)*.
- [x] Limiter `ws.bufferedAmount` *(pause/resume du flux ssh)* et la taille
      maximale des messages *(maxPayload 1MiB)*.
- [x] *(SSE)* drop des événements quand `desiredSize < -1000` (le poll 5s
      est le contrat de rattrapage, §14.24).
- [ ] Mesurer profondeur des queues, octets en attente et déconnexions lentes.
- [ ] Effectuer des tests de charge avec navigateur et SSH artificiellement
      ralentis.

**Fichiers concernés**

- `agent/charon_agent/server.py`
- `agent/charon_agent/holder.py`
- `server.js`

### P0.6 — Rendre le cycle de vie des shells transactionnel

> 🔎 **Verdict : ✅ CONFIRMÉ intégralement.** `shellSession.ts:97-106` :
> `shell_start` AVANT l'insert DB, sans try/catch ni kill compensatoire.
> `stopShell` (l.122-134) : `shell_kill` catché puis delete DB
> inconditionnel — et le commentaire « the bash will die with the agent
> eventually » est PÉRIMÉ depuis le holder détaché 0.10.0 (le holder survit
> à l'agent). `DELETE /api/vps/[id]` : DB-only (cascade FK), holders ET
> sessions Claude continuent de tourner sur le VPS. Réconciliations
> existantes toutes unidirectionnelles (DB → prune) ; un shell agent-side
> sans ligne DB n'est jamais détecté ni tué. **Recalibré P1** (fuite de
> ressources sur ses propres VPS, pas perte de données). Quick wins : kill
> compensatoire, « stop vs forget », kill best-effort au DELETE VPS.

**Constat**

- Le holder distant est créé avant l'insertion SQLite. Une erreur DB peut
  laisser un shell invisible.
- En cas d'échec du RPC `shell_kill`, la ligne DB est tout de même supprimée.
- Le holder est détaché et peut survivre indéfiniment à l'agent.
- Le frontend peut masquer le shell avant confirmation de sa suppression.

**Impact**

Processus distants orphelins, consommation de ressources et impossibilité de
retrouver ou d'arrêter un shell depuis Charon.

**Actions**

*(✔ l'essentiel fait le 22/07/2026 — vérifié en prod : VPS injoignable →
502 `{canForce:true}` + ligne préservée, `?force=1` → purge ; chemin nominal
→ kill confirmé, zéro holder orphelin.)*

- [x] Exécuter un kill compensatoire si l'insertion DB échoue
      *(startShell : try/catch + shell_kill best-effort)*.
- [ ] Introduire un état `deleting` ou une tombstone *(remplacé par le
      modèle stop-vs-forget, plus simple : la ligne reste tant que le kill
      n'est pas confirmé)*.
- [x] Conserver la ligne tant que le holder n'a pas confirmé l'arrêt
      *(réponse "not found" de l'agent = déjà mort = confirmation)*.
- [ ] Retenter la suppression avec backoff *(remplacé par le retry manuel
      via l'UI — confirm → force)*.
- [x] Séparer les commandes « arrêter » et « oublier »
      (`stopShell(id, {force})`, `DELETE ?force=1`).
- [x] Appliquer la même distinction à la suppression d'un VPS *(DELETE vps :
      kill best-effort de TOUTES les sessions + shells distants, borné 8s,
      avant le cascade DB — avant ça, tout continuait de tourner sur le VPS)*.
- [x] Ne fermer l'UI qu'après acquittement ou afficher clairement l'échec
      *(ShellTerminal + ClaudePanel : confirm « forget anyway? » sur échec)*.
- [x] Ajouter une réconciliation périodique entre DB et `shell_list`
      *(fait le 22/07 — `armShellReconcileLoop`, 10 min, bidirectionnelle :
      prune les fantômes DB ET tue les shells agent sans ligne DB, avec
      grâce de 2 ticks contre la course création)*.

**Fichiers concernés**

- `lib/server/shell/shellSession.ts`
- `app/ShellTerminal.tsx`
- `app/api/shells/[id]/route.ts`
- `app/api/vps/[id]/route.ts`

### P0.7 — Chiffrer et masquer réellement les secrets

> 🔎 **Verdict : ✅ CONFIRMÉ — et pire que décrit.** `crypto.ts` = code MORT
> (zéro import hors son propre test ; le `aesKey` transporté par
> `session.ts:22` n'est jamais consommé). `SESSION_SECRET` : zéro usage dans
> tout le code — le cookie est un id opaque `randomBytes(32)` et le token de
> session est stocké EN CLAIR en DB (`auth.ts:86`) : un dump SQLite donne
> des sessions réutilisables. `GET /api/claude/settings` (route l.34-45)
> renvoie `telegram.bot_token` et `claude.api_key` COMPLETS au navigateur —
> ❌ correction : la clé privée VAPID, elle, est DÉJÀ masquée
> (`delete all['vapid.private']`). README (§MASTER_PASSWORD) et CLAUDE.md
> (§3 « session-cookie signing », §12) documentent un chiffrement et une
> signature qui n'existent pas. **P0 maintenu pour le masking API (quick
> win) + hash des tokens de session ; chiffrement at-rest = P1.**

**Constat**

Le module AES-GCM existe mais n'est pas intégré au stockage des réglages. Les
tokens Telegram, clé API Claude et clés VAPID peuvent être conservés en clair.
La route de settings peut renvoyer des secrets complets au navigateur.
`SESSION_SECRET` n'est pas utilisé comme le prétend la documentation.

**Impact**

Une lecture de la DB, une sauvegarde exposée ou un XSS authentifié donne accès
aux secrets distants.

**Actions**

- [x] Définir un format chiffré versionné, par exemple `enc:v1:...` *(fait le
      22/07 — AES-256-GCM, préfixe versionné)*.
- [x] Dériver une clé depuis le master secret avec paramètres validés *(fait —
      scrypt(MASTER_PASSWORD, MASTER_SALT) partagé via masterKey.ts ; salt
      validé hex au boot par configCheck)*.
- [x] Migrer les secrets existants de manière idempotente *(fait —
      `encryptSecretsAtRest()` au seed, idempotent par préfixe ; vérifié en
      prod : 3 secrets chiffrés, déchiffrement transparent prouvé par le
      masque `••••<last4>` inchangé)*.
- [x] Ne renvoyer qu'un indicateur `configured` ou une valeur masquée
      (cibles réelles : `telegram.bot_token`, `claude.api_key` —
      `vapid.private` est déjà masqué) *(fait le 22/07 : GET/POST masquent
      `••••<last4>` ; un POST encore masqué = inchangé, vide = clear ;
      vérifié en prod : secret préservé au round-trip du formulaire)*.
- [x] Préserver la valeur actuelle lorsqu'un formulaire ne fournit pas de
      nouveau secret *(fait le 22/07 — sentinel masqué ignoré au POST)*.
- [x] Prévoir rotation de clé, récupération et sauvegarde documentées
      *(README : rotation manuelle = re-saisir les secrets après changement
      d'env ; decrypt fail-closed → secret affiché « unconfigured », jamais
      de crash)*.
- [x] Soit supprimer `SESSION_SECRET`, soit l'utiliser réellement *(fait le
      22/07 — clé HMAC du hash des tokens de session)*.
- [x] Envisager un hash/HMAC des tokens de session stockés en DB *(fait le
      22/07 : cookie = token brut, DB = HMAC-SHA256(SESSION_SECRET, token),
      `lib/server/sessionHash.js` partagé auth.ts + server.js (WS) ; migration
      one-shot des 34 lignes existantes, cookies préservés ; vérifié en prod
      200/401)*.
- [x] Corriger le README **et CLAUDE.md §3/§12** après implémentation *(fait
      le 22/07 — README dit désormais honnêtement « at-rest plaintext, masking
      + hash en place » ; le chiffrement at-rest reste le dernier morceau)*.

**Fichiers concernés**

- `lib/server/crypto.ts`
- `lib/server/auth.ts`
- `lib/server/claude/webPush.ts`
- `app/api/claude/settings/route.ts`
- `README.md`

## 4. P1 — Fiabilité distribuée et sécurité

### P1.1 — Rendre l'envoi des prompts idempotent

> 🔎 **Verdict : ⚠️ plausible, non contredit — mais le doublon est peu
> probable.** Le retry automatique n'existe que sur erreur CLAIRE
> « not running » (auto-resume, CLAUDE.md §14.49), pas sur timeout ambigu.
> Le cas réel = message persisté en DB mais jamais livré (transcript
> mensonger). Le `client_message_id` reste la bonne solution ; l'extension
> aux autres RPC est du nice-to-have.

Le message utilisateur est persisté avant l'appel RPC. Une erreur claire peut
laisser un message jamais livré dans le transcript ; un timeout ambigu peut au
contraire avoir livré le prompt, puis provoquer un doublon à la relance.

*(✔ le cœur fait le 22/07/2026 — agent 0.19.0 : `send_input` accepte
`client_message_id`, ids enregistrés APRÈS acceptation (un échec reste
retryable), ring 64/session, purgé au kill ; hub : uuid par message, retry
UNE fois sur timeout ambigu avec le même id, même id sur le chemin
auto-resume.)*

- [x] Générer un `client_message_id` stable.
- [ ] Ajouter les états `pending`, `accepted`, `failed` et éventuellement
      `completed` *(non retenu : la machine d'états UI est du confort — le
      doublon, lui, est éliminé)*.
- [x] Dédupliquer côté agent par identifiant.
- [x] Retenter avec le même identifiant *(sur timeout ambigu + auto-resume)*.
- [ ] Représenter l'état de livraison dans l'interface.
- [ ] Étendre le mécanisme aux opérations `start`, `resume`, permissions et
      changements de configuration *(resume est déjà noop-idempotent §14.36 ;
      les réponses de permission résolvent des futures one-shot)*.

**Fichier principal** : `lib/server/agent/sessionOps.ts`

### P1.2 — Centraliser complètement la configuration SSH

> 🔎 **Verdict : ⚠️ PARTIEL — 4 sites (pas plus), mais bugs concrets.**
> Constructions distinctes : `sshShared.js § buildAgentSshArgs` (supporte
> keyPath), `sshExec.ts § DEFAULT_SSH_OPTS` (AUCUN keyPath — tout le
> bootstrap passe par lui), `loginSession.ts:40-54` (applique keyPath),
> `app/api/vps/[id]/test/route.ts:9-18` (pas de keyPath). Bug avéré :
> `ssh.private_key_path` (configurable en settings) est IGNORÉ par
> server.js (WS shells — il appelle buildAgentSshArgs sans le passer), par
> sshExec/bootstrap et par le test VPS. Une clé non standard casse donc 3
> chemins sur 5.

Le chemin de clé privée et certains paramètres SSH ne sont pas appliqués de
façon uniforme aux connexions persistantes, commandes ponctuelles, bootstrap,
test VPS, login et proxy WebSocket.

*(✔ l'essentiel fait le 22/07/2026 — `ssh.private_key_path` désormais appliqué
aux 6 sites de spawn : AgentClient + server.js WS (STMT_KEYPATH) + sshExec/
bootstrap (`sshKeyArgs()`) + test route + loginSession ; known_hosts dédié
`~/.ssh/charon_known_hosts` partagé partout via `KNOWN_HOSTS_PATH`
(sshShared.js) ; vérifié en prod : flotte reconnectée, erreurs restantes
pré-existantes (réseau/daemon).)*

- [ ] Créer un seul constructeur d'arguments/configuration SSH *(partiel :
      sshShared.js reste LE builder agent ; sshExec garde ses opts propres
      mais partage désormais clé + known_hosts — fusion complète = refactor
      ultérieur)*.
- [x] L'utiliser dans tous les consommateurs *(clé + known_hosts + `--`)*.
- [x] Partager clé, port, utilisateur, timeout et known-hosts.
- [ ] Tester chaque type de connexion avec une clé non standard.
- [x] Supprimer les constructions locales d'arguments *(plus aucun site
      n'ignore la clé configurée)*.

### P1.3 — Valider strictement les cibles et paramètres SSH

> 🔎 **Verdict : ✅ CONFIRMÉ.** `app/api/vps/route.ts:15-22` : port sans
> borne haute (99999 accepté), aucun refus des valeurs commençant par `-`
> (un `sshUser` en `-oProxyCommand=...` est possible — aucun argv n'utilise
> le séparateur `--`), aucune longueur max. `accept-new` partout, pas de
> known_hosts dédié (grep négatif). `/api/sync` : même laxisme
> (présence + `String()` bruts) et alimente directement les argv ssh.

*(✔ fait le 22/07/2026 via `lib/server/vpsValidate.ts`, appliqué à POST/PATCH
/api/vps ET /api/sync ; vérifié en prod : `-oProxyCommand=` refusé en user et
en host, port 99999 refusé.)*

- [x] Limiter le port à `1..65535`.
- [x] Refuser utilisateurs, hôtes et destinations commençant par `-`
      (et ajouter `--` avant la destination dans tous les argv — les 6 sites).
- [x] Définir des longueurs maximales *(name 120, host 253, user 64, path 512)*.
- [x] Valider hostname/IP, utilisateur POSIX et chemins selon des règles
      documentées *(règles commentées dans vpsValidate.ts, source unique)*.
- [x] Appliquer les mêmes règles à `/api/sync` *(lignes invalides comptées
      `counts.invalid`, jamais insérées)*.
- [x] Gérer un fichier known-hosts dédié à Charon
      (`~/.ssh/charon_known_hosts`, tous les sites).
- [ ] Permettre l'enregistrement ou la confirmation d'une fingerprint SSH.
- [ ] Éviter de considérer `accept-new` comme une protection du premier accès.

### P1.4 — Renforcer les frontières HTTP et WebSocket

> 🔎 **Verdict : ⚠️ PARTIEL.** ❌ Correction : le rate-limit login EXISTE
> déjà (`lib/server/loginRateLimit.ts`, lockout exponentiel cap 5 min,
> branché dans `app/login/actions.ts`) — mais sa clé est le hop XFF le plus
> à gauche, forgeable si le reverse-proxy ne l'écrase pas. ✅ Confirmés :
> upgrade WS sans AUCUNE vérification d'Origin (`server.js:241-252` — et
> SameSite=lax ne protège PAS un handshake WS cross-site → hijacking
> théorique), pas de `maxPayload`.

- [ ] Ne faire confiance à `X-Forwarded-For` qu'avec des proxies configurés
      (corriger aussi la clé du rate-limit login existant).
- [ ] Ajouter un limiteur global en complément du limiteur par IP.
- [ ] Utiliser une origine publique configurée pour les redirects.
- [ ] Refuser les `Host` ou `X-Forwarded-Host` non autorisés.
- [x] Ajouter une garde uniforme `Origin`/Fetch Metadata aux mutations
      *(fait le 22/07 — middleware : mutations API avec Origin non reconnu →
      403 ; vérifié : hostile 403, légitime 200, sans-Origin 200, scénario
      proxy via app.public_url 200)*.
- [x] Vérifier l'origin lors de l'upgrade WebSocket *(fait le 22/07 —
      allow-list Host / x-forwarded-host / app.public_url ; vérifié : origin
      hostile rejetée 403, WS nominal intact)*.
- [x] Définir `maxPayload` *(1MiB)*, ~~limites de débit et limites
      d'input~~ *(reste ouvert)*.
- [ ] Conserver `SameSite`, `HttpOnly` et `Secure` comme protections
      complémentaires, pas uniques.

### P1.5 — Réduire les écritures de prolongation de session

> 🔎 **Verdict : ✅ CONFIRMÉ** (`middleware.ts:37-42` + `auth.ts:101-105` :
> `touchSession` inconditionnel = un UPDATE SQLite par requête authentifiée,
> polling 5s inclus). **Recalibré P2** : WAL local, mono-user — coût réel
> modeste. Mais le fix est trivial (ne rafraîchir que si l'expiration est à
> moins de N heures), autant le faire.

Chaque requête authentifiée prolonge actuellement la session en SQLite. Avec
le polling, cela crée un flux continu d'écritures WAL.

- [x] Ne toucher la session que toutes les 5 à 15 minutes *(fait le 22/07 —
      refresh seulement quand le TTL restant < TTL−30min, soit ≤1 UPDATE/30min
      par session au lieu d'un par requête)*.
- [x] Utiliser un `UPDATE ... WHERE expires_at < threshold` *(équivalent :
      le seuil est vérifié en amont sur la ligne déjà lue)*.
- [x] Nettoyer les entrées mémoire associées aux sessions expirées *(fait le
      22/07 — cleanupExpiredSessions avait ZÉRO appelant ; désormais au boot
      + quotidien, purge lignes expirées + SESSION_KEYS orphelines)*.
- [ ] Mesurer latence, contentions et taille du WAL.

### P1.6 — Rendre l'initialisation retryable

> 🔎 **Verdict : ✅ CONFIRMÉ — et assumé dans le code.** `seed.ts:8-11` :
> `initialized = true` latché AVANT toute exécution, chaque étape en
> try/catch qui log et continue ; le commentaire l.17-18 admet lui-même
> l'absence de retry in-process. Une `SQLITE_BUSY` transitoire au boot n'est
> jamais retentée avant le prochain restart. Légitime — c'est la même
> famille de fragilité que §14.45 CLAUDE.md.

`seedInitialData()` marque l'ensemble comme initialisé avant que tous les
sous-systèmes aient réussi. Une erreur transitoire peut donc ne jamais être
retentée pendant la vie du processus.

- [x] Maintenir un état indépendant par sous-système *(fait le 22/07 —
      `STEPS[]` + Set `stepOk`, hot path O(1) quand tout est ok)*.
- [x] Marquer chaque étape prête seulement après succès *(l'étape async est
      marquée optimiste et re-marquée pending si sa promesse rejette)*.
- [x] Retenter avec backoff *(timer 5s → ×2 → cap 5min, unref ; relance
      aussi opportuniste à chaque appel hot-path)*.
- [ ] Distinguer liveness et readiness.
- [ ] Ajouter un endpoint ou bouton de relance administrative *(moins urgent :
      le backoff auto couvre le cas ; les routes SSE/focus re-déclenchent déjà)*.

**Fichier principal** : `lib/server/seed.ts`

### P1.7 — Supprimer ou implémenter les réglages décoratifs

> 🔎 **Verdict : ✅ CONFIRMÉ.** `session.max_active` et
> `retention.killed_days` : présents dans DEFAULTS, ALLOWED_KEYS et l'UI
> (`SettingsModal.tsx:159-162`), mais `getSettingNumber()` a ZÉRO appelant
> dans tout le repo — aucun effet runtime. La rétention « killed » est de
> toute façon incohérente avec la suppression immédiate (§14.29).
> **Recommandation : SUPPRIMER (P2), pas implémenter** — `max_active` n'a
> pas de sens métier clair en mono-user.

`session.max_active` et `retention.killed_days` sont exposés sans effet runtime
clair. La rétention des sessions `killed` est incohérente avec leur suppression
immédiate.

- [x] Rechercher et lister tous les réglages lus, écrits et réellement
      utilisés *(fait — seuls `session.max_active` et `retention.killed_days`
      étaient fantômes)*.
- [ ] Implémenter ceux qui ont encore un sens métier *(aucun retenu —
      `max_active` n'a pas de sens en mono-user)*.
- [x] Retirer proprement les autres de l'API, de l'UI et de la documentation
      *(fait le 22/07 : DEFAULTS + ALLOWED_KEYS + SettingsModal + lignes DB
      purgées)*.
- [ ] Ajouter un test par réglage modifiable.

### P1.8 — Valider la configuration au démarrage

> 🔎 **Verdict : ✓ raisonnable, non vérifié en détail.** Ajouter : tant que
> `SESSION_SECRET` est mort (P0.7), ne pas le valider — le supprimer ou
> l'utiliser d'abord.

*(✔ fait le 22/07/2026 — `lib/server/configCheck.ts`, WARN-ONLY par design
(un .env cassé doit dégrader bruyamment, jamais briquer le hub). A trouvé un
vrai problème dès le premier run : charon.db en 644 world-readable → 600.)*

- [x] Vérifier longueur et entropie de `MASTER_PASSWORD`, `MASTER_SALT`,
      `SESSION_SECRET` et `SYNC_TOKEN` selon leur usage final.
- [x] Refuser les placeholders connus en production *(liste : changeme,
      dummy, ci-dummy…, en warn)*.
- [x] Vérifier que `MASTER_SALT` est un hexadécimal valide *(sinon
      `Buffer.from(salt,'hex')` avale silencieusement le non-hex → clé
      affaiblie)*.
- [x] Vérifier les droits du répertoire DB ~~et des clés SSH~~ *(DB oui +
      mode du fichier ; clés ssh = à ssh de râler)*.
- [ ] Exposer les erreurs dans la readiness sans divulguer les secrets.

## 5. P2 — Base de données et performances serveur

### P2.1 — Passer la recherche à SQLite FTS5

> 🔎 **Verdict : ⚠️ PARTIEL.** LIKE %..% confirmé (`search/route.ts:22`),
> mais `.limit(80)` existe déjà et les lookups session/VPS sont mémoïsés
> par requête (Set + Map) — pas de N+1 par résultat. FTS5 = confort, à
> faire quand la volumétrie le justifiera.

La recherche actuelle repose sur `%LIKE%` et effectue des lookups associés.

- [ ] Introduire une table FTS5 synchronisée avec les messages.
- [ ] Utiliser des jointures pour session et VPS.
- [ ] Ajouter pagination par curseur et limites de requête.
- [ ] Définir une longueur minimale et maximale de recherche.
- [ ] Mesurer les query plans sur une base volumineuse.

### P2.2 — Éliminer les N+1 et scans globaux

> 🔎 **Verdict : ❌ FAUX pour les sessions, ✅ pour les shells.** La liste
> des sessions calcule le preview en UNE requête agrégée
> (`sessions/route.ts:49-58`, `MIN(id) GROUP BY session_id`) — pas de N+1.
> Seul `GET /api/shells` fait un lookup VPS par shell
> (`shellSession.ts:117-120`) — N minuscule en pratique. La dénormalisation
> proposée n'est PAS justifiée par les mesures actuelles. **Recalibré P3.**

Cas identifiés : ~~premier message utilisateur calculé pour toutes les
sessions~~ *(faux — déjà agrégé)*, et nom VPS recherché shell par shell.

- [x] Remplacer les lookups successifs par des jointures (shells) *(fait le
      22/07 — Map des noms VPS en une requête)*.
- [ ] Dénormaliser `first_user_preview` et `last_message_at` si les mesures le
      justifient.
- [ ] Mettre à jour les champs dénormalisés dans les mêmes transactions.
- [ ] Ajouter des benchmarks avec plusieurs millions de messages.

### P2.3 — Définir une politique de croissance et sauvegarde SQLite

> 🔎 **Verdict : ✓ raisonnable** — rien à redire, le point sauvegarde
> (backup API + test de restauration) est le plus utile du lot.

- [ ] Définir la rétention des messages, logs, snapshots et événements.
- [ ] Ajouter quotas par session et VPS.
- [ ] Utiliser l'API backup SQLite pour les sauvegardes cohérentes.
- [ ] Tester automatiquement la restauration.
- [ ] Planifier checkpoints WAL, `PRAGMA optimize` et maintenance.
- [ ] Alerter sur taille DB, WAL et espace disque.
- [ ] Permettre un export avant purge.

### P2.4 — Renforcer les contraintes de schéma

> 🔎 **Verdict : ✅ absences confirmées** (zéro `check()` dans schema.ts ;
> `vpsPaths` n'a qu'un index non-unique — doublons possibles).

- [ ] Ajouter des `CHECK` pour les statuts, modes et kinds *(non fait :
      SQLite ne sait pas ADD CONSTRAINT — rebuild de table 12 étapes, risque
      disproportionné)*.
- [x] Ajouter une contrainte unique naturelle sur `(vps_id, path)` *(fait le
      22/07 — migration 0024, dédoublonnage prépendu à la main)*.
- [ ] Employer des upserts atomiques au lieu de déduplications applicatives.
- [ ] Vérifier les foreign keys applicatives encore non garanties par SQLite.
- [ ] Tester les migrations depuis plusieurs versions historiques.

### P2.5 — Uniformiser la validation des API

> 🔎 **Verdict : non vérifié en détail** — cohérent avec les constats P1.3
> (validation par `String()` brut).

- [ ] Introduire des schémas runtime partagés avec les types frontend.
- [ ] Uniformiser les erreurs JSON et les codes HTTP.
- [ ] Retourner `404` pour les ressources absentes, pas `null` avec `200`.
- [ ] Limiter taille des bodies, tableaux et chaînes.
- [ ] Gérer explicitement le JSON malformé.
- [ ] Ajouter des tests de routes et un fuzzing léger des entrées.

### P2.6 — Paralléliser les notifications de manière bornée

> 🔎 **Verdict : ⚠️ PARTIEL.** Séquentiel + sans timeout confirmé
> (`webPush.ts:47-63`, seule option `TTL: 60`). ❌ Correction : la
> suppression des subscriptions invalides EXISTE déjà (404/410 →
> `db.delete`, l.59-61). En mono-user le nombre de subs est minuscule —
> priorité basse.

- [x] Envoyer Web Push avec une concurrence limitée plutôt que strictement
      séquentielle *(fait le 22/07 — allSettled parallèle ; le nombre de subs
      est minuscule, pas besoin de pool)*.
- [x] Définir des timeouts *(fait le 22/07 — 10s par envoi via Promise.race)*.
- [ ] ~~Supprimer les abonnements définitivement invalides.~~ *(déjà fait)*
- [ ] Mesurer échecs et latence sans exposer les endpoints complets.

## 6. P2 — Frontend, UX et accessibilité

### P2.7 — Découper les gros composants par machines d'état

> 🔎 **Verdict : ✓ légitime sur le fond, DANGEREUX en pratique.** Ces
> fichiers concentrent des dizaines d'invariants documentés (CLAUDE.md §14 :
> dedup optimiste, re-pairing rebuild, focus self-heal, flush-before-switch…)
> qu'un découpage aveugle casserait. À faire en DERNIER, après les tests de
> panne (la review le dit elle-même, Phase B.5) — et invariant par
> invariant, pas fichier par fichier.

Les principaux points chauds sont `ClaudePanel.tsx`, `sessionOps.ts`,
`useClaudeSessionStream.ts`, `session.py` et `ClaudeSessionView.tsx`.

Le découpage doit suivre les domaines, pas seulement le nombre de lignes :

- [ ] connexion et reconnexion ;
- [ ] replay et persistance ;
- [ ] permissions et questions ;
- [ ] shells ;
- [ ] configuration VPS ;
- [ ] notifications ;
- [ ] navigation responsive.

Extraire des transitions pures et les tester avant de déplacer les effets.

### P2.8 — Corriger la course réseau de la recherche

> 🔎 **Verdict : ⚠️ PARTIEL.** Course confirmée (pas d'AbortController ni
> garde de fraîcheur, `SearchModal.tsx:33-40`) — mais ❌ un debounce 250 ms
> existe déjà. Fix = 5 lignes (compteur monotone). Quick win.

- [x] Annuler la requête précédente avec `AbortController`, ou utiliser un
      identifiant monotone *(fait le 22/07 — flag `stale` par effet, la
      réponse d'une frappe antérieure est ignorée)*.
- [x] Ignorer toute réponse ne correspondant plus à la recherche courante.
- [ ] Tester les réponses arrivant dans le désordre.

**Fichier principal** : `app/SearchModal.tsx`

### P2.9 — Ne plus envoyer une requête HTTP par frappe dans le login

> 🔎 **Verdict : ✅ CONFIRMÉ** (`LoginConsole.tsx:107-113`, un POST par
> `onData`). **Recalibré P3** : la console ne sert qu'au `claude login`,
> une fois par VPS, quelques dizaines de frappes — impact réel négligeable.

- [x] Utiliser un WebSocket duplex, ou une queue HTTP sérialisée et batchée
      *(fait le 22/07 — queue coalescée, UN envoi en vol à la fois)*.
- [x] Garantir l'ordre des octets *(par construction : sender unique
      sérialisé — l'ancien code pouvait réordonner deux POST en vol)*.
- [ ] Gérer backpressure, fermeture et reconnexion.
- [ ] Tester le comportement avec 300 à 1 000 ms de latence.

**Fichier principal** : `app/LoginConsole.tsx`

### P2.10 — Faire une passe d'accessibilité complète

> 🔎 **Verdict : plausible (non audité en détail).** Outil mono-utilisateur —
> P3 à mon sens, sauf si publication grand public visée.

- [ ] Remplacer les `div` et `li` interactifs par des boutons/liens adaptés.
- [ ] Ajouter navigation clavier et focus visible.
- [ ] Ajouter `role="dialog"`, `aria-modal` et titre associé aux modales.
- [ ] Implémenter focus initial, focus trap, Escape et restauration du focus.
- [ ] Vérifier les contrastes et annonces live des statuts.
- [ ] Ajouter axe-core à une suite Playwright.

### P2.11 — Réactiver React Strict Mode

> 🔎 **Verdict : ⚠️ nuancé.** `reactStrictMode: false` est INTENTIONNEL et
> documenté (`next.config.mjs:15-17,36` : le double-render dev dupliquait
> les événements SSE). L'objectif est bon, mais c'est un chantier de
> fiabilisation des effets (singleton SSE, queues), pas un simple flag à
> flipper.

La désactivation actuelle masque probablement des effets non idempotents.

- [ ] Rendre les souscriptions singleton et leur cleanup déterministes.
- [ ] Éliminer les doubles ajouts dans les queues et reducers.
- [ ] Réactiver `reactStrictMode`.
- [ ] Ajouter un test de montage/démontage/remontage.

### P2.12 — Réduire polling et poids frontend

> 🔎 **Verdict : ⚠️ ATTENTION — contredit un invariant load-bearing.**
> « Ralentir le polling lorsque SSE est sain » va frontalement contre
> CLAUDE.md §14.24 (« polling IS the no-freeze contract », 5s indépendant
> du SSE, delta `?since=` quasi gratuit — généralement 0 ligne). NE PAS
> toucher au 5s sans relire §14.24 ; le refresh immédiat sur
> reconnexion/foreground existe déjà. Le volet bundle est valable : xterm
> est déjà en dynamic import mais les composants modaux
> (SearchModal/DataModal/ShellTerminal/LoginConsole) sont importés
> statiquement dans ClaudePanel.

- [ ] ~~Ralentir le polling lorsque SSE est sain.~~ *(véto — §14.24)*
- [ ] ~~Rafraîchir immédiatement sur reconnexion et retour au premier
      plan.~~ *(déjà fait — §14.24)*
- [ ] Charger dynamiquement modales, xterm et panneaux rares
      (composants modaux — les libs xterm le sont déjà).
- [ ] Installer un analyseur de bundle dans un script dédié.
- [ ] Définir un budget JS pour la page principale.
- [ ] Borner les caches frontend par LRU si leur croissance est confirmée
      *(vérifié : `sessionCache.ts` non borné mais borné en pratique par le
      nombre de sessions ; codexModelsCache borné par le nombre de VPS ;
      cache wizard libéré à la fermeture — priorité très basse)*.

## 7. P2 — Build, image et dépendances

### P2.13 — Produire une image Docker standalone

> 🔎 **Verdict : ✅ CONFIRMÉ.** Pas d'`output: 'standalone'` ;
> `node_modules` copiés intégraux devDeps incluses (malgré le commentaire
> « pruned » Dockerfile:45) ; `.next` entier copié, cache inclus. Attention :
> `standalone` + custom server demande un peu de soin (server.js requiert
> next) — tester le WS après.

Le build observé génère un `.next` important, dominé par le cache webpack, et
le Dockerfile copie tout `node_modules`, y compris les dépendances de dev.

- [ ] Activer `output: 'standalone'` dans Next.js.
- [ ] Copier uniquement `.next/standalone`, `.next/static` et `public`.
- [x] Ne jamais copier `.next/cache` *(fait le 22/07 — rm avant le COPY)*.
- [x] Ne pas embarquer les dépendances de développement *(fait le 22/07 —
      `npm prune --omit=dev` post-build)*.
- [ ] Mesurer et fixer un budget de taille d'image.
- [ ] Vérifier que `better-sqlite3` fonctionne dans l'image finale.

### P2.14 — Retirer les maquettes temporaires et leurs dépendances

> 🔎 **Verdict : ✅ CONFIRMÉ.** `app/(proto)/v1-v3` buildés ; `three`,
> `@react-three/fiber`, `@react-three/drei`, `@xyflow/react` en
> **dependencies de production** (package.json:47-64). CLAUDE.md §2 les
> qualifie déjà de « à jeter ». Gain facile sur bundle + image.

Les routes `/v1`, `/v2` et `/v3` sont encore produites par le build alors
qu'elles sont décrites comme temporaires.

- [x] Supprimer `app/(proto)` *(fait le 22/07 — aucun import hors-proto
      vérifié avant suppression)*.
- [x] Retirer React Three, Three.js, XYFlow et dépendances transitives
      devenues inutiles *(npm uninstall des 5 paquets)*.
- [x] Vérifier le bundle et l'image après suppression *(build OK, app up,
      /v1-3 n'existent plus)*.

### P2.15 — Rendre le pyz reproductible

> 🔎 **Verdict : ✅ CONFIRMÉ — et plus important que la review ne le dit.**
> `build.sh` : pas de `SOURCE_DATE_EPOCH`, `cp -r` sans `-p`, ordre
> filesystem — non reproductible octet-à-octet ; le pyz est commité.
> **Impact opérationnel réel** : `agentPyzSha` pilote l'auto-update
> fleet-wide (CLAUDE.md §14.53 — « pyz-outdated auto-triggers the tick ») :
> un rebuild no-op change le sha et déclenche une vague de mises à jour de
> TOUS les VPS. **P1 effectif.**

La reconstruction du zipapp peut modifier l'artefact suivi uniquement à cause
des timestamps ZIP.

- [x] Normaliser ordre, timestamps et permissions des entrées *(fait le 22/07
      — build.sh écrit le ZIP lui-même : entrées triées, date fixe 2020-01-01,
      perms 644, `__pycache__` exclu)*.
- [x] Reconstruire deux fois et comparer les SHA *(vérifié : SHA identiques ;
      pyz exécutable — `--connect` exit 2 attendu)*.
- [x] Faire échouer la CI si le pyz commité n'est pas reproductible ou à
      jour *(fait le 22/07 — step `git diff --exit-code` post-build, rendu
      possible par le build déterministe)*.

### P2.16 — Automatiser la surveillance des dépendances

> 🔎 **Verdict : ⚠️ PARTIEL.** Un `npm audit --omit=dev --audit-level=high`
> existe DÉJÀ en CI (job `audit`) mais en `continue-on-error: true` — le
> rendre bloquant est un one-liner.

- [x] Configurer Renovate ou Dependabot *(❌ constat review : un
      `.github/dependabot.yml` complet existait DÉJÀ — npm + actions + pip,
      groupé hebdo, garde manuelle better-sqlite3 major)*.
- [ ] Épingler explicitement les dépendances critiques si nécessaire.
- [x] Rendre les vulnérabilités high/critical bloquantes avec allowlist
      temporaire documentée *(fait le 22/07 — `continue-on-error` retiré du
      job audit)*.
- [ ] Conserver les avis Next.js officiels dans le processus de mise à jour.

Au moment de l'audit, le lockfile construisait Next.js 15.5.18, qui inclut le
correctif de l'avis officiel
[GHSA-26hh-7cqf-hhc6](https://github.com/vercel/next.js/security/advisories/GHSA-26hh-7cqf-hhc6).
L'audit npm complet n'a pas pu être effectué à cause de l'accès réseau limité ;
ce point reste donc à valider.

## 8. P1/P2 — Tests et CI

### 8.1 État de référence au 22 juillet 2026

> 🔎 **Compléments vérifiés** : CI = `.github/workflows/ci.yml`, matrice
> Node 20/22 mais Python 3.11 SEUL ; 5 fichiers de tests TS + 5 Python ;
> Playwright absent des devDependencies confirmé ; `scripts/smoke.mjs`
> fait bien `npm i playwright --no-save` à la volée.

| Vérification | Résultat |
|---|---|
| Build production Next.js | OK |
| Protocol sync Python/TypeScript | 33 méthodes alignées |
| Typecheck TypeScript | OK |
| Tests TypeScript | 89 réussis |
| Tests Python | 77 exécutés, dont 2 ignorés |
| Audit npm | Non conclu : accès registre indisponible |
| Smoke Playwright | Non exécuté : Playwright absent des dépendances |

### 8.2 Scénarios critiques manquants

- [ ] Erreur DB au milieu d'un replay.
- [ ] Réponse assistant identique dans deux tours différents.
- [ ] Rotation avec trou de séquence.
- [ ] Client SSH/SSE/WebSocket extrêmement lent.
- [ ] Timeout RPC avant et après livraison réelle.
- [ ] Création distante de shell suivie d'un échec DB.
- [ ] Échec du kill distant suivi d'une reconnexion.
- [ ] Redémarrage de Charon et de l'agent à chaque phase d'une opération.
- [ ] Traduction complète Claude et Codex vers le vocabulaire commun.
- [ ] WebSocket via le vrai `server.js`.
- [ ] Déploiement et démarrage de l'image Docker.
- [ ] Migration d'une DB représentative de chaque version importante.

### 8.3 Corriger les skips trop permissifs

Les tests d'intégration daemon peuvent ignorer une sortie prématurée de
l'agent. Une régression de démarrage peut ainsi apparaître comme un simple
skip.

- [ ] Skipper uniquement les prérequis environnementaux reconnus.
- [ ] Capturer et afficher stderr lors d'une sortie inattendue.
- [ ] Faire échouer tout crash non classifié.
- [ ] Construire le pyz avant les tests d'intégration.

### 8.4 Renforcer la matrice CI

> 🔎 **Verdict : ❌ constat inversé sur les commentaires.** `ci.yml:7` dit
> « There are no unit tests in the repo yet » alors que la CI exécute
> `npm test` + `npm run test:py` sur 10 fichiers de tests existants — le
> commentaire NIE des tests qui existent, il n'en promet pas d'inexistants.
> À corriger quand même (commentaire périmé), mais dans l'autre sens.

- [x] Tester Python 3.10, 3.11 et 3.13 *(fait le 22/07 — matrice appariée :
      node 20+py3.10 / node 22+py3.13, les deux extrêmes des plages
      supportées sans doubler les jobs)*.
- [x] Conserver Node 20 et 22.
- [ ] Ajouter smoke WebSocket et Docker.
- [ ] Installer et épingler Playwright comme devDependency.
- [ ] Ne plus exécuter `npm install --no-save` depuis le smoke test.
- [x] Corriger le commentaire ci.yml:7 (périmé : il niait des tests
      existants) *(fait le 22/07)*.
- [ ] Publier les rapports de tests, couverture et audit en artefacts.

## 9. P3 — Documentation et observabilité

### P3.1 — Réaligner la documentation avec le code

> 🔎 **Verdict : ✅ CONFIRMÉ, et à étendre.** Vérifiés : CLAUDE.md = 71k
> chars (limite auto-annoncée 60k, compression déjà marquée DUE dans son
> bandeau) ; CLAUDE.md §3 (« SESSION_SECRET | session-cookie signing ») et
> §12 sont factuellement FAUX (cf. P0.7) ; README décrit un chiffrement AES
> des settings inexistant ; CLAUDE.md §2 ne documente ni `Dockerfile`, ni
> `tests/`, ni `.github/ci.yml`, ni `docs/` (ajoutés en mai-juin 2026).

- [ ] Corriger les commandes Docker/systemd.
- [ ] Retirer la description d'un frontend mobile séparé.
- [ ] Corriger les affirmations sur le chiffrement et la signature de session
      (README **et** CLAUDE.md §3/§12).
- [ ] Clarifier que Telegram et Web Push ont des gates indépendantes.
- [ ] Documenter les limites de rétention du replay.
- [ ] Compresser `CLAUDE.md` sous la limite annoncée de 60k caractères sans
      renuméroter les sections ou gotchas.
- [ ] Documenter Dockerfile/tests/CI dans CLAUDE.md §2 (ou l'inverse :
      décider si ces artefacts publics font partie du contrat).
- [ ] Ajouter une validation CI des commandes et liens documentés critiques.

### P3.2 — Ajouter une observabilité adaptée au système distribué

> 🔎 **Verdict : ✓ sur le principe — surdimensionné en l'état.** Dashboards
> et seuils d'alerte pour un hub single-user : commencer par des logs
> corrélés (`session_id`, `vps_id`, `seq`) et 2-3 compteurs (reconnexions,
> gaps, holders orphelins) exposés dans la santé VPS existante (§14.60).

- [ ] Logs JSON structurés.
- [ ] Corrélation par `request_id`, `rpc_id`, `session_id`, `vps_id` et `seq`.
- [ ] Métriques de reconnexion et durée de coupure.
- [ ] Métriques de replay, gaps et dead letters.
- [ ] Profondeur et taille des queues.
- [ ] Latence DB, taille WAL et event-loop lag.
- [ ] Nombre de holders orphelins ou en suppression.
- [ ] Échecs Web Push/Telegram.
- [ ] Dashboards et seuils d'alerte documentés.

### P3.3 — Séparer liveness, readiness et diagnostics

- [x] Garder une liveness publique minimale, par exemple `{ "ok": true }`
      *(fait le 22/07 — anonyme = `{ok, db}` seulement)*.
- [x] Protéger versions, SHA, détails DB et erreurs internes par
      authentification *(fait le 22/07 — champs diagnostics uniquement avec
      un cookie session valide)*.
- [ ] Ajouter une readiness qui vérifie DB, initialisation et capacité agent.
- [ ] Ne jamais exposer de secret ou chemin sensible dans les réponses.

## 10. Feuille de route recommandée

> 🔎 **Contre-analyse** : ordre globalement validé, avec les ajustements de
> la section 0 — commencer par les quick wins (masking secrets, Docker/
> systemd, validations SSH, stop/forget shells), puis le chantier « seq par
> message » qui fusionne A.2/A.3, puis backpressure agent. Le pyz
> reproductible remonte en phase A (impact auto-update fleet). Les
> refactorings (Phase E.1) restent bien en dernier, APRÈS les tests de
> panne.

### Phase A — Stabilisation immédiate

1. Corriger Docker et systemd.
2. Corriger curseur et déduplication du replay (chantier unique : seq par
   message + contrainte unique).
3. Signaler les gaps de journal.
4. Borner les queues réseau (agent d'abord).
5. Rendre création et suppression des shells récupérables.
6. Masquer les secrets dans toutes les réponses API.
7. *(ajout)* Rendre le pyz reproductible (évite les vagues d'auto-update).

### Phase B — Cohérence distribuée

1. Ajouter idempotency keys ~~et outbox~~ pour les prompts/RPC.
2. Réconcilier périodiquement sessions et shells.
3. Centraliser SSH et valider les cibles.
4. Rendre le seed retryable.
5. Écrire les tests de panne avant les grands refactorings.

### Phase C — Sécurité

1. Migrer les secrets vers le stockage chiffré (+ hash des tokens session).
2. Renforcer Origin, CSRF, proxy trust et WebSocket.
3. Valider la configuration de production au démarrage.
4. Mettre en place audit de dépendances bloquant et mises à jour automatisées.

### Phase D — Performance et exploitation

1. FTS5, jointures et index.
2. Politique de rétention, sauvegarde et restauration.
3. Image Docker standalone et suppression des prototypes.
4. Observabilité (proportionnée), budgets de ressources et tests de charge.

### Phase E — Maintenabilité et UX

1. Extraire les machines d'état testables.
2. Réactiver Strict Mode.
3. Corriger accessibilité et courses réseau.
4. Réduire ~~polling et~~ bundle navigateur *(le polling 5s est un contrat,
   §14.24)*.
5. Finaliser la documentation.

## 11. Définition de « production fiable »

Charon pourra être considéré comme robuste lorsque les critères suivants seront
vérifiés automatiquement :

- [ ] aucune perte silencieuse lors d'un replay ou d'une rotation ;
- [ ] un prompt ne peut être exécuté deux fois à cause d'un timeout ;
- [ ] un client lent ne peut pas provoquer une croissance mémoire non bornée ;
- [ ] aucun shell ne devient définitivement invisible après une erreur partielle ;
- [ ] aucun secret complet ne sort de l'API de configuration ;
- [ ] Docker et systemd passent un smoke WebSocket ;
- [ ] une sauvegarde récente est restaurée régulièrement en test ;
- [ ] les migrations sont validées depuis des bases anciennes ;
- [ ] les scénarios de crash agent/hub sont couverts en CI ;
- [ ] liveness, readiness et diagnostics sont distincts ;
- [ ] les alertes permettent d'identifier un gap, une queue saturée ou un
      holder orphelin.

## 12. Principe directeur

Les refactorings esthétiques doivent venir après les garanties de données et de
ressources. La priorité est :

> replay exact → idempotence → backpressure → cycle de vie récupérable →
> protection des secrets → performance → maintenabilité.
