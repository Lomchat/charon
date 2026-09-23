// Où poser chaque chose.
//
// La salle est faite de BAIES : une baie, c'est une longueur d'allée avec deux
// rangées de quais qui se font face. Un quai = un VPS, avec devant lui les
// postes de travail des robots éveillés, puis, au fond, le nom de la machine
// peint sur le plancher et le placard où dorment ses robots.
//
// Un quai a trois étages, et c'est le troisième qui donne son nom au plan :
//   — le DOSSIER de Charon, peint dans l'allée, qui range les machines ;
//   — la MACHINE, dont le nom est peint derrière ses postes ;
//   — le CHEMIN de travail — le `cwd` d'une session, et son ARBRE. Les robots
//     d'un même chemin se tiennent ensemble, sur un même sol peint au sol,
//     séparés du sol voisin par un vide ; et les chemins qui commencent par le
//     même dossier se tiennent DANS le sol de ce dossier, côte à côte, à la
//     même profondeur. Un chemin est donc un sol, un sol peut en contenir
//     d'autres, et la salle se lit comme la hiérarchie qu'elle représente :
//     `/srv/charon` et `/srv/mpg` sont deux dalles dans la dalle `/srv`.
//
//     Ce qui décide de tout : un niveau qui n'a rien à lui et un seul enfant
//     n'a pas de sol — ce serait un couloir vide entre deux pièces. Il se fond
//     dans celui de son enfant et son nom s'allonge : `/opt` n'a qu'un
//     sous-dossier, et c'est `/opt/iron_golem` qu'on lit par terre.
//
//     La clé de regroupement est celle de Charon : `sidebarPathKey`, la même
//     que sa barre latérale utilise pour ranger ses cartes. Deux robots que
//     Charon montre sous le même titre sont ici sur le même sol, dans le même
//     ordre, sous la même hiérarchie.
//
// Pourquoi des baies, et pas une seule grande allée ? Parce qu'une flotte réelle
// ne tient pas dans un couloir. À vingt-cinq machines, l'allée unique mesurait
// cent soixante-treize unités : à cette distance un robot fait trois pixels, et
// un nom au-dessus de sa tête est illisible. On plie donc la salle — six ou
// sept machines, puis on tourne — pour obtenir une pièce qu'on embrasse d'un
// regard au lieu d'un hangar qu'on survole.
//
// Les rangées ne sont pas découpées au hasard : les dossiers de Charon
// (`vps_folders`, ceux de sa barre latérale) sont les ZONES de la salle. Un
// dossier occupe une rangée — ou plusieurs, s'il déborde —, ses machines s'y
// suivent dans l'ordre où Charon les montre, et le nom du dossier est peint au
// sol devant la rangée. La salle se lit donc exactement comme la liste qu'elle
// représente.
//
// Une machine qui n'a AUCUN agent éveillé ne descend pas dans la salle : c'est
// une case vide, et une case vide n'apprend rien à personne. Ses robots
// endormis restent joignables — dans le placard de leur quai — tant que la
// machine a au moins un agent au travail. La salle ne montre donc que ce qui
// travaille, et son plan se resserre tout seul quand la flotte se rendort.

import { sidebarPathKey } from '@/app/sidebarPathGroups';

export const DIMS = {
	desk: { w: 1.75, d: 1.15, h: 0.74 },
	deskGapX: 0.6,      // marge de plancher au bout d'une file
	floorGap: 0.66,     // le vide entre deux SOLS frères
	floorPad: 0.32,     // la marge de plancher d'un sol autour de son contenu
	postGap: 2,         // d'un poste au suivant, DANS une file
	aisle: 5.2,         // largeur de l'allée, entre deux rangées face à face
	quaiGap: 3.4,       // entre deux quais d'une même rangée
	quaiLift: 0.14,     // hauteur du plancher du quai
	store: { d: 0.68, h: 2.05, door: 0.62 }  // le placard de stockage du fond
};

/** Les dimensions d'une baie.
 *
 *  `span` est la longueur d'une rangée : au-delà, on ouvre la baie suivante.
 *  C'est le seul réglage qui décide de la forme de la salle — trop court, on
 *  obtient une grille de petits couloirs, trop long, on retombe sur le hangar.
 *  À cette valeur, une baie se regarde entière depuis l'entrée et les noms y
 *  restent lisibles. */
export const BAY = { span: 62, gap: 9 };

/** Position du plateau dans le repère du poste (x vers la droite, z en
 *  s'éloignant de l'allée). */
export const DESK_Z = -0.72;

/** Ce qu'il faut reculer un poste pour que son meuble retombe sur le bord de
 *  l'allée.
 *
 *  L'origine d'un poste — la selle du robot — est posée à `FRONT + desk.d / 2`
 *  de l'allée, mais son meuble est dessiné `DESK_Z` DEVANT cette origine : le
 *  plateau occupait donc la bande de plancher libre et ne laissait au bord du
 *  quai que trente centimètres, de quoi poser un pied, pas un nom. Le poste
 *  entier — meuble, selle, robot — recule d'autant, ce qui remet le bord avant
 *  du meuble pile sur `FRONT` et ouvre la bande d'accostage sur toute sa
 *  largeur. L'ordre de la salle, lui, ne change pas d'un centimètre : le robot
 *  est toujours assis derrière son bureau, à la même distance de son écran. */
export const DESK_BACK = -DESK_Z;

/** Bande libre au bord de l'allée, sur le quai, avant le premier meuble.
 *
 *  C'est la zone d'accostage : on arrive de l'allée, on traverse cette bande,
 *  et on trouve le premier rang de postes. Elle porte deux choses et pas une de
 *  plus : le nom du CHEMIN, peint à plat devant sa file (`LANE_LABEL_Z`), et
 *  rien d'autre — le NOM de la machine, lui, est passé DERRIÈRE les postes, à
 *  la place qu'occupaient les robots endormis, pour que le quai se lise dans
 *  l'ordre où il se vit : l'allée nomme le dossier, le bord du quai nomme le
 *  chemin, le fond nomme la machine. */
export const FRONT = 1.02;

/** La bande d'accostage d'un SOL — et un sol, ici, n'est pas forcément le quai :
 *  c'est la dalle peinte d'un dossier, à quelque profondeur qu'elle soit.
 *
 *  Au premier niveau, c'est la bande du quai : celle que les postes ont libérée
 *  en reculant (`DESK_BACK`), le long de l'allée. Aux niveaux suivants, c'est la
 *  même : un sous-dossier a son propre bord, on y entre depuis le sol de son
 *  dossier, et son nom s'y peint comme celui du quai se peint au bord de
 *  l'allée. Un sol se lit donc toujours pareil, à toute profondeur — sa bande
 *  nue, son nom dessus, ses postes derrière. */
export const BAND = FRONT + DESK_BACK;

/** La largeur maximale d'un nom peint au sol. Un dossier qui en range six
 *  autres nomme une travée, pas une colonne : sa plaque s'élargit avec ce
 *  qu'elle couvre — mais pas indéfiniment, sinon un nom court y flotterait seul
 *  au milieu du vide. */
export const LABEL_MAX = 3.4;

/** Le nom peint au sol est une toile très large et basse (voir `hall.js`) :
 *  sa profondeur découle de sa largeur. La place réservée au sol doit
 *  connaître ce rapport, sinon le placard du fond mordrait sur le nom. */
export const NAME_RATIO = 256 / 2048;

/** Le nom d'un chemin, peint à plat sur le plancher du quai, devant sa file.
 *
 *  À mi-bande d'accostage : la plaque a la profondeur de sa toile (environ un
 *  tiers et demi de sa largeur) et le meuble commence juste derrière elle. Rien
 *  ne la couvre — ni le bureau, qui est plus loin, ni les robots, qui sont
 *  derrière leur bureau, ni un titre, qui ne s'allume qu'à ras du sol —, et
 *  c'est elle que la vue du dessus lit.
 *
 *  Sa largeur est celle du socle qu'il nomme : le nom, la file et les robots
 *  font une seule colonne, ce qui est exactement ce qu'une vue du dessus lit.
 *  Sa toile (voir `hall.js`) est environ trois fois et demie plus large que
 *  haute. */
export const LANE_LABEL_Z = FRONT * 0.5;
export const LANE_RATIO = 288 / 1024;

/** L'altitude du titre d'un chemin : au-dessus du premier poste de sa file.
 *
 *  C'est la seconde écriture du nom — la première est peinte à plat sur le
 *  plancher du quai (`LANE_LABEL_Z`), et c'est elle que la vue du dessus lit.
 *  Celle-ci ne sert qu'aux yeux qui rasent la salle, là où la peinture ne fait
 *  plus que quelques pixels : une peinture au sol vue de l'allée est écrasée
 *  par la perspective, et un bureau de 74 cm cache le plancher sur plus d'un
 *  mètre derrière lui. Le titre se pose donc AU-DESSUS des noms de robots
 *  (1,52 m, voir `robots.js`) : les deux se partagent le ciel de la salle, le
 *  nom du robot monte d'un cran quand un titre lui barre la route, et le titre
 *  ne cède jamais à un nom — il ne monte que pour se dégager d'un autre titre,
 *  d'un cran ou deux, en gardant sa colonne : il reste au-dessus de sa file, à
 *  la verticale de la plaque qu'il double. */
export const PATH_LEVEL_Y = 1.95;

/* ------------------------------------------------------------ l'arbre */

/** Les segments d'un chemin de Charon. `~` et `/` sont des chemins à part
 *  entière — le dossier de travail vide et la racine —, les autres se coupent
 *  sur la barre oblique. */
function segmentsOf(path) {
	const clean = String(path ?? '').trim();
	if (!clean || clean === '~') return ['~'];
	if (clean === '/') return ['/'];
	return clean.split('/').filter(Boolean);
}

/** Le chemin d'un enfant, recollé : `/srv` + `charon` font `/srv/charon`. */
function joinPath(parent, name) {
	if (parent === '') return name === '~' || name === '/' ? name : `/${name}`;
	if (parent === '/') return `/${name}`;
	return `${parent}/${name}`;
}

/** L'arbre des chemins d'un quai.
 *
 *  La racine est VIRTUELLE : une machine n'est pas un dossier, elle se contente
 *  de porter des chemins, et ceux-ci n'ont pas forcément de racine commune —
 *  `/srv/charon` et `/var/www/html` se tiennent côte à côte sur le même quai
 *  sans que rien les range l'un sous l'autre. Ce sont donc ses enfants, et eux
 *  seuls, qui descendent dans la salle.
 *
 *  L'ordre est celui de Charon : un nœud naît de la première session qui le
 *  traverse, et ses enfants se rangent dans l'ordre où ils apparaissent. La
 *  salle se lit donc comme la barre latérale — hiérarchie comprise. La clé d'un
 *  chemin est `sidebarPathKey`, la sienne : le desk ne réinvente pas ce qu'est
 *  « le même dossier », il le lui demande. */
function pathTree(awake) {
	const root = { path: '', name: '', kids: [], children: new Map(), sessions: [] };
	for (const session of awake) {
		let node = root;
		for (const name of segmentsOf(sidebarPathKey(session.cwd))) {
			let child = node.children.get(name);
			if (!child) {
				child = {
					path: joinPath(node.path, name), name,
					kids: [], children: new Map(), sessions: []
				};
				node.children.set(name, child);
				node.kids.push(child);
			}
			node = child;
		}
		node.sessions.push(session);
	}
	return root;
}

/** Le SOL d'un nœud : ce qui est peint au sol, nommé, et porte des postes.
 *
 *  Un nœud qui n'a aucun robot à lui et un seul enfant n'est pas un sol : ce
 *  serait un couloir vide entre deux pièces, avec un nom peint par terre et
 *  personne dessus. Il se fond donc dans le sol de son enfant, et son nom
 *  s'allonge avec lui — `/opt` n'a qu'un sous-dossier, `/opt/iron_golem`, et
 *  c'est ce nom-là qu'on lit par terre. Le repli s'arrête au premier nœud qui a
 *  des robots à lui, ou plusieurs enfants : c'est là qu'il y a quelque chose à
 *  séparer, donc des sols distincts. */
function floorOf(node) {
	let path = node.path;
	let here = node;
	while (!here.sessions.length && here.kids.length === 1) {
		here = here.kids[0];
		path = here.path;
	}
	return { path, own: here.sessions, kids: here.kids };
}

/** Ce qu'un sol occupe, calculé de proche en proche.
 *
 *  Un sol réunit deux choses, côte à côte : SA file — les robots de son propre
 *  dossier, bout à bout depuis sa bande d'accostage, comme avant — puis les
 *  sols de ses sous-dossiers. Les frères sont à la même profondeur : sous
 *  `/srv`, `/charon` et `/mpg` commencent au même bord, et c'est le sol qui
 *  s'élargit pour les tenir tous, non les uns derrière les autres. Sa
 *  profondeur, elle, est celle du plus profond de ses enfants — un sous-dossier
 *  s'enfonce, il ne pousse pas ses frères.
 *
 *  C'est ce qui fait de la salle un ARBRE : on lit une profondeur en descendant
 *  un chemin, une largeur en parcourant ses voisins, et jamais l'inverse. */
function sizeFloor(plan) {
	// Chaque enfant est un nœud de l'arbre : il se replie à son tour (`floorOf`)
	// avant d'être mesuré — un sous-dossier sans robot à lui et d'un seul petit
	// enfant n'aura pas de dalle non plus.
	const kids = plan.kids.map((node) => sizeFloor(floorOf(node)));
	const count = plan.own.length;
	// Le bout de sa propre file : le socle s'arrête 15 cm après la selle du
	// dernier robot, et la file part de `FRONT` — son premier meuble au bord de
	// sa bande d'accostage, règle inchangée depuis le premier jour.
	const ownFar = count
		? FRONT + DESK_BACK + (count - 1) * DIMS.postGap + DIMS.desk.d + 0.15
		: 0;
	const kidsW = kids.length
		? kids.reduce((sum, kid) => sum + kid.w, 0) + (kids.length - 1) * DIMS.floorGap
		: 0;
	const kidsFar = kids.length ? BAND + Math.max(...kids.map((kid) => kid.d)) : 0;
	const contentW = (count ? DIMS.desk.w : 0) + (count && kidsW ? DIMS.floorGap : 0) + kidsW;
	return {
		plan,
		kids,
		count,
		w: Math.max(contentW, count ? DIMS.desk.w + 0.36 : 0) + 2 * DIMS.floorPad,
		d: Math.max(ownFar, kidsFar) + DIMS.floorPad,
		total: count + kids.reduce((sum, kid) => sum + kid.total, 0)
	};
}

/** Pose un sol : son nom peint, sa file, et les sols de ses sous-dossiers.
 *
 *  `x0` est le bord gauche de sa dalle, `z0` son bord d'accostage, tous deux
 *  dans le repère du quai (x vers la droite, z s'enfonçant depuis l'allée — `at`
 *  rabat le second sur le côté de la rangée). La récursion descend l'arbre :
 *  chaque sous-dossier se pose SUR le sol de son parent, à `BAND` de son bord,
 *  et les frères commencent tous au même — c'est la largeur du sol qui grandit
 *  avec eux, jamais la profondeur de ses voisins. Un sol contient des sols, et
 *  la salle se lit comme l'arbre des chemins. */
function placeFloor(sized, x0, z0, ctx) {
	const { quai, at, levels, dir } = ctx;
	const count = sized.count;
	const centre = at(x0 + sized.w / 2, z0 + sized.d / 2);
	const spot = at(x0 + sized.w / 2, z0 + LANE_LABEL_Z);
	// Le nom du dossier est PEINT À PLAT dans sa propre bande d'accostage, devant
	// ses postes — la première écriture, et celle que la vue du dessus lit. Sa
	// plaque s'élargit avec ce qu'elle couvre : un dossier qui en range six
	// autres nomme une travée, pas une colonne. Le titre flottant, lui, ne sert
	// qu'aux yeux qui rasent la salle (`world.js`), et se tient à sa verticale.
	const labelW = Math.min(sized.w - 0.3, LABEL_MAX);
	levels.push({
		path: sized.plan.path,
		sessions: sized.plan.own,
		own: count,
		count: sized.total,
		lane: levels.length,
		x: centre.x,
		z: centre.z,
		w: sized.w,
		d: sized.d,
		title: { x: spot.x, z: spot.z },
		label: { x: spot.x, z: spot.z, w: labelW, d: labelW * LANE_RATIO, base: dir > 0 ? Math.PI : 0 }
	});

	// Sa file à lui : les robots de son dossier, en file indienne depuis sa
	// bande — le premier au bord, le nom devant lui, le dernier au fond.
	const laneX = x0 + DIMS.floorPad + DIMS.desk.w / 2;
	for (let k = 0; k < sized.plan.own.length; k++) {
		const localZ = z0 + FRONT + DESK_BACK + DIMS.desk.d / 2 + k * DIMS.postGap;
		const seat = at(laneX, localZ);
		quai.desks.push({
			session: sized.plan.own[k],
			quai,
			x: seat.x,
			z: seat.z,
			yaw: quai.side < 0 ? Math.PI : 0,
			localX: laneX,
			localZ
		});
	}

	// Puis ses sous-dossiers, à sa droite. Un dossier sans robots à lui ouvre
	// directement sur ses enfants : sa file n'occupe aucune colonne.
	let x = x0 + DIMS.floorPad + (count ? DIMS.desk.w + DIMS.floorGap : 0);
	for (const kid of sized.kids) {
		placeFloor(kid, x, z0 + BAND, ctx);
		x += kid.w + DIMS.floorGap;
	}
}

/** La largeur du placard, pour `n` robots endormis : une porte de plus tous
 *  les huit — une armoire dit « il y a du monde là-dedans », c'est la porte
 *  qu'on ouvre, pas le compte exact qui est peint dessus. */
function storeWidth(count, width) {
	const doors = Math.min(6, Math.max(2, Math.ceil(count / 8)));
	return Math.min(width - 0.3, Math.max(1.9, doors * DIMS.store.door));
}

/** Ce qu'une machine réclame comme place, calculé avant de la poser.
 *
 *  `lanes` est le plan des sous-niveaux : une file par chemin. C'est la même
 *  liste qui décide de la largeur du quai et de la place de chaque poste — le
 *  plan est calculé une fois, et relu tel quel par la passe qui pose les robots.
 *  La largeur vient du nombre de chemins, la profondeur du plus long d'entre
 *  eux : un quai de sept chemins courts est large et plat, un quai d'un seul
 *  chemin de quatre robots est étroit et profond. */
function measure(sessions) {
	const awake = sessions.filter((s) => String(s.liveStatus ?? s.status) !== 'sleeping');
	const asleep = sessions.filter((s) => String(s.liveStatus ?? s.status) === 'sleeping');

	// Les sols du quai : l'arbre des chemins de ses robots éveillés, replié
	// (`floorOf`) puis mesuré de proche en proche (`sizeFloor`). Les premiers
	// sont ses travées ; les suivants vivent DANS celles-là.
	const floors = pathTree(awake).kids.map(floorOf).map(sizeFloor);
	const contentW = floors.length
		? floors.reduce((sum, floor) => sum + floor.w, 0) + (floors.length - 1) * DIMS.floorGap
		: 0;
	const deep = Math.max(1, ...floors.map((floor) => floor.count));
	const far = Math.max(0, ...floors.map((floor) => floor.d));
	const width = Math.max(contentW + 2 * DIMS.deskGapX, 4.2);

	// Derrière le poste le plus profond : le nom peint, puis le placard. Le nom
	// garde son sol libre devant lui — c'est ce qui le rend lisible depuis
	// l'allée, par-dessus les épaules des robots assis. `DESK_BACK` entre dans
	// la mesure : le dernier objet d'une file n'est pas son meuble mais la selle
	// de son robot, qui a reculé avec le reste du poste.
	const nameW = Math.min(6.8, width - 0.5);
	const nameD = nameW * NAME_RATIO;
	const nameZ = far + 0.55 + nameD / 2;
	const store = asleep.length
		? storeWidth(asleep.length, width)
		: 0;
	const storeZ = nameZ + nameD / 2 + (store ? 0.75 + DIMS.store.d / 2 : 0);
	const depth = storeZ + (store ? DIMS.store.d / 2 : 0) + 0.9;

	return { awake, asleep, floors, contentW, deep, far, width, nameW, nameD, nameZ, store, storeZ, depth };
}

/**
 * Répartit les quais et calcule la place de chaque robot.
 *
 * `fleet` = { sessions: SessionListItem[], vps: Vps[], folders: VpsFolder[] }.
 * Renvoie aussi les machines restées dehors (aucun agent éveillé), les zones
 * et les bornes du hall — la caméra en a besoin pour ne pas sortir de la salle.
 */
export function computeLayout(fleet) {
	const sessionsOf = (vpsId) => fleet.sessions.filter((s) => s.vpsId === vpsId);

	// Les dossiers dans l'ordre de Charon, puis les machines dans l'ordre de
	// Charon À L'INTÉRIEUR de chaque dossier. On ne retrie rien : la position
	// d'un quai dans la salle est celle de sa ligne dans la barre latérale.
	const folders = fleet.folders?.length
		? fleet.folders
		: [{ id: 'default', name: 'Sans dossier' }];
	const byFolder = new Map(folders.map((f) => [f.id, []]));
	const orphans = [];
	for (const vps of fleet.vps) {
		const bucket = byFolder.get(vps.folderId);
		if (bucket) bucket.push(vps);
		else orphans.push(vps);
	}
	if (orphans.length) byFolder.get(folders[0].id).push(...orphans);

	/* ---------------------------------------------------------- les rangées */

	// Une rangée = un côté d'une baie. On les crée à la demande, dans l'ordre
	// où on les parcourt à pied : nord de la baie 0, sud de la baie 0, nord de
	// la baie 1, sud de la baie 1… Les rangées ne se font face que deux à deux,
	// et chaque paire a son allée.
	const rows = [];
	const rowAt = new Map();
	const row = (bay, side) => {
		const key = `${bay}:${side}`;
		let found = rowAt.get(key);
		if (!found) {
			found = { bay, side, cursor: 0, depth: 0 };
			rowAt.set(key, found);
			rows.push(found);
		}
		return found;
	};
	/** Le côté suivant : l'autre bord de la même allée, puis la baie d'après. */
	const nextRow = (bay, side) => (side < 0 ? { bay, side: 1 } : { bay: bay + 1, side: -1 });

	const quais = [];
	const zones = [];
	// On entre par la baie 0, côté nord : c'est de là que la visite commence.
	let here = { bay: 0, side: -1 };

	for (const folder of folders) {
		const machines = byFolder.get(folder.id) ?? [];
		// On ne garde que les machines qui ont quelque chose à montrer : au
		// moins un agent éveillé. Les autres n'ont pas de quai du tout.
		const active = machines.filter((vps) => measure(sessionsOf(vps.id)).awake.length > 0);
		if (!active.length) continue;

		// Deux dossiers ne partagent pas une rangée : la zone peinte au sol ne
		// voudrait plus rien dire. Le dossier commence donc sur une rangée neuve
		// — sauf le premier, qui ouvre la salle.
		if (row(here.bay, here.side).cursor > 0) here = nextRow(here.bay, here.side);

		// Un dossier qui déborde laisse plusieurs morceaux de zone ; chacun sait
		// où il se situe dans l'ensemble, pour que le sol le dise.
		let segment = null;

		for (const vps of active) {
			const size = measure(sessionsOf(vps.id));
			let target = row(here.bay, here.side);
			let gap = target.cursor === 0 ? 0 : DIMS.quaiGap;
			if (target.cursor > 0 && target.cursor + gap + size.width > BAY.span) {
				here = nextRow(here.bay, here.side);
				target = row(here.bay, here.side);
				gap = 0;
				segment = null;
			}

			const x = target.cursor + gap;
			target.cursor = x + size.width;
			target.depth = Math.max(target.depth, size.depth);

			if (!segment) {
				segment = {
					id: folder.id, name: folder.name, side: target.side, bay: target.bay,
					aisleZ: 0, x0: x, x1: x + size.width, machines: 0, part: zones.length, parts: 1
				};
				zones.push(segment);
			}
			segment.x1 = x + size.width;
			segment.machines += 1;

			const quai = {
				id: vps.id,
				name: vps.name,
				agentStatus: vps.agentStatus,
				lastSeenAt: vps.lastSeenAt,
				agentVersion: vps.agentVersion,
				defaultPath: vps.defaultPath,
				ip: vps.ip,
				folderId: folder.id,
				folderName: folder.name,
				bay: target.bay,
				aisleZ: 0,
				side: target.side,
				x,
				width: size.width,
				depth: size.depth,
				lanes: size.floors.length,
				deep: size.deep,
				// Origine du quai : au bord de l'allée, à la verticale. `z` est
				// ajusté plus bas, quand les allées ont une position.
				origin: { x: x + size.width / 2, z: 0 },
				sessions: sessionsOf(vps.id),
				awake: size.awake,
				asleep: size.asleep,
				desks: [],
				// Le nom peint, les sous-niveaux et le placard sont posés dans le
				// repère local plus bas : leur `z` dépend du côté de la rangée,
				// donc du sens de l'éloignement — on ne peut pas le calculer ici.
				// `name` reste le nom de la MACHINE (la chaîne) ; `floorName` est
				// la boîte du nom peint au sol.
				floorName: { x: 0, z: 0, w: 0, d: 0, base: 0 },
				levels: [],
				store: null
			};
			quais.push(quai);
		}
	}

	/* ----------------------------------------------------------- les allées */

	// La profondeur d'une baie est celle de ses rangées : on pose la baie
	// suivante derrière l'emprise de la précédente, séparée par un passage.
	const bays = [];
	const bayAisle = new Map();
	const usedBays = [...new Set(rows.map((r) => r.bay))].sort((a, b) => a - b);
	let z = 0;
	usedBays.forEach((index, i) => {
		const north = rowAt.get(`${index}:-1`);
		const south = rowAt.get(`${index}:1`);
		const depthNorth = north?.depth ?? 0;
		const depthSouth = south?.depth ?? 0;
		bays.push({ index, aisleZ: z, depthNorth, depthSouth });
		bayAisle.set(index, z);
		if (i < usedBays.length - 1) {
			const nextNorth = rowAt.get(`${usedBays[i + 1]}:-1`);
			z += DIMS.aisle / 2 + depthSouth + BAY.gap + DIMS.aisle / 2 + (nextNorth?.depth ?? 0);
		}
	});
	for (const quai of quais) {
		quai.aisleZ = bayAisle.get(quai.bay) ?? 0;
		quai.origin.z = quai.aisleZ + quai.side * (DIMS.aisle / 2);
	}
	for (const zone of zones) zone.aisleZ = bayAisle.get(zone.bay) ?? 0;

	// Les zones disent combien de morceaux porte leur dossier : le sol écrit
	// « 2/3 » sur un morceau, sinon on croit à deux dossiers différents.
	for (const zone of zones) {
		zone.parts = zones.filter((other) => other.id === zone.id).length;
		zone.part = zones.filter((other) => other.id === zone.id).indexOf(zone) + 1;
	}

	/* ------------------------------------------- le repère local des postes */

	for (const quai of quais) {
		// `dir` vaut +1 pour la rangée sud, -1 pour la rangée nord : le robot
		// regarde son écran, donc l'allée, et la rangée nord fait demi-tour.
		const dir = quai.side;
		const size = measure(quai.sessions);
		const at = (lx, lz) => ({ x: quai.origin.x + lx, z: quai.origin.z + dir * lz });
		const ctx = { quai, at, levels: quai.levels, dir };

		// Les travées du quai se posent côte à côte, centrées : la première ouvre
		// à gauche de l'axe, et chacune s'enfonce vers le fond. Le premier poste
		// d'un sol est toujours à la même distance de son bord, quel que soit le
		// nombre de robots qui le composent — et c'est le MEUBLE qui donne la
		// ligne, son bord avant tombant pile sur `FRONT`. Devant, la bande
		// d'accostage reste nue : c'est cette ligne de meubles alignés, à la même
		// profondeur, qui rend la salle lisible, et c'est elle que le nom de
		// chaque dossier longe.
		let x = -size.contentW / 2;
		for (const floor of size.floors) {
			placeFloor(floor, x, 0, ctx);
			x += floor.w + DIMS.floorGap;
		}

		// Le nom de la machine : derrière les postes, à plat sur le plancher du
		// quai. `base` oriente le texte — la rangée sud fait demi-tour pour se
		// lire depuis l'allée, et `faceCamera` le retourne ensuite face au
		// visiteur, quel que soit le côté d'où il regarde.
		const sign = at(0, size.nameZ);
		quai.floorName = {
			x: sign.x,
			z: sign.z,
			w: size.nameW,
			d: size.nameD,
			base: dir > 0 ? Math.PI : 0
		};

		// Le placard de stockage : les robots endormis de la machine, rangés
		// dans une armoire au fond du quai. Il n'y a plus un robot par dormant
		// mais une armoire par machine, et c'est elle qu'on ouvre.
		if (size.store) {
			const box = at(0, size.storeZ);
			quai.store = {
				quai,
				x: box.x,
				z: box.z,
				w: size.store,
				d: DIMS.store.d,
				h: DIMS.store.h,
				yaw: quai.side < 0 ? Math.PI : 0,
				sessions: quai.asleep
			};
		}
	}

	/* ---------------------------------------------- recentrer la salle */

	// Les rangées se sont construites depuis x=0 et l'allée de la baie 0 depuis
	// z=0 : on recentre les deux axes pour que le milieu de la salle soit
	// l'origine du monde. La caméra part de là, et rien ne dérive quand la
	// flotte change de taille.
	const spanX = Math.max(...quais.map((q) => q.x + q.width), 24);
	const offsetX = -spanX / 2;
	const northZ = -DIMS.aisle / 2 - (bays[0]?.depthNorth ?? 0);
	const southZ = (bays.at(-1)?.aisleZ ?? 0) + DIMS.aisle / 2 + (bays.at(-1)?.depthSouth ?? 0);
	const offsetZ = -(northZ + southZ) / 2;

	for (const quai of quais) {
		quai.x += offsetX;
		quai.origin.x += offsetX;
		quai.origin.z += offsetZ;
		for (const desk of quai.desks) { desk.x += offsetX; desk.z += offsetZ; }
		for (const level of quai.levels) {
			level.x += offsetX;
			level.z += offsetZ;
			level.title.x += offsetX;
			level.title.z += offsetZ;
			level.label.x += offsetX;
			level.label.z += offsetZ;
		}
		quai.floorName.x += offsetX;
		quai.floorName.z += offsetZ;
		if (quai.store) { quai.store.x += offsetX; quai.store.z += offsetZ; }
	}
	for (const zone of zones) { zone.x0 += offsetX; zone.x1 += offsetX; zone.aisleZ += offsetZ; }
	for (const bay of bays) bay.aisleZ += offsetZ;

	// Les VPS qui ne sont pas descendus dans la salle : les machines sans agent
	// éveillé (voir plus haut). Ils ne sont NI posés NI dessinés — cette liste
	// n'est qu'un compte, pour que l'habillage puisse dire combien de machines
	// travaillent sur les vingt-cinq que Charon connaît.
	const occupiedIds = new Set(quais.map((q) => q.id));
	const idleVps = fleet.vps.filter((v) => !occupiedIds.has(v.id));

	return {
		quais,
		zones,
		bays,
		idleVps,
		span: spanX,
		bounds: {
			minX: -spanX / 2 - 4,
			maxX: spanX / 2 + 4,
			minZ: northZ + offsetZ - 4,
			maxZ: southZ + offsetZ + 4
		},
		center: { x: 0, z: (northZ + southZ) / 2 + offsetZ }
	};
}

/** Le quai qui contient une session, et le poste qu'elle y occupe.
 *
 *  Une session endormie n'a pas de poste : elle est dans le placard de son
 *  quai. On rend alors le quai lui-même, sans position de robot — la caméra
 *  sait se poser devant une armoire comme devant un poste. */
export function findStation(layout, sessionId) {
	for (const quai of layout.quais) {
		for (const desk of quai.desks) if (desk.session.id === sessionId) return desk;
		if (quai.store?.sessions.some((s) => s.id === sessionId)) return quai.store;
	}
	return null;
}
