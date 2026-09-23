# Le desk — la salle des machines de Charon

Une salle en Three.js où chaque agent de Charon est un robot à son poste : on
voit qui travaille, qui attend une réponse, qui a fini sans qu'on l'ait lu, et
on ouvre la session d'un clic. Accessible sur `/desk`.

## Le sens de la dépendance

**Le desk dépend de Charon. Charon ne dépend pas du desk.** Rien, hors de
`app/desk/`, n'importe quoi que ce soit de ce dossier : supprimer `app/desk/`
suffit à faire disparaître le desk sans casser une seule autre page.

Il reste **une** ligne qui parle de lui, et c'est un lien, pas une dépendance :
l'ancre `a.head-btn[href="/desk"]` de l'en-tête (`app/ClaudePanel.tsx`), à gauche
du sélecteur de sessions — la petite icône de robot qui ouvre la salle dans un
nouvel onglet. Un onglet, parce que la salle prend l'écran et le clavier (WASD y
flotte) et que ça ne se partage pas avec une zone de saisie ; un lien, parce
qu'un clic dessus ne demande rien à Charon. Sans `app/desk/`, cette ancre pointe
vers un 404 — c'est la seule trace à retirer, et `charon-bouton-desk.cjs` la
vérifie (présence, place, `target`, onglet ouvert, et non-débordement de
l'en-tête au téléphone).

Ce qui est repris de Charon, et non recopié :

| Ce que le desk utilise | Où c'est défini |
| --- | --- |
| `WORKING_STATUSES`, `isWorkingStatus`, `showsUnreadCue` | `app/sessionUnread.ts` |
| `PROVIDERS`, `SESSION_PROVIDERS`, `asSessionProvider`, les logos `/agents/*.png` | `lib/sessionCapabilities.ts` |
| `GET /api/claude/sessions`, `GET /api/claude/events` (SSE) | `app/api/claude/**` |
| `setFocus`, `subscribeAll`, `subscribeReconnect` | `lib/client/eventStream.ts` |
| `ClaudeSessionView` — la zone de session et sa barre de fichiers | `app/claude/*` |
| `requireSession()`, la base `vps` / `vps_folders` | `lib/**` |

Conséquence pratique : corriger la zone de session côté Charon corrige le modal
du desk, sans toucher au desk. Les prédicats d'état sont importés, jamais
réécrits — deux définitions de « en cours » finiraient par diverger.

Le desk ne modifie rien : il lit (`sessions`, `events`) et n'écrit que ce que
l'utilisateur lui demande explicitement depuis le modal (mêmes appels que la
page `/`).

## Les fichiers

```
app/desk/
  page.tsx          composant serveur : session, base, premier rendu
  Desk.tsx          la coquille React : sondage, SSE, modal, habillage
                    (le flux porte `status`, `session_unread`, et
                    `session_list_changed` — qui refait la liste aussitôt, sans
                    attendre le sondage des soixante secondes)
  desk.css          l'habillage du desk (le modal réutilise claude.css)
  ui/               SessionModal, StoreModal, Hud, time — le DOM du desk
  hall/             la salle : Three.js, sans React
    world.js        renderer, boucle de rendu, sélection, disposition
    layout.js       où poser chaque chose (baies, quais, postes, armoires)
    hall.js         sol, zones, quais, noms peints, enseigne, lumières
    robots.js       la flotte : une instance par pièce, par état
    store.js        l'armoire d'un quai : le meuble, ses voyants, sa plaque
    palette.js      l'état d'une session → couleur, pose, cadence ; les moteurs
    screens.js      ce que les robots ont à l'écran
    plates.js       le nom d'un robot : la carte posée sur son bureau
    geom.js         la géométrie de chaque pièce (poste, moniteur, armoire)
    canvas.js       les textures peintes : écrans, plaques, noms, logos
    overlay.js      titres de file, bulles, enveloppes (DOM projeté)
    camera.js       caméra libre, bornes de la salle
    env.js          l'environnement cuit qui éclaire les carrures
    vendor/         three.module.js (r160, vendu, pas pris du CDN)
```

`hall/` est du JavaScript, pas du TypeScript : Three.js n'a pas à entrer dans le
typage de Charon et la salle n'a pas à passer par `tsc`. La frontière est
`hall/world.d.ts` — tout ce qui est `.tsx` passe par là. **Ne pas écrire de
syntaxe TypeScript dans `hall/*.js`** : SWC les lit comme du JavaScript et le
build échoue (`Expected ',', got 'as'`).

## La salle

Une **baie** est une allée avec une rangée de quais de chaque côté ; une salle
en compte plusieurs, mises bout à bout. Un **quai** est une machine (un VPS de
Charon) : ses robots éveillés travaillent devant, et derrière les postes il y a
le nom de la machine peint au sol, puis **une armoire** — les robots endormis
n'ont plus de robots du tout. Les **zones** sont les dossiers de Charon : à
l'intérieur d'une zone, les machines suivent l'ordre de la barre latérale de
Charon.

La salle a donc **trois étages**, et chacun vient de Charon : le dossier range
les machines, la machine range ses postes, et le **chemin de travail** range les
robots — et ce troisième étage **branche**.

À l'intérieur d'un quai, les robots qui partagent un `cwd` se tiennent **en file
indienne** : une colonne de postes qui s'enfonce depuis l'allée vers le fond, un
poste tous les `DIMS.postGap` (2 m), chacun sur son socle peint. Un dossier qui
en contient d'autres ne se contente pas d'allonger cette file : il ouvre **un
sol**, une dalle peinte qui porte sa propre file — et dans laquelle les sols de
ses sous-dossiers sont posés côte à côte, **au même niveau**.

Trois robots en `/1/2/3` et un en `/1/2/4` font donc trois sols : `/1/2`, le
tronc, dont la file propre est vide, puis `/1/2/3` et `/1/2/4` dessous, au même
bord avant — l'un de trois postes, l'autre d'un seul. Chaque sol a son nom peint
devant sa file, si bien qu'on lit le chemin **en descendant l'arbre** et jamais
un segment isolé : c'est la hiérarchie qui trie les robots, et un dossier de six
sous-dossiers se lit d'un coup d'œil au lieu de se deviner dans une rangée.

Deux passes font tout le dessin : **`sizeFloor`** mesure de bas en haut — un sol
fait la largeur de sa file plus celle de ses enfants, et la profondeur du plus
profond des deux, c'est-à-dire `max(file, BAND + enfant)` ; **`placeFloor`** pose
de haut en bas — chaque enfant s'ouvre à `BAND` (`FRONT + DESK_BACK`, 1,74 m) du
bord de son parent, donc **derrière la file du parent**, et les frères partagent
le même bord, séparés par `DIMS.floorGap` (0,66 m) ; chaque dalle déborde de
`DIMS.floorPad` (0,32 m) autour de son contenu. Un dossier sans robot à lui et
avec un seul sous-dossier n'a **pas** de sol — sa dalle ne porterait qu'une file
vide et une autre dalle : son nom s'allonge dans celui de son enfant
(`/opt/iron_golem`). Et la salle ne publie qu'une seule liste plate,
`quai.levels` : l'arbre est dans les positions des dalles, pas dans une structure
à parcourir.

La file remplace le placement en rangées, et elle répare ce qu'il cassait : sept
robots du même dossier débordaient sur deux socles, le second sans son nom. Une
file n'a pas de longueur maximale — elle s'allonge vers le fond, et c'est le quai
qui s'agrandit. En échange, un quai profond se lit mal dans l'axe : le premier
robot cache les suivants, et aucune peinture au sol ne rattrape ça. C'est le prix
de la file indienne ; la caméra, elle, est libre, et de trois quarts la colonne
se déplie. L'arbre, lui, se lit **du dessus** : chaque sol est un cadre peint, et
la hiérarchie se voit avant les noms.

Le nom du chemin s'écrit **deux fois**, et jamais les deux ensemble.

**Peint à plat sur le plancher BLEU du quai**, devant sa file (`level.label`) :
c'est la vue du dessus qui le lit, chaque colonne portant son nom à la tête. La
place est choisie, et elle a demandé un déménagement : un poste était posé à
`FRONT` de l'allée, mais son meuble est construit `DESK_Z` (0,72 m) **devant**
cette origine — c'est ce qui laisse au robot la place de s'asseoir derrière son
bureau —, si bien que le meuble finissait à 30 cm du bord et que la bande libre
ne faisait plus la longueur d'un pied. Le poste entier recule donc de
`DESK_BACK` (`= -DESK_Z`) : le bord avant du meuble tombe pile sur `FRONT`, la
bande d'accostage s'ouvre sur `FRONT` (1,02 m) de large, et la plaque s'y pose à
`LANE_LABEL_Z` (`FRONT / 2`, 0,51 m du bord), sa profondeur de toile tenant
entre le liston et le meuble. Rien ne la couvre depuis le dessus : le bureau est
derrière elle, les robots derrière le bureau. Un bureau de 74 cm, en revanche,
cache le plancher sur plus d'un mètre (`0.74 / tan(φ)`) dès qu'on s'éloigne de
la verticale, sans borne quand l'œil descend à hauteur d'homme — d'où la
deuxième écriture.

L'allée, elle, ne porte plus que le nom du **dossier** (à 1,35 m du bord) : un
texte par bande, et chacun à son étage.

**Flottant devant la file**, à `PATH_LEVEL_Y` (1,95 m), à la verticale de la
plaque, et seulement quand l'œil rase la salle (`TITLE_PHI`, phi < 0,4 dans
`world.js` — l'arrivée est à 0,44, elle ne le voit donc pas) : une peinture vue
de l'allée ne fait plus que quelques pixels de haut, et c'est le titre qui prend
alors le relais. Il monte au-dessus des têtes (1,52 m), et il n'a plus à céder à
personne depuis que les noms des robots sont posés sur les bureaux
(`plates.js`) : ses seuls voisins sont les autres titres et l'habillage du bas
(`overlay.js`, `drawPaths`). Le sol, lui, garde ce qu'il fait de mieux : le
socle, ses liserés et son lavis.

Les deux écritures disent la même chose, au tiret et au compte près : la peinture
est nue — quinze chemins tiennent dans la largeur d'une salle —, le titre porte
le compte, comme les titres de la barre latérale de Charon. Un chemin trop long
perd ses premiers segments, jamais son dernier, et l'ellipse qui reste
(`…/charon`) dit que le nom est tronqué — `/charon` aurait annoncé une racine qui
n'est pas la sienne.

Le regroupement n'est pas décidé ici : `layout.js` importe `sidebarPathKey` et
s'en sert comme clé, exactement comme la barre latérale. Deux robots que Charon
range sous le même titre sont dans la même file, dans le même ordre — et si
Charon change d'avis sur ce qu'est « le même dossier », la salle change d'avis
avec lui. Un chemin ne se coupe jamais en deux files, et un sous-dossier ne se
mêle jamais à la file de son parent : il n'y a plus de longueur à tenir, il n'y a
qu'une place à prendre — à côté de ses frères pour un sol, sous son parent pour
un dossier.

**Une machine sans aucun agent éveillé ne descend pas dans la salle** : ni
quai, ni armoire, ni nom. Ses robots endormis ne se montrent que si la machine
a au moins un agent au travail — une case vide n'apprend rien, et la salle se
resserre toute seule quand la flotte se rendort. Le compte est dans
l'habillage : « 25 machines · 4 on the floor ». Le filtre est dans `layout.js`
(`measure(...).awake.length`), pas dans `world.js` : une machine écartée ne
doit pas exister du tout, pas être dessinée puis masquée.

### L'armoire

Un robot endormi n'est **pas** dans la salle : le dessiner aurait dit « me
voici » pour des sessions que personne n'a ouvertes depuis des heures, et une
allée de robots immobiles noie ceux qui bougent. Une machine n'a donc, au fond
de son quai, qu'**une armoire de stockage** (`store.js`) : un meuble, ses
voyants — l'équivalent des alvéoles, un par famille de moteur présent — et une
plaque qui annonce le compte (« 35 » / « asleep ») et le nom de la machine.

Un clic sur l'armoire ouvre la **liste** de ses endormis (`ui/StoreModal.tsx`),
et chaque ligne de cette liste ouvre la session exactement comme le ferait un
clic sur un robot : le même `SessionModal`, avec la liste derrière qui reprend
la main à la fermeture. Le modal de session se pose au-dessus (`covered`), et
l'armoire cesse alors d'écouter Échap et les clics — un seul modal actif à la
fois, mais deux profondeurs. Échap ferme le modal de session, sauf si le
composer porte un brouillon : fermer l'emporterait, et le composer d'une session
ouverte a le focus, donc la règle « Échap dans un champ annule la frappe » le
rendait inopérant.

La liste est rangée **par chemin**, comme la salle l'est par file, et le
rangement est le même code : `ui/StoreModal.tsx` importe `sidebarPathOrderedIds`
et `sidebarPathKey` de `app/sidebarPathGroups.ts` — le fichier qui décide déjà,
côté Charon, de l'ordre des cartes d'une barre latérale groupée par chemin. Le
style non plus n'est pas réécrit : les titres de groupe sont les classes
`.cs-path-group` / `.cs-path-head` de `claude.css`, que la page du desk importe
déjà. Seule la taille du titre est relevée (`desk.css`), parce qu'il a été écrit
pour une colonne de 260 px et que le modal en fait 1080. Un titre se replie au
clic, comme dans la barre latérale.

L'armoire se ramasse au **rayon** (`world.js:pickStore`, via
`THREE.Raycaster`) et non par projection d'ancre comme les robots : un meuble
de deux mètres de haut sur trois de large n'a pas de tête à viser, et viser son
centre est plus sûr que viser son étiquette. Le survol allume un anneau au sol,
comme pour un robot.

Le robot passe **avant** l'armoire dans `_click` : là où une file couvre le
placard, c'est le robot qu'on voit, et c'est donc lui qu'on ouvre. Le meuble fait
2,05 m et les robots 1,5 m : sa moitié haute dépasse toujours des têtes, et c'est
là qu'on le vise — `desk-clicarmoire.cjs` échantillonne sa face pour vérifier
qu'il reste des points où le clic ouvre bien l'armoire, et non un robot ou rien.

Ajouter un élément à la salle :

1. la place se décide dans `layout.js` — jamais dans `world.js` ;
2. la géométrie se construit dans `hall.js` (décor, une fois) ou `robots.js`
   (flotte, en `InstancedMesh`, une instance par robot et par pièce) ;
3. la couleur et la cadence viennent de `palette.js`, qui importe les règles de
   Charon. Si une couleur est écrite en dur ailleurs, c'est un bug ;
4. l'état d'un robot vient du **modèle**, jamais du plan. `layout.js` dit où
   l'on se tient (`desks[].session` n'y est qu'un identifiant et une place) ;
   `model.sessions` dit ce qu'on fait. La salle n'est rebâtie que si sa forme a
   bougé — ouvrir, endormir, changer de quai —, et `Fleet.update` relit donc
   chaque session dans le modèle vivant (`robots.js`). Lire l'objet gardé dans
   le plan figeait l'état : un robot finissait son tour et restait bleu
   jusqu'à la reconstruction suivante, alors que la barre latérale, elle,
   l'affichait vert depuis longtemps. Le plan ne dit pas l'état, il dit où l'on
   se tient.

## Ce qui se lit dans la salle, et dans quel ordre

1. **la couleur qui bat** : bleu, le tour est en cours ; orange, une question
   attend ; vert, un tour fini que personne n'a lu ; gris, rien à signaler ;
   rouge, en panne ; bleu sombre, en veille. Ce n'est pas l'étiquette qui bat,
   c'est **le robot entier** : sa carrure prend la couleur de son état et
   s'allume avec elle. Une session en veille est éteinte et fixe : dans une
   salle sombre, ce qui bouge est ce qui vous veut ;
2. **le nom du robot**, sur son bureau — une carte inclinée à 45° posée derrière
   le moniteur (`plates.js`), tournée vers l'allée : c'est de là qu'elle se lit,
   et du dessus. Le nom y prend **toute la carte** : `nameSize` mesure le mot à
   une taille de référence et résout la plus grande taille qui tienne dans la
   toile, moins les marges, puis le trait est **épaissi** en repassant le texte
   au pinceau (`strokeText`, `WEIGHT` = 0,09 de la taille) — un glyphe plein,
   pas une ligne. Mesuré sur la toile projetée, du côté vers lequel la carte est
   tournée : **49 px par caractère** à deux mètres et demi, 29 du dessus à
   quatre mètres et demi — c'est la première chose qu'on lit en arrivant à un
   poste, et la dernière qu'on quitte. Elle ne se lit **pas** du fond de la
   salle : à quinze mètres, les mêmes lettres font 8 px, il n'en reste qu'une
   trace — le double d'avant, pas encore un mot. Ce qui reste alors de chaque
   robot, c'est la carte elle-même : son champ est blanc, donc la matière la
   teint exactement de la couleur de l'état — de loin, chaque poste porte la
   pastille de couleur de la barre latérale, et le nom se relit sur l'écran du
   robot, qui, lui, garde sa taille. Les endormis n'ont **pas** de nom : ils
   n'ont plus de robot ;
   Et pour le robot qu'on **désigne** — le geste le plus direct, et celui qui
   porte le plus loin —, il y a une troisième écriture, en DOM par-dessus la
   scène (`overlay.js:drawHover`) : la souris s'arrête sur un robot, son nom et
   son chemin apparaissent juste au-dessus de sa tête, dans la couleur de son
   état. C'est la seule qui reste nette à toute distance, parce qu'elle n'est
   pas peinte dans la salle ;
3. **le sigle du moteur**, sur l'écran de son poste — le logo que publie
   Charon (`/agents/claude.png`, `codex.png`, `cursor.png`), sur une plaque
   claire, à un mètre quatre-vingts d'un œil qui arrive par l'allée. Le fond de
   l'écran est tourné vers le robot, donc c'est le **dos** du moniteur que
   l'allée voit : la marque y est peinte aussi (`deskTagGeometry`), inclinée
   comme la dalle, à quatre millimètres d'elle. C'est ce qui donne le moteur
   « même de loin », avant qu'on distingue autre chose ;
4. **la pose** : debout, assis, main levée ;
5. **le chemin de travail**, devant chaque sol, sur la dalle de ce sol : c'est
   ce qui dit *où* travaille le robot qu'on regarde. C'est le seul texte de la
   salle qui nomme un groupe et non une personne, et le seul dont le contenu
   vienne d'un `cwd`. Peint à plat tant que l'œil domine la salle, flottant
   au-dessus de la dalle quand il la rase — mono 12 px, encre claire sur une
   plaque sombre, une barre d'accent pour marque, le compte en bout de ligne.
   Son compte est celui du sol **et de ce qu'il contient**, comme le titre de la
   barre latérale : `/srv [1/16]` annonce seize robots alors qu'un seul y a son
   poste ;
6. **le nom de la machine**, peint au sol **derrière les postes** — là où le
   visiteur qui longe l'allée le lit sans avoir à entrer dans le quai, et là où
   dormaient les robots ;
7. **le nom du dossier**, peint dans l'allée, au pied de sa rangée — plus loin
   du quai que celui des chemins, qui ne font que passer devant lui ;
8. **le liston du quai** — la bande colorée à son bord —, qui dit ce que la
   machine réclame avant même qu'on distingue un robot.

Il n'y a **ni plaque ni panneau** devant les quais : une forêt de panneaux
finissait par masquer les robots qu'on venait voir, et redisait ce que le sol
dit déjà. Le nom de la machine est peint sur son plancher, derrière les postes,
et la seule chose qui se dresse par-dessus les bureaux est l'armoire.

**Le nom est ce qu'on clique**, et il l'est resté en changeant de nature : c'est
maintenant une plaque dans la scène (`plates.js`), et `world.js:pick` la vise au
**rayon**, comme l'armoire (`_ray` sert aux deux), **avant** la recherche par
proximité. La plaque est DEVANT son robot : quand les deux se recouvrent à
l'écran, c'est elle qu'on a cliquée, et c'est le robot qu'elle nomme qu'on
ouvre. La proximité reste le second filet — viser le robot lui-même, au corps, à
46 px de sa tête.

Un robot debout a **toujours** sa plaque : une par robot dans la salle, sans
plafond de distance ni de nombre, et une toile par robot — le nom seul décide
d'un repeint, la couleur est portée par la matière (`material.color`), parce
qu'une carte repeinte à chaque battement serait une texture téléversée soixante
fois par seconde et par robot. La toile est **blanche** et le nom y est à
l'encre : c'est ce qui permet à la matière de la teindre exactement de la
couleur de l'état, et à la carte de battre sans jamais blanchir — le gain de la
plaque est borné à 1, celui du robot monte à 1,3, donc le robot pulse et la
plaque dit la couleur. Une session qui s'endort rend sa plaque au pool : la
salle ne téléverse jamais plus de toiles qu'elle ne compte de robots debout.
Une plaque est gardée par identifiant de session, pas par rang : endormir un
robot ne repeint pas les plaques de tous ceux qui le suivaient dans la file.

Ce que la plaque coûte, et qu'il faut savoir avant de la déplacer : elle
**s'occulte** comme un objet de la salle — un poste cache la plaque du poste de
derrière —, là où une étiquette en DOM passait toujours au-dessus. C'est le prix
d'un nom qui appartient à un lieu : il se lit à sa place.

L'habillage compte comme un obstacle, lui aussi : `world.js` mesure à chaque
image ce que le HUD occupe **en bas de l'écran** (`.dsk-hint`, la barre d'aide)
et le pose dans `placed` avant les titres. Un titre ne sait s'écarter que vers le
haut : cela tombe bien pour ce qui traîne au sol de l'écran, cela tomberait mal
pour ce qui est posé en haut — un titre sous la carte des compteurs ne
remonterait que pour sortir du cadre, et un titre à moitié couvert vaut mieux
qu'un titre absent. Seul le bas est donc déclaré.

Un titre de file ne monte que pour se dégager d'un **autre titre** — deux files
voisines se chevauchent quand la salle est vue de loin —, d'un cran ou deux, et
sans quitter sa colonne : un titre qui part à l'horizontale ne désignerait plus
sa file. Son opacité, elle, a un plancher (0,8) : un titre du fond de la salle se
lit, il ne se devine pas.

Un clic sur un robot **n'ouvre que sa session** : la caméra ne bouge pas.
Vouloir lire une session n'est pas vouloir se coller au robot, et la salle doit
être exactement là où on l'avait laissée quand le modal se referme.

Les textes peints au sol se retournent face au visiteur (`hall.faceCamera`) :
peints, ils ne se liraient que d'un côté, et la caméra est libre.

Tout le texte visible est en anglais — habillage, légende, aide, écrans des
robots, noms peints au sol, horodatages relatifs (`canvas.js:ago`). Les propos
des sessions, eux, viennent de Charon : le desk ne les traduit pas.

**La légende est repliée au départ.** Elle fait 330 × 400 px : dépliée, elle
couvre le tiers gauche de l'écran, c'est-à-dire le quai le plus peuplé, ses
titres de file et les noms de ses robots. Son titre est un bouton
(`.dsk-legend-head`), son état vit dans `localStorage` (`desk.legend`), et rien
n'est perdu : la légende se déplie au clic, et l'aide la rappelle.

## Vérifier

Les scripts de contrôle sont dans `/tmp/poccheck/` : `desk-live.cjs` (connexion,
`/desk`, survol, clic, modal, Échap), `desk-probe.cjs`, `desk-views.cjs` et
`desk-store.cjs` (six points de vue de la salle), **`desk-arbre.cjs` (le test
d'acceptation de l'arbre** : l'arbre est reconstitué par les préfixes de chemins
à partir de `window.desk`, puis chaque dalle doit contenir ses enfants, chaque
fratrie doit partager le même bord avant, et chaque robot doit tomber dans la
dalle de son propre `cwd` — la sonde finit par le survol, et refuse de conclure
si le nom n'est pas venu), `desk-plaque.cjs` (la lisibilité du nom : pixels par
caractère sur la toile projetée, de l'allée, du dessus et du fond de la salle),
`desk-niveaux.cjs` (le sous-niveau par chemin : regroupement recalculé à partir
de `window.desk`, alignement des postes d'une file et leur écart, titres, puis le
placard), `desk-files.cjs` (la file en quatre images : arrivée,
allée dans l'axe, trois quarts, dessus), `desk-pathvisible.cjs` (**le test
d'acceptation du titre de file** : depuis l'allée, à hauteur d'œil, chaque
sous-niveau du quai le plus fourni doit porter un titre dans le cadre, sans
recouvrement), `desk-titres-rect.cjs` et `desk-titres-gene.cjs` (ce qui passe
encore devant un titre : bord du cadre, légende, barre d'aide), `desk-legende.cjs`
(la légende se replie et s'en souvient), `desk-travees.cjs` et `desk-label.cjs`
(la file vue de près), `desk-clic.cjs` (**ce qui tombe sous le curseur** : pour
chaque plaque de la salle, ce qu'ouvre un clic sur la carte — centre, haut, bas —
et sur la tête du robot qu'elle nomme, et sur quoi tombe un clic juste sous la
carte), `desk-clicarmoire.cjs` (le
placard reste cliquable derrière ses files : sa face est échantillonnée, et
chaque point est classé « armoire », « robot devant » ou « rien »),
`desk-echap.cjs` (Échap ferme, sauf sur un brouillon),
`desk-vert4.cjs` et `desk-vert-shot.cjs` (une session témoin finit son tour :
la salle doit la passer en `unread` — voyant vert qui bat —, et tant la couleur
d'instance de son torse que celle de sa plaque de nom, relevées sur un cycle
entier, doivent rester vertes).
`window.desk` (le monde) et `window.desk.controller` (la caméra) sont exposés
pour ça.

Trois pièges à connaître en écrivant une sonde. `focusOn` force la cible à
1,10 m au-dessus du plancher (`camera.js:127`) : pour viser autre chose, piloter
`controller.wanted` / `wantedRadius` / `wantedPhi` / `wantedTheta` directement.
Le `Pool` d'`overlay.js` rend ses éléments avec `display:none` plutôt que de
les retirer du DOM : une sonde qui compte `document.querySelectorAll('.dsk-path')`
compte aussi les rendus, qui mesurent zéro — filtrer sur `offsetParent`.
Et pour le survol, il faut viser **l'ancre elle-même** (`entry.anchor.clone()
.project(camera)`) : `world.js:pick` projette cette ancre — la tête, à 1,52 m — et
compare le curseur à moins de 46 px d'elle. Viser « la tête plus haut » a toutes
les apparences du survol et le comportement d'un raté ; et comme la boîte garde
son contenu d'un essai à l'autre, un `display:none` avec le bon texte ne prouve
rien — c'est `window.desk.hoveredId` qu'il faut lire.

`npm run build` puis attendre le redémarrage du service : le déploiement est
automatique (`charon-autodeploy.path`).
