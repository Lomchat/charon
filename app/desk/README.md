# Le desk — la salle des machines de Charon

Une salle en Three.js, servie sur `/desk`, où chaque session de Charon est un
robot à son poste : on voit qui travaille, qui attend une réponse, qui a fini
sans qu'on l'ait lu, et on ouvre la session d'un clic.

## Le sens de la dépendance

**Le desk dépend de Charon ; Charon ne dépend pas du desk.** Rien hors de
`app/desk/` n'importe ce dossier : le supprimer ne casse aucune autre page. Seule
trace à retirer alors : l'ancre `a.head-btn[href="/desk"]` de l'en-tête
(`app/HubPanel.tsx`), qui ouvre la salle dans un nouvel onglet (la salle prend
l'écran et le clavier).

Ce qui existe côté Charon est **importé, jamais recopié** — deux définitions de
« en cours » finiraient par diverger :

| Ce que le desk utilise | Où c'est défini |
| --- | --- |
| `isWorkingStatus` | `app/sessionUnread.ts` |
| `attentionForRow`, `rowStatus` (bloqué > question > fini non lu) | `lib/sessionAttention.ts` |
| `useSessionList()`, `useVpsRuntime()`, `addOverlay` (résumés `session_summary`) | `app/sync/summaryStore.ts` |
| `PROVIDERS`, `SESSION_PROVIDERS`, `asSessionProvider`, logos `/agents/*.png` | `lib/sessionCapabilities.ts` |
| `ssrSummaries()` — l'amorçage SSR de `/` | `lib/server/sync/ssrSummaries.ts` |
| `setFocus`, `subscribeAll`, `subscribeReconnect`, `initSyncPosition` | `app/globalEventStream.ts` |
| `sidebarPathKey`, `sidebarPathOrderedIds` | `app/sidebarPathGroups.ts` |
| `canSleepSession`, `canResumeSession` | `app/sessionBulkActions.ts` |
| `SessionView`, `SessionContextMenu`, `ConfirmModal`, `PromptModal` | `app/*` |
| `GET /api/sessions` (filet de 60 s), `GET /api/events` (SSE) | `app/api/{sessions,events}/**` |
| `requireSession()`, tables `vps` / `vps_folders` | `lib/**` |

Le desk lit ; il n'écrit que ce que l'utilisateur demande depuis un modal ou un
menu, par les mêmes appels que `/`.

## Les fichiers

```
app/desk/
  page.tsx       composant serveur : session, base, résumés + révision (SSR)
  Desk.tsx       coquille React : magasin de résumés, SSE, modals, menus
  desk.css       habillage (le modal réutilise app.css)
  ui/            SessionModal, StoreModal, Hud, time
  vendor/        three.module.js (r160, vendu, pas de CDN)
  hall/          la salle : Three.js, sans React
    world.js     renderer, boucle, sélection, pick ; frontière TS : world.d.ts
    layout.js    où poser chaque chose (baies, quais, sols, postes, armoires)
    hall.js      sol, zones, quais, noms peints, lumières
    robots.js    la flotte : InstancedMesh, une instance par pièce et par robot
    store.js     l'armoire d'un quai
    palette.js   état d'une session → couleur, pose, cadence ; noms (+ .d.ts)
    screens.js   l'écran des robots
    plates.js    la plaque de nom posée sur le bureau
    geom.js      géométrie des pièces
    canvas.js    textures peintes (écrans, plaques, noms, logos)
    text.js      assainit le texte venu des sessions avant le DOM
    project.js   projection monde → écran (rejette ce qui est derrière la caméra)
    overlay.js   DOM projeté : titres de file, bulles, survol
    camera.js    caméra libre et ses bornes
    env.js       environnement d'éclairage
```

`hall/` est en **JavaScript** : Three.js reste hors du typage de Charon, et la
frontière est `hall/world.d.ts`. **Aucune syntaxe TypeScript dans `hall/*.js`** :
SWC les lit comme du JavaScript et le build échoue (`Expected ',', got 'as'`).

## La salle

Trois étages, tous venus de Charon :

- une **zone** = un dossier de VPS de Charon ; dedans, les machines suivent
  l'ordre de la barre latérale ;
- une **baie** = une allée bordée de quais ; un **quai** = une machine (VPS) ;
- dans un quai, le **chemin de travail** (`cwd`) range les robots.

Le regroupement par chemin **est** celui de la barre latérale : `layout.js` prend
`sidebarPathKey` comme clé. Les robots d'un même chemin se tiennent en **file
indienne**, de l'allée vers le fond, un poste tous les `DIMS.postGap`. Un
dossier qui en contient d'autres ouvre **un sol** (une dalle peinte) portant sa
propre file ; les sols de ses sous-dossiers se posent côte à côte, au même bord
avant, derrière sa file. Deux passes : **`sizeFloor`** mesure de bas en haut
(largeur = file + enfants, profondeur = `max(file, BAND + enfant)`),
**`placeFloor`** pose de haut en bas (enfants à `BAND` du bord du parent,
frères séparés par `DIMS.floorGap`, marge `DIMS.floorPad`). Un dossier sans
robot à lui et à un seul sous-dossier n'a pas de sol : son nom se fond dans
celui de l'enfant (`/opt/iron_golem`). La salle publie une liste plate,
`quai.levels` ; l'arbre est dans les positions.

**Une machine sans agent éveillé n'apparaît pas** (ni quai, ni armoire, ni nom) ;
le HUD donne le compte (« 25 machines · 4 on the floor »). Le filtre vit dans
`layout.js`, pas dans `world.js` : une machine écartée n'existe pas.

### L'armoire

Un robot endormi n'est **pas** dans la salle. Au fond de chaque quai, une
**armoire** (`store.js`) : des voyants (un par famille de moteur présente) et
une plaque (compte d'endormis + nom de la machine). Un clic ouvre la liste de
ses endormis (`ui/StoreModal.tsx`), rangée par chemin avec le code et les
classes de la barre latérale (`sidebarPathOrderedIds`, `.cs-path-group`) ; une
ligne ouvre le même `SessionModal` qu'un robot, la liste reprenant la main à la
fermeture (`covered` : un seul modal écoute Échap et les clics).

L'armoire se vise au rayon (`world.js:pickStore`) ; dans `_click`, le robot
passe **avant** l'armoire (là où une file la couvre, on ouvre le robot).

## Ce qui se lit, dans l'ordre

1. **La couleur qui bat** — tout le robot, et son poste avec lui : bleu, tour en
   cours ; orange, question en attente ; vert, fini non lu ; gris, rien ; rouge,
   en panne. La couleur d'état **multiplie** la couleur d'instance du mobilier
   (sombre à dessein), elle ne la remplace pas. Un état sans pulsation reste
   teinté et fixe.
2. **Le nom**, sur une carte inclinée posée sur le bureau (`plates.js`), tournée
   vers l'allée, à la plus grande taille qui tienne. Toile blanche, encre noire :
   la matière la teint de la couleur d'état (`material.color`), donc seul un
   changement de nom la repeint. Une plaque par robot debout, gardée par id de
   session ; un robot qui s'endort rend la sienne au pool. La salle écrit le nom
   **sans arobase** (`roomName`) ; les panneaux, qui adressent, gardent
   `@handle` (`robotName`).
3. **Le logo du moteur** (`/agents/{claude,codex,cursor}.png`) sur l'écran, et
   au dos du moniteur pour l'allée.
4. **La pose** : debout, assis, main levée.
5. **Le chemin de travail**, deux fois et jamais ensemble : peint à plat devant
   la file (`LANE_LABEL_Z`) pour la vue du dessus ; titre DOM flottant à
   `PATH_LEVEL_Y` quand l'œil rase la salle (`phi < TITLE_PHI`). Le titre porte
   le compte du sol **et de ce qu'il contient**, comme la barre latérale ; un
   chemin trop long perd ses premiers segments (`…/charon`), jamais le dernier.
   Un titre ne s'écarte que vers le haut, pour éviter un autre titre ou la barre
   d'aide (`.dsk-hint`), sans quitter sa colonne ; opacité plancher 0,8.
6. **Le nom de la machine**, peint au sol derrière les postes.
7. **Le nom du dossier**, peint dans l'allée, au pied de sa rangée.
8. **Le liston du quai**, la bande colorée qui dit ce que la machine réclame.

Ni plaque ni panneau devant les quais. Les textes peints se retournent face à la
caméra (`hall.faceCamera`). Tout le texte de la salle est en anglais ; les propos
des sessions viennent de Charon, non traduits. La légende est repliée par défaut
(`localStorage` `desk.legend`).

## Souris et clavier

- **Survol** : nom et chemin du robot en DOM au-dessus de sa tête, couleur de son
  état (`overlay.js:drawHover`) — la seule écriture nette à toute distance.
- **Clic** : `pick` vise d'abord les plaques au rayon, puis la tête la plus
  proche. Il ouvre la session (`SessionModal`) ; **la caméra ne bouge pas**.
- **Clic droit** : sélectionne le robot (l'anneau reste à ses pieds) et ouvre le
  menu de Charon (`SessionContextMenu`) : renommer, endormir/réveiller,
  supprimer. « Resume » ne s'offre qu'à un robot en erreur (les endormis sont
  dans l'armoire). Dans le vide : ferme le menu ouvert. Le bouton est séparé
  **une fois**, dans `world.js:_click` ; un glissement a piloté la caméra et
  n'ouvre rien.
- **Échap** ferme le modal, sauf depuis un `input` ou un composer non vide.

## Ajouter un élément

1. la place se décide dans `layout.js`, jamais dans `world.js` ;
2. la géométrie dans `hall.js` (décor, une fois) ou `robots.js` (flotte, en
   `InstancedMesh`) ;
3. couleur et cadence viennent de `palette.js` — une couleur en dur ailleurs est
   un bug ;
4. l'état d'un robot vient du **modèle vivant**, jamais du plan : `layout.js`
   dit où l'on se tient (`desks[].session` = un id et une place), et
   `Fleet.update` relit chaque session dans `model.sessions`. La salle n'est
   rebâtie que si sa forme change (ouvrir, endormir, changer de quai).
