# TODO avant publication open-source

État du repo : **techniquement publiable** (pas de secrets commités, code propre,
pas de TODO/`console.log` qui traînent), mais il manque tout l'enrobage OSS et
le code porte encore plein d'empreintes de son environnement d'origine.

---

## 1. Bloquants — à faire avant le premier push public

- [ ] **Ajouter une LICENSE**
  Sans licence, le code est *all rights reserved* par défaut, personne ne peut
  légalement l'utiliser. Choix à faire : MIT / Apache-2.0 / AGPL-3.0 (AGPL si
  on veut que les déploiements SaaS dérivés restent ouverts).

- [ ] **Écrire un README**
  Le livrable manquant le plus visible. À inclure :
  - Pitch 2 lignes (« panneau web pour piloter des sessions Claude Code sur des
    VPS via SSH »).
  - Capture d'écran ou GIF.
  - Prérequis : Node 20+, Python 3 + `claude-agent-sdk`, accès SSH aux VPS
    cibles.
  - Quickstart :
    ```
    cp .env.example .env
    # remplir MASTER_PASSWORD + openssl rand -hex 32 pour SESSION_SECRET / MASTER_SALT
    npm i
    npm run db:migrate
    npm run build
    npm start
    ```
  - Mot sur l'archi : Next 15 + SQLite (better-sqlite3 + Drizzle) + bridge
    Python (`lib/server/claude/bridge.py`) piloté via SSH par VPS.

- [ ] **Compléter `package.json`**
  Champs manquants : `description`, `license`, `repository`, `author`,
  `keywords`, `homepage`. Laisser `"private": true` si on ne publie pas sur npm.

- [ ] **Renommer le projet (à arbitrer)**
  `charon` est déjà pris par `linuxserver/Charon` (dashboard PHP très
  populaire). Mauvais pour le SEO. Pistes : `claude-charon`,
  `charon-claude`, autre.

---

## 2. Fuites d'environnement à nettoyer

- [ ] **`/srv/hub/data/hub.db`** dans `scripts/import-from-hub.mjs:8`
  Référence à un autre projet privé. Soit on supprime ce script (il est marqué
  « one-shot »), soit on le déplace dans `migrations/legacy/` avec une note.

- [ ] **`/srv/charon`** en dur à plusieurs endroits
  - `.env.example` : `DATABASE_URL=/srv/charon/data/charon.db` → mettre
    `./data/charon.db`.
  - `scripts/import-from-hub.mjs:9`.
  - **Placeholder UI** `app/NewSessionDialog.tsx:113` (`placeholder="/srv/hub"`).

- [ ] **Email perso `c2@c2m2.ai`** en dur dans `lib/server/claude/settings.ts:10`
  (VAPID subject). À transformer en variable d'env `VAPID_SUBJECT`.

- [ ] **« Chalom »** dans un commentaire `lib/db/schema.ts:30`. À reformuler.

- [ ] **Tout est en français** (commentaires + UI + scripts)
  Défendable mais limite l'audience OSS. Minimum : traduire le README.
  Idéalement : traduire les commentaires de code (les identifiants sont déjà en
  anglais, l'effort est limité).

---

## 3. Choix techniques à documenter ou revoir

- [ ] **`MASTER_PASSWORD` joue deux rôles** — login *et* dérivation de clé AES
  via scrypt. Le changer rend les données chiffrées illisibles. À expliciter
  agressivement dans README + `.env.example`.

- [ ] **Single-user par design** — `ensureUser()` crée un user unique avec
  `passwordHash: 'env'`. Aucun multi-tenant. À assumer dans la doc
  (« self-hosted, mono-utilisateur »).

- [ ] **`secure: false`** sur le cookie de session (`middleware.ts`).
  OK derrière un reverse proxy HTTP local, mais surprenant à lire. Soit le
  passer à `process.env.NODE_ENV === 'production'`, soit ajouter un commentaire
  « on suppose un reverse proxy TLS ».

- [ ] **`reactStrictMode: false`** (`next.config.mjs`) — c'est l'inverse du
  défaut Next. Une ligne d'explication.

- [ ] **Pas de headers de sécurité** (CSP, HSTS, X-Frame-Options) dans
  `next.config.mjs`. Attendu pour un outil qui exécute du SSH et stocke des
  clés API.

- [ ] **Aucun test** — pas bloquant, mais l'absence de `*.test.ts` fait fuir
  les contributeurs sérieux. Minimum syndical : 2-3 tests sur `crypto.ts` et
  `auth.ts`.

- [ ] **Pas de CI** — ajouter `.github/workflows/ci.yml` qui fait au moins
  `npm ci && npm run build` + `tsc --noEmit` sur PR.

- [ ] **`requirements.txt` Python manquant** — `bridge.py` dépend de
  `claude-agent-sdk`, jamais déclaré. À ajouter.

---

## 4. Nice-to-have (post-premier-push)

- [ ] `CONTRIBUTING.md` (même 20 lignes).
- [ ] `CODE_OF_CONDUCT.md`.
- [ ] Templates d'issue / PR (`.github/ISSUE_TEMPLATE/`).
- [ ] Capture d'écran ou GIF de démo dans le README.
- [ ] `CHANGELOG.md`.
- [ ] Badges README (build, license, version Node).

---

## Verdict

Le code est sain, l'archi se défend, `git ls-files` est clean (pas de `.env`
ni de DB commités). En 1 à 2 journées de boulot on passe de « pas publiable »
à « repo OSS crédible » :

1. LICENSE
2. README
3. Suppression des `/srv/hub` / `/srv/charon` / email perso
4. `requirements.txt` Python
5. Un workflow CI minimal

Le reste (tests, traduction, headers de sécu) peut venir après le premier push.
