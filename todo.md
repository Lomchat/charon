# TODO — suites de l'audit Codex

Ordre = priorité décroissante (effort/gain). Les tests sont volontairement exclus.

---

## 1. Index DB sur les chemins chauds (P0, ~1h) — **DONE**

Aucun index défini dans `lib/db/schema.ts` au-delà des PK. SQLite ne crée PAS d'index automatique pour les FOREIGN KEY → toute requête `WHERE session_id = ?` fait un full scan. Le polling delta à 5s amplifie le coût.

- [x] Éditer `lib/db/schema.ts` pour ajouter les index :
  - [x] `claude_session_messages(session_id, id)` — critique, utilisé par GET window, GET `?since`, GET `?before`
  - [x] `claude_pending_permissions(session_id, status)` — utilisé par GET session detail + SSE init
  - [x] `claude_pending_questions(session_id, status)` — idem (le `kind` est trop sélectif pour valoir un compound)
  - [x] `claude_session_logs(session_id, id)` — utilisé par auto_resume / debug
  - [x] `vps_paths(vps_id)` — sidebar groupings
- [x] Migration `drizzle/0010_add_hot_path_indexes.sql` créée à la main (CREATE INDEX IF NOT EXISTS, idempotent)
- [x] Journal `drizzle/meta/_journal.json` mis à jour (idx 10)
- [x] `npm run db:migrate` appliqué avec succès sur `data/charon.db`
- [x] `EXPLAIN QUERY PLAN` confirme `USING INDEX idx_claude_session_messages_session_id_id (session_id=? AND id>?)`
- [x] `npx tsc --noEmit` passe
- [x] CLAUDE.md §4 timeline migrations mis à jour (entrées 0009 + 0010)

**Validation** : `EXPLAIN QUERY PLAN SELECT * FROM claude_session_messages WHERE session_id = 'x' AND id > 100` doit montrer `USING INDEX` au lieu de `SCAN`. ✅ Vérifié.

---

## 2. Bump `RING_SIZE` agent (P0, 5min) — **DONE**

Le ring mémoire de 300 events sature en 3-6 secondes pendant une réponse verbeuse → un simple `systemctl restart charon` pendant un stream peut perdre des events.

- [x] `agent/charon_agent/server.py:57` : `RING_SIZE = 300` → `RING_SIZE = 2000` (+ commentaire explicatif sur la motivation et le coût mémoire)
- [x] `agent/charon_agent/__init__.py` : `__version__ = "0.3.0"` → `"0.3.1"`
- [x] `bash agent/build.sh` → rebuild .pyz (42387 bytes, sha 44c1034ed1fd...)
- [x] `--version` confirme `charon-agent 0.3.1`
- [x] CLAUDE.md §5 (server.py description) mis à jour avec la nouvelle taille + motivation
- [x] CLAUDE.md §6 (events table préambule) mis à jour : "stores up to 2000 per session"
- [x] CLAUDE.md §14 gotcha 31 mis à jour : capacité de 2000 et fenêtre estimée 20-40s
- [ ] Déploiement sur VPS : sera fait au restart final (les VPS apparaîtront "out of date" via le diff `agentPyzSha` vs `getBuiltPyzSha()`)

**Validation** : nouvelle sha pyz visible via `--version` → ✅. Déploiement à valider après restart de Charon.

---

## 3. Fix phantom `currentAssistant` après polling delta (P0, ~30min) — **DONE**

Quand le SSE drop pile pendant un `assistant_text` ET que le `stop` arrive serveur-side ET que le polling rattrape, le buffer streaming reste affiché en plus du message persisté.

- [x] `app/useClaudeSessionStream.ts` : dans `applyDelta`, calcul synchrone de `shouldClearBufAfterMerge` AVANT `setMessages`, puis clear effectif (`assistantBufRef.current = ''`, `setCurrentAssistant('')`) après tous les setStates de merge.
  - Logique retenue : si `serverStreamingText === ''` AND `assistantBufRef.current.length > 0` AND une row assistant du delta a son content qui commence par (ou égale) le buf → clear.
  - Pourquoi prefix match plutôt qu'exact : couvre le cas où le SSE a délivré les premiers tokens mais a coupé avant la fin. Un faux positif clear juste un buf qui sera de toute façon flushé par le prochain event SSE.
  - Pas de fonction helper séparée : la logique tient en 10 lignes inline, garder le flow lisible.
- [x] Commentaire enrichi sur l'origine du bug (scenario SSE drop + flush serveur)
- [x] CLAUDE.md §14 gotcha 24 mis à jour : nouvel invariant (5) "phantom-buffer clear"
- [x] `npx tsc --noEmit` passe
- [ ] Test manuel : `systemctl restart charon` pendant un long stream → attendre 10s → vérifier qu'il n'y a pas de duplicata. **À faire au restart final.**

**Validation manuelle** : à valider au restart final.

---

## 4. Reseparate `peekStream` vs `getOrCreateStream` (P1, ~2h) — **DONE**

`getStream(id)` matérialise un `SessionStream` même pour des sessions sleeping/historiques. Pas de fuite (l'objet n'attach pas de listener), mais c'est sale : chaque ouverture de SSE alloue N wrappers.

- [x] `lib/server/agent/sessionOps.ts` : deux helpers explicites :
  - `peekStream(sessionId)` — lookup-only, retourne null si absent du Map
  - `getOrCreateStream(sessionId)` — hydrate depuis DB si Map miss
  - `getStream` conservé comme alias `@deprecated` → `getOrCreateStream` (compat transitionnelle)
- [x] Call sites migrés vers `peekStream` (read paths) :
  - `app/api/claude/events/route.ts:86`
  - `app/api/claude/sessions/[id]/route.ts:181`
- [x] Call sites migrés vers `getOrCreateStream` (write/lifecycle paths) :
  - `app/api/claude/sessions/[id]/input/route.ts`
  - `app/api/claude/sessions/[id]/permission/route.ts`
  - `app/api/claude/sessions/[id]/question/route.ts`
  - `app/api/claude/sessions/[id]/exit-plan/route.ts`
  - `app/api/claude/sessions/[id]/mode/route.ts`
  - `lib/server/claude/telegram.ts` (3 appels)
  - `lib/server/agent/sessionOps.ts:891` (interne, dans `reconcileVpsAgentState`)
- [x] CLAUDE.md mis à jour : §10 (reconcile description) + nouvelle phrase d'explication sur la convention de nommage
- [x] `npx tsc --noEmit` passe

**Validation** : grep `\bgetStream\b` retourne uniquement (1) la définition alias dans `sessionOps.ts:588`, (2) son commentaire d'explication, (3) la doc CLAUDE.md/todo.md. Aucun appel hors de ces emplacements.

---

## 5. Event log durable côté agent (P2, ~2-3 jours) — **DONE**

La grosse refonte. Le SDK Claude Code persiste déjà la conversation user/assistant côté disque, mais Charon perdait les détails UI (edit_snapshot, todos, perms) si Charon était down et que le ring 2000 saturait. Ce log durable garantit la livraison complète.

### Phase A — protocole + storage agent — **DONE**

- [x] `agent/charon_agent/__init__.py` → `__version__ = "0.4.0"`
- [x] Nouveau module `agent/charon_agent/event_log.py` (228 lignes) :
  - `EventLog(session_id, dir)` avec `append(event) -> seq`, `read_since(seq, limit?) -> list`, `current_seq()`, `delete()`
  - Rotation : 10MB × 3 fichiers max, soit ~30MB worst case par session
  - Format : `{seq, ts, ...event}` un par ligne (JSON-Lines)
  - Tolérant aux lignes corrompues (skip + warning stderr)
  - `_recover_seq` scanne actif + rotations (résiste au crash post-rotation)
  - Helper `cleanup_orphans(base_dir, known_session_ids)` pour le boot
  - Tests unitaires validés : append/read/reload/rotation/crash-recovery/cleanup/delete
- [x] `agent/charon_agent/server.py` :
  - `events_dir = state_path.parent / "events"`, dict `event_logs` per session
  - `_emit` : append au log AVANT le ring AVANT le broadcast (mutate payload pour attacher seq/ts à tout le monde)
  - `kill_session` : appelle `log.delete()` en plus du cleanup mémoire
  - Boot : appelle `cleanup_orphans()` après `_restore_existing`
  - `subscribe` étendu : accepte `after_seq` (durable) prioritaire sur `replay` (ring tail). Retourne `current_seq` dans la réponse
- [x] `agent/build.sh` → pyz rebuilt (52769 bytes, version 0.4.0)

### Phase B — exploitation côté Charon — **DONE**

- [x] `lib/server/agent/types.ts` : `AgentEventCommonFields = {seq?, ts?}` intersecté à `AgentEvent`
- [x] `lib/server/agent/AgentClient.ts` :
  - `subscribe(sessionId, listener, opts?: { afterSeq?: number })` accepte le cursor
  - `setAfterSeq(sid, seq)` exposé pour que `SessionStream` maintienne la map
  - `_pendingAfterSeq: Map<string, number | null>` cache le cursor entre reconnects
  - `_fireSubscribe` choisit between `after_seq` (durable) et `replay: 300` (legacy)
  - Reconnect path (`_onConnected`) appelle `_fireSubscribe(sid)` au lieu d'un appel raw → utilise le cursor
- [x] `lib/server/agent/sessionOps.ts` :
  - `SessionStream` a `lastSeenSeq` / `lastPersistedSeq` / `persistSeqTimer`
  - Constructeur accepte `lastSeenSeq?` (depuis DB)
  - `attach()` passe `{afterSeq: this.lastSeenSeq}` au client
  - `_trackSeq(ev)` appelé en `finally` après chaque dispatch d'event
  - Persist throttlé : landmark (`status`, `stop`) immédiat, sinon debounce 2s
  - `detach()` clear le timer
  - `_onAgentEvent` refactoré en `_dispatchEvent` + wrapper `try/finally`
  - `getOrCreateStream` et `resumeSession` hydratent `lastSeenSeq` depuis DB

### Phase C — DB migration + cleanup — **DONE**

- [x] `lib/db/schema.ts` : `claude_sessions.lastSeenSeq: integer('last_seen_seq')` (nullable)
- [x] Migration `drizzle/0011_add_last_seen_seq.sql` : `ALTER TABLE ... ADD COLUMN last_seen_seq integer`
- [x] Journal `_journal.json` étendu
- [x] `npm run db:migrate` appliqué
- [x] Cleanup orphans au boot agent : déjà géré par `event_log.cleanup_orphans()` dans server.py

### Phase D — doc — **DONE**

- [x] CLAUDE.md §5 : nouveau fichier `~/.charon/events/<sid>.jsonl` (+ rotations) dans l'arborescence VPS
- [x] CLAUDE.md §5 : description du module `event_log.py` ajoutée
- [x] CLAUDE.md §6 : `subscribe` signature étendue (`after_seq?`), `current_seq` dans le retour, mention de `seq`/`ts` dans le préambule événements
- [x] CLAUDE.md §4 : ligne migration 0011 ajoutée, mention `lastSeenSeq` dans la summary table
- [x] CLAUDE.md §14 gotcha 31 : refonte complète, devient "Agent event replay layering" avec les 5 invariants
- [x] CLAUDE.md §15 (Quick lookup) : entrée "Durable agent event log"
- [x] CLAUDE.md §17 : check sur `_emit` qui stamp seq/ts automatiquement
- [x] Protocol sync check passe (16 méthodes alignées Py/TS)
- [x] `npx tsc --noEmit` passe

### Phase E — déploiement progressif — **DONE (côté hub)**

- [x] `npm run build` réussi (Next.js 15.5.18)
- [x] `systemctl restart charon` → service active, ready in 364ms
- [x] `getBuiltPyzSha()` retourne `de4e2f314d71` (le hash du nouveau pyz 0.4.0)
- [x] Smoke test E2E : `python3.10 charon-agent.pyz` répond à `hello` avec `agent_version=0.4.0` + accepte `subscribe(after_seq=N)` sans erreur de protocole
- [x] Pyz validation locale (EventLog unit tests, rotation, crash-recovery) tous OK
- [ ] **À faire côté utilisateur** : ouvrir le dashboard → les VPSes existantes (encore en 0.3.0) apparaîtront "out of date" → cliquer "update" sur chacune des 6 VPSes pour déployer le nouveau pyz
- [ ] Après update, vérifier sur 1 VPS : `ls ~/.charon/events/` doit montrer des `.jsonl` qui se remplissent
- [ ] Après quelques events, `sqlite3 data/charon.db "SELECT id, last_seen_seq FROM claude_sessions WHERE last_seen_seq IS NOT NULL;"` doit lister les sessions actives avec leur cursor

**Validation finale** : `systemctl stop charon` pendant un long stream sur une VPS upgradée → wait 30s → restart Charon → vérifier que les rows manquantes sont rattrapées en DB (via Charon resubscribe avec `after_seq`).

---

## Récapitulatif global

| # | Item | Status |
|---|---|---|
| 1 | DB indexes hot-path (migration 0010) | ✅ DONE |
| 2 | RING_SIZE 300 → 2000 + agent 0.3.1 | ✅ DONE (rolled into 0.4.0) |
| 3 | Phantom `currentAssistant` clear | ✅ DONE |
| 4 | `peekStream` / `getOrCreateStream` split | ✅ DONE |
| 5 | Durable event log agent-side (0.4.0) + DB checkpoint (migration 0011) | ✅ DONE côté code |

**Restant** : déployer le pyz 0.4.0 sur les 6 VPSes via les boutons "update" du dashboard. C'est une action UI 1-clic par VPS, pas du code.

---

## Suivi global

- [ ] Items 1, 2, 3 dans un seul commit "P0 audit fixes" si possible
- [ ] Item 4 dans son propre commit (refacto pur)
- [ ] Item 5 dans une branche séparée `event-log-durable` (refonte protocole)
- [ ] Bumper le CHANGELOG.md pour chaque batch
- [ ] Garder un œil sur `journalctl -u charon -f` après chaque déploiement (chercher des erreurs liées aux nouveaux index ou au nouveau format event)
