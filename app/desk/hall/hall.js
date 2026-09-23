// Le hall : sol, zones, quais, noms peints, enseigne.
//
// Tout ce qui est immobile et répété est ici en géométrie instanciée ou en
// maillage unique — la salle ne doit rien coûter, elle n'est que le cadre.
//
// Trois choses s'y lisent, dans cet ordre :
//   — le NOM de chaque machine, peint sur le plancher de son quai ;
//   — le NOM de chaque dossier de Charon, peint à l'entrée de sa zone ;
//   — le LISTON de chaque quai, qui prend la couleur de ce que la machine
//     réclame. Depuis l'entrée, on voit donc où il faut aller avant même de
//     distinguer un robot.

import * as THREE from '../vendor/three.module.js';
import { DIMS } from './layout.js';
import { makeCanvas, toTexture, roundRect, wrap } from './canvas.js';
import { shortPath } from './text.js';
import { vpsStatusOf, stateOf } from './palette.js';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _v2 = new THREE.Vector3();
const _color = new THREE.Color();

/** Béton sombre, joints de dilatation tous les deux mètres. */
function floorTexture(anisotropy, repeat) {
	const { canvas, ctx } = makeCanvas(512, 512);
	// Un béton sombre, mais pas noir : sous la tonalité ACES, un sol à 0x16 vire
	// au trou. C'est le contraste avec le mobilier — et non l'obscurité — qui
	// doit faire ressortir les robots.
	ctx.fillStyle = '#1d2431';
	ctx.fillRect(0, 0, 512, 512);
	for (let i = 0; i < 12000; i++) {
		ctx.fillStyle = `rgba(185,205,235,${Math.random() * 0.03})`;
		ctx.fillRect(Math.random() * 512, Math.random() * 512, 2.2, 2.2);
	}
	ctx.strokeStyle = 'rgba(150,175,210,0.1)';
	ctx.lineWidth = 2;
	for (let i = 0; i <= 4; i++) {
		const p = i * 128;
		ctx.beginPath();
		ctx.moveTo(p, 0); ctx.lineTo(p, 512);
		ctx.moveTo(0, p); ctx.lineTo(512, p);
		ctx.stroke();
	}
	return toTexture(canvas, { anisotropy, repeat });
}

/**
 * Ce que la machine réclame, en une couleur.
 *
 * C'est la règle du desk appliquée à l'échelle du quai : la question l'emporte
 * sur tout (quelqu'un attend une réponse), puis le tour fini non lu, puis le
 * travail. Une machine sans rien à signaler n'allume pas son liston — c'est
 * l'absence de lumière qui veut dire « rien à faire ici ».
 */
export function quaiBeacon(quai) {
	let found = null;
	let rank = 99;
	const order = { question: 0, unread: 1, working: 2, background: 3 };
	for (const session of quai.sessions) {
		const state = stateOf(session);
		const position = order[state.id];
		if (position === undefined) continue;
		if (position < rank) {
			rank = position;
			found = state;
		}
	}
	if (found) return { css: found.pulse, state: found };
	if (quai.agentStatus && quai.agentStatus !== 'ok') {
		const status = vpsStatusOf(quai.agentStatus);
		return { css: status.css, state: null };
	}
	return null;
}

/** Le nom du dossier, peint au sol à l'entrée de sa zone. */
function zoneTexture(zone) {
	const H = 220;
	const { canvas, ctx } = makeCanvas(1400, H);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';

	const name = zone.name.replace(/\s+/g, ' ').trim();
	let size = 132;
	let lines = [name];
	for (; size >= 40; size -= 4) {
		ctx.font = `bold ${size}px "DejaVu Sans", system-ui, sans-serif`;
		lines = wrap(ctx, name, 1300, 2);
		if (lines.join(' ') === name) break;
	}
	ctx.font = `bold ${size}px "DejaVu Sans", system-ui, sans-serif`;
	const lead = size * 1.02;
	const top = H / 2 - (lines.length * lead) / 2;
	ctx.fillStyle = 'rgba(200,170,90,0.5)';
	lines.forEach((line, i) => ctx.fillText(line, 700, top + lead * (i + 0.5)));

	// Le compte de machines, sous le nom : la zone dit combien elle en porte.
	ctx.font = '46px "DejaVu Sans", system-ui, sans-serif';
	ctx.fillStyle = 'rgba(150,175,210,0.4)';
	// Un dossier qui déborde sur plusieurs rangées écrit « 2/3 » : sans ça, on
	// croirait à trois dossiers portant le même nom.
	const part = zone.parts > 1 ? ` · ${zone.part}/${zone.parts}` : '';
	ctx.fillText(
		`${zone.machines} machine${zone.machines > 1 ? 's' : ''}${part}`,
		700, top + lines.length * lead + 44
	);

	return toTexture(canvas, { anisotropy: 8 });
}

/** Marquage au sol : le nom de la machine, peint sur le plancher de son quai,
 *  juste devant ses postes. Pas de fond — c'est du béton peint, pas une
 *  enseigne — et la barre sous le nom reprend la couleur du liston.
 *
 *  La toile est très large et basse : la bande libre d'un quai fait un peu plus
 *  d'un demi-mètre de fond, et c'est cette proportion qu'il faut tenir pour que
 *  les lettres ne soient pas écrasées une fois posées. */
function floorNameTexture(quai) {
	const H = 256;
	const { canvas, ctx } = makeCanvas(2048, H);
	const beacon = quaiBeacon(quai);
	const name = quai.name.replace(/\s+/g, ' ').trim().toUpperCase();

	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';

	// Le nom descend en taille jusqu'à tenir : sur une ligne si possible, sur
	// deux sinon. Un nom de machine ne se coupe pas.
	let size = 150;
	let lines = [];
	for (; size >= 34; size -= 4) {
		ctx.font = `bold ${size}px "DejaVu Sans", system-ui, sans-serif`;
		lines = wrap(ctx, name, 1880, 2);
		if (lines.join(' ').length === name.length) break;
	}

	const lead = size * 0.98;
	const bar = Math.max(8, Math.round(size * 0.11));
	const gap = size * 0.16;
	const block = lines.length * lead + gap + bar;
	const top = (H - block) / 2;
	const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));

	ctx.fillStyle = 'rgba(226, 238, 252, 0.8)';
	lines.forEach((line, i) => ctx.fillText(line, 1024, top + lead * (i + 0.5)));

	ctx.globalAlpha = 0.9;
	ctx.fillStyle = beacon?.css ?? 'rgba(120,140,170,0.5)';
	const barW = Math.min(1960, Math.max(420, widest * 1.02));
	roundRect(ctx, 1024 - barW / 2, top + lines.length * lead + gap, barW, bar, bar / 2);
	ctx.fill();
	ctx.globalAlpha = 1;

	return toTexture(canvas, { anisotropy: 8 });
}

/** Le nom d'un chemin de travail, peint à plat sur le quai, devant sa file.
 *
 *  Même famille que le nom des machines — encre claire, barre à la couleur du
 *  liston —, mais écrit plus petit et sans compte : quinze chemins tiennent
 *  côte à côte dans la largeur d'une salle, et c'est la vue du DESSUS qui les
 *  lit, rangés en colonnes comme les allées d'un plan d'atelier. Le compte,
 *  lui, se voit : il suffit de compter les postes de la file.
 *
 *  Un chemin trop long perd ses premiers segments, jamais son dernier
 *  (`shortPath`) : `/charon` annoncerait une racine qui n'est pas la sienne. */
function laneNameTexture(level, quai) {
	const H = 288;
	const { canvas, ctx } = makeCanvas(1024, H);
	const beacon = quaiBeacon(quai);
	const text = shortPath(level.path);

	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';

	// La taille descend jusqu'à ce que le nom tienne : on ne coupe pas un nom de
	// chemin au caractère près, on l'écrit plus petit.
	let size = 168;
	for (; size >= 44; size -= 4) {
		ctx.font = `bold ${size}px "DejaVu Sans", system-ui, sans-serif`;
		if (ctx.measureText(text).width <= 940) break;
	}

	const lead = size * 0.98;
	const bar = Math.max(8, Math.round(size * 0.11));
	const gap = size * 0.16;
	const block = lead + gap + bar;
	const top = (H - block) / 2;
	const widest = Math.min(940, ctx.measureText(text).width);

	ctx.fillStyle = 'rgba(222, 234, 250, 0.78)';
	ctx.fillText(text, 512, top + lead / 2);

	ctx.globalAlpha = 0.85;
	ctx.fillStyle = beacon?.css ?? 'rgba(120,140,170,0.45)';
	const barW = Math.max(200, Math.min(980, widest * 1.02));
	roundRect(ctx, 512 - barW / 2, top + lead + gap, barW, bar, bar / 2);
	ctx.fill();
	ctx.globalAlpha = 1;

	return toTexture(canvas, { anisotropy: 8 });
}

/** Le socle d'une file : une bande peinte sur le plancher du quai. Un lavis très
 *  clair, et trois liserés — les deux côtés et le bord de l'allée. Assez pour
 *  qu'on voie où commence et où s'arrête un chemin, assez peu pour que le
 *  plancher reste du plancher. */
function treadTexture() {
	const { canvas, ctx } = makeCanvas(128, 128);
	ctx.fillStyle = 'rgba(198, 214, 236, 0.06)';
	ctx.fillRect(0, 0, 128, 128);
	return toTexture(canvas, { anisotropy: 4 });
}

/** Enseigne peinte au sol, à l'entrée du hall. */
function floorSignTexture() {
	const { canvas, ctx } = makeCanvas(1024, 256);
	ctx.clearRect(0, 0, 1024, 256);
	ctx.fillStyle = 'rgba(200,170,90,0.5)';
	ctx.font = 'bold 86px "DejaVu Sans", system-ui, sans-serif';
	ctx.fillText('THE DESK', 24, 104);
	ctx.fillStyle = 'rgba(160,180,205,0.42)';
	ctx.font = '42px "DejaVu Sans", system-ui, sans-serif';
	ctx.fillText('charon.chalco.website/desk — read-only', 28, 178);
	return toTexture(canvas, { anisotropy: 8 });
}

export function buildHall(scene, layout, anisotropy) {
	const group = new THREE.Group();
	group.name = 'hall';
	scene.add(group);

	const { bounds } = layout;
	const sizeX = bounds.maxX - bounds.minX;
	const sizeZ = bounds.maxZ - bounds.minZ;
	const midX = (bounds.minX + bounds.maxX) / 2;
	const midZ = (bounds.minZ + bounds.maxZ) / 2;

	/* ------------------------------------------------------------------ sol */
	const floor = new THREE.Mesh(
		new THREE.PlaneGeometry(sizeX, sizeZ),
		new THREE.MeshStandardMaterial({
			map: floorTexture(anisotropy, [sizeX / 4, sizeZ / 4]),
			color: 0xffffff, roughness: 0.92, metalness: 0.05
		})
	);
	floor.rotation.x = -Math.PI / 2;
	floor.position.set(midX, 0, midZ);
	floor.receiveShadow = true;
	group.add(floor);

	/* ------------------------------------------------ marquage des allées */
	// Une bande peinte le long de chaque allée, sur toute la longueur de la baie
	// qu'elle dessert — pas sur toute la salle : une allée s'arrête où sa rangée
	// s'arrête, et une bande qui file dans le vide ne veut rien dire.
	const paint = new THREE.MeshBasicMaterial({ color: 0x8a7530, transparent: true, opacity: 0.5 });
	const marking = new THREE.InstancedMesh(
		new THREE.BoxGeometry(1, 0.01, 1), paint, Math.max(4, layout.bays.length * 4)
	);
	marking.frustumCulled = false;
	let marks = 0;
	const mark = (x, z, w, d) => {
		_m.compose(_v.set(x, 0.008, z), _q.set(0, 0, 0, 1), _v2.set(w, 1, d));
		marking.setMatrixAt(marks++, _m);
	};
	for (const bay of layout.bays) {
		const mine = layout.quais.filter((quai) => quai.bay === bay.index);
		if (!mine.length) continue;
		const x0 = Math.min(...mine.map((quai) => quai.x)) - 1.2;
		const x1 = Math.max(...mine.map((quai) => quai.x + quai.width)) + 1.2;
		for (const side of [-1, 1]) {
			mark((x0 + x1) / 2, bay.aisleZ + side * (DIMS.aisle / 2 - 0.25), x1 - x0, 0.14);
			mark((x0 + x1) / 2, bay.aisleZ + side * (DIMS.aisle / 2 - 0.65), x1 - x0, 0.05);
		}
	}
	marking.count = marks;
	group.add(marking);

	/* -------------------------------------------------------------- planchers */
	const deckMaterial = new THREE.MeshStandardMaterial({
		color: 0x39435a, roughness: 0.72, metalness: 0.26,
		envMapIntensity: 1.15, flatShading: true
	});
	const decks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), deckMaterial, layout.quais.length);
	decks.frustumCulled = false;
	decks.receiveShadow = true;
	const edges = new THREE.InstancedMesh(
		new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({}), layout.quais.length
	);
	edges.frustumCulled = false;

	layout.quais.forEach((quai, i) => {
		const dir = quai.side;
		const centerZ = quai.origin.z + (dir * quai.depth) / 2;
		_m.compose(
			_v.set(quai.origin.x, DIMS.quaiLift / 2, centerZ),
			_q.set(0, 0, 0, 1),
			_v2.set(quai.width, DIMS.quaiLift, quai.depth)
		);
		decks.setMatrixAt(i, _m);
		// Le liston dit ce que la machine réclame, vu depuis l'allée.
		_m.compose(
			_v.set(quai.origin.x, DIMS.quaiLift + 0.012, quai.origin.z + dir * 0.09),
			_q.set(0, 0, 0, 1),
			_v2.set(quai.width, 0.02, 0.16)
		);
		edges.setMatrixAt(i, _m);
		const beacon = quaiBeacon(quai);
		_color.setHex(beacon ? parseInt(beacon.css.replace('#', ''), 16) : 0x1d2733);
		edges.setColorAt(i, _color);
	});
	group.add(decks, edges);

	/* ------------------------------------------------------------ les plaques */
	// Il n'y en a plus. Le nom de la machine est peint sur son plancher, et une
	// plaque sur mât devant chaque quai finissait par dresser une forêt de
	// panneaux devant les robots : elle redisait ce que le sol dit déjà, en
	// masquant ce qu'on venait voir. Le liston du quai — la bande colorée à son
	// bord — reste : lui ne cache rien et porte l'information que le sol ne
	// porte pas.

	/* -------------------------------------------------- noms peints sur le sol */
	// Tous les textes posés à plat sont retenus ici : ce sont eux que la salle
	// retourne face au visiteur, plus bas dans `faceCamera`.
	const ground = [];
	// Le nom de chaque machine est peint DERRIÈRE ses postes, sur le plancher du
	// quai — là où dormaient ses robots avant qu'ils ne soient rangés dans le
	// placard. Rien ne flotte au-dessus de la salle, la vue du ciel nomme tout
	// le monde, et l'allée n'est pas encombrée de deux textes sur la même bande
	// de béton. La place est calculée par `layout.js` : le nom, puis le placard.
	for (const quai of layout.quais) {
		const at = quai.floorName;
		const name = new THREE.Mesh(
			new THREE.PlaneGeometry(at.w, at.d),
			new THREE.MeshBasicMaterial({
				map: floorNameTexture(quai), transparent: true, depthWrite: false
			})
		);
		// À plat, le haut du texte pointe vers -Z : la rangée sud fait demi-tour
		// pour rester lisible depuis l'allée. `faceCamera` le retournera ensuite
		// face au visiteur, d'où qu'il regarde.
		name.rotation.set(-Math.PI / 2, 0, at.base);
		name.position.set(at.x, DIMS.quaiLift + 0.013, at.z);
		group.add(name);
		ground.push({ mesh: name, base: at.base, x: name.position.x, z: name.position.z });
	}

	/* ------------------------------------------------ sous-niveaux (chemins) */
	// Le troisième étage de la salle : sous la machine, ses chemins de travail.
	// Chaque groupe de robots qui partagent un `cwd` est une file : un socle — un
	// lavis clair et trois liserés, ouverts vers le fond du quai —, son nom peint
	// sur le plancher libre devant elle, et son titre dans le ciel pour les yeux
	// qui rasent la salle : une peinture vue de l'allée s'écrase en quelques
	// pixels, et c'est le titre qui prend alors le relais.
	const treads = layout.quais.flatMap((quai) => quai.levels.map((level) => ({ quai, level })));

	const wash = new THREE.InstancedMesh(
		new THREE.PlaneGeometry(1, 1),
		new THREE.MeshBasicMaterial({ map: treadTexture(), transparent: true, depthWrite: false }),
		Math.max(1, treads.length)
	);
	wash.frustumCulled = false;
	const rails = new THREE.InstancedMesh(
		new THREE.BoxGeometry(1, 0.01, 1),
		new THREE.MeshBasicMaterial({ color: 0xa8bfdd, transparent: true, opacity: 0.24 }),
		Math.max(1, treads.length * 3)
	);
	rails.frustumCulled = false;
	let railCount = 0;
	treads.forEach(({ quai, level }, i) => {
		_m.compose(
			_v.set(level.x, DIMS.quaiLift + 0.006, level.z),
			_q.setFromEuler(_eu.set(-Math.PI / 2, 0, 0)),
			_v2.set(level.w, level.d, 1)
		);
		wash.setMatrixAt(i, _m);
		_q.set(0, 0, 0, 1);
		// Les deux côtés, puis le bord de l'allée : la file est ouverte vers le
		// fond du quai, où le nom de la machine prend le relais.
		const toward = Math.sign(level.z - quai.origin.z) || 1;
		const edges = [
			[level.x - level.w / 2, level.z, 0.055, level.d],
			[level.x + level.w / 2, level.z, 0.055, level.d],
			[level.x, level.z - toward * (level.d / 2), level.w, 0.055]
		];
		for (const [x, z, w, d] of edges) {
			_m.compose(_v.set(x, DIMS.quaiLift + 0.012, z), _q, _v2.set(w, 1, d));
			rails.setMatrixAt(railCount++, _m);
		}
	});
	wash.count = treads.length;
	rails.count = railCount;
	group.add(wash, rails);

	// Le nom du chemin, peint à plat sur le plancher BLEU du quai, devant sa
	// file. C'est la bande d'accostage qui le porte : le poste entier a reculé de
	// `DESK_BACK` pour la libérer, et le meuble commence maintenant juste derrière
	// la plaque. Ni derrière les postes — un bureau de 74 cm y cache le plancher
	// sur plus d'un mètre —, ni dans l'allée, qui appartient au dossier. La
	// plaque prend la largeur exacte du socle qu'elle nomme : la salle se lit
	// d'un seul tenant quand on la regarde du dessus, chaque colonne portant son
	// nom à la tête. Le titre flottant ne reste que pour les yeux qui rasent le
	// sol (`world.js`), là où une peinture ne fait plus que quelques pixels de
	// haut — et il se tient alors à la verticale de la plaque, sur la même
	// colonne.
	for (const { quai, level } of treads) {
		const at = level.label;
		const plate = new THREE.Mesh(
			new THREE.PlaneGeometry(at.w, at.d),
			new THREE.MeshBasicMaterial({
				map: laneNameTexture(level, quai), transparent: true, depthWrite: false
			})
		);
		plate.rotation.set(-Math.PI / 2, 0, at.base);
		plate.position.set(at.x, DIMS.quaiLift + 0.014, at.z);
		group.add(plate);
		ground.push({ mesh: plate, base: at.base, x: plate.position.x, z: plate.position.z });
	}

	/* -------------------------------------------------- noms des zones (dossiers) */
	// Le nom du dossier, lui, est peint dans l'ALLÉE : la zone commence au bord
	// de l'allée et le nom le dit avant qu'on ait posé le pied sur le quai. Il
	// tient la moitié de l'allée qui regarde sa rangée — l'autre moitié porte le
	// nom de la rangée d'en face, et chacun se lit depuis son propre côté.
	for (const zone of layout.zones) {
		const w = Math.min(7.5, Math.max(4, (zone.x1 - zone.x0) * 0.7));
		const sign = new THREE.Mesh(
			new THREE.PlaneGeometry(w, (w * 220) / 1400),
			new THREE.MeshBasicMaterial({
				map: zoneTexture(zone), transparent: true, depthWrite: false, opacity: 0.9
			})
		);
		const base = zone.side > 0 ? Math.PI : 0;
		sign.rotation.set(-Math.PI / 2, 0, base);
		sign.position.set(
			(zone.x0 + zone.x1) / 2,
			0.022,
			zone.aisleZ + zone.side * (DIMS.aisle / 2 - 1.35)
		);
		group.add(sign);
		ground.push({ mesh: sign, base, x: sign.position.x, z: sign.position.z });
	}

	/* ------------------------------------------------- râtelier des VPS muets */
	// Il n'y en a plus. C'était une grille de niches vides, dressée contre le mur
	// du fond pour les machines sans aucune session : des cases où il n'y a rien,
	// et rien à en apprendre. Une machine qui n'a rien à montrer ne descend plus
	// dans la salle du tout — ni quai, ni niche, ni nom.

	/* -------------------------------------------------------- coque du hall */
	// Toit et murs ne sont visibles que de l'intérieur : vu de l'extérieur, la
	// salle s'ouvre comme une maquette. On peut donc la survoler sans buter sur
	// un couvercle noir.
	const shellMaterial = new THREE.MeshStandardMaterial({
		color: 0x171d29, roughness: 0.95, metalness: 0.08,
		side: THREE.FrontSide
	});
	const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, sizeZ), shellMaterial);
	ceiling.rotation.x = Math.PI / 2;
	ceiling.position.set(midX, 7.4, midZ);
	group.add(ceiling);

	for (const z of [bounds.minZ, bounds.maxZ]) {
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(sizeX, 7.4), shellMaterial);
		wall.position.set(midX, 3.7, z);
		wall.rotation.y = z < 0 ? 0 : Math.PI;
		group.add(wall);
	}
	for (const x of [bounds.minX, bounds.maxX]) {
		const wall = new THREE.Mesh(new THREE.PlaneGeometry(sizeZ, 7.4), shellMaterial);
		wall.position.set(x, 3.7, midZ);
		wall.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
		group.add(wall);
	}

	/* --------------------------------------------------- le plafond reste nu */
	// Il a porté deux rangées de tubes au-dessus de chaque allée. Vus de la
	// salle, c'étaient deux traits blancs qui traversaient tout le cadre et
	// tiraient l'œil vers le haut, là où il n'y a rien à lire — et ils
	// n'éclairaient rien : un tube de décor ne fait que se peindre. La lumière
	// vient du ciel, de la direction qui porte l'ombre et des lampes d'allée
	// (plus bas) ; le plafond sombre laisse les robots s'y détacher.

	/* -------------------------------------------------------------- enseigne */
	// Au bout ouest de la PREMIÈRE allée, tournée vers qui arrive : le hall se
	// nomme lui-même, là où aucun quai n'a de nom peint.
	const entry = layout.bays[0]?.aisleZ ?? 0;
	const sign = new THREE.Mesh(
		new THREE.PlaneGeometry(3.8, 0.95),
		new THREE.MeshBasicMaterial({
			map: floorSignTexture(), transparent: true, opacity: 0.7, depthWrite: false
		})
	);
	// Le texte est couché le long de l'allée. Sa rotation n'est qu'un point de
	// départ : comme tous les textes posés à plat, l'enseigne se retourne face
	// au visiteur (`faceCamera`), sinon elle se lirait à l'envers depuis la
	// moitié de la salle.
	sign.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
	sign.position.set(bounds.minX + 1.9, 0.022, entry);
	group.add(sign);
	ground.push({ mesh: sign, base: -Math.PI / 2, x: sign.position.x, z: sign.position.z });

	/* --------------------------------------------------------------- lumières */
	// Les robots regardent l'allée des deux côtés : aucune direction ne doit
	// être le côté noir. D'où un ciel haut et deux directions opposées.
	scene.add(new THREE.HemisphereLight(0x6c86ad, 0x1b2130, 3.1));
	const key = new THREE.DirectionalLight(0xc6d8f2, 1.4);
	// Une seule ombre dans la salle, et elle tombe du plafond : c'est ce qui
	// pose les robots sur le béton au lieu de les y faire flotter.
	key.castShadow = true;
	key.shadow.mapSize.set(2048, 2048);
	key.shadow.bias = -0.0007;
	key.shadow.normalBias = 0.035;
	const reach = Math.max(sizeX, sizeZ) * 0.62;
	const shadowCamera = key.shadow.camera;
	shadowCamera.left = -reach;
	shadowCamera.right = reach;
	shadowCamera.top = reach;
	shadowCamera.bottom = -reach;
	shadowCamera.near = 1;
	shadowCamera.far = 60;
	shadowCamera.updateProjectionMatrix();
	scene.add(key);
	scene.add(key.target);
	const fill = new THREE.DirectionalLight(0x8ba6cf, 1.15);
	fill.position.set(-bounds.maxX * 0.4, 9, 14);
	scene.add(fill);

	// Une lampe au-dessus de chaque allée, régulièrement espacée : c'est ce qui
	// fait qu'une baie lointaine reste lisible au lieu de s'éteindre avec la
	// distance.
	const pools = [];
	const poolCount = Math.min(5, Math.max(2, Math.round(sizeX / 16)));
	for (const bay of layout.bays) {
		for (let i = 0; i < poolCount; i++) {
			const lamp = new THREE.PointLight(0xcfe0ff, 34, 28, 2);
			lamp.position.set(
				bounds.minX + 8 + i * ((sizeX - 16) / Math.max(1, poolCount - 1)),
				6.2,
				bay.aisleZ
			);
			scene.add(lamp);
			pools.push(lamp);
		}
	}

	/* -------------------------------------------------- lisibilité des noms */

	// Un nom peint au sol ne se lit que d'un côté : passé de l'autre, on lit un
	// mot à l'envers. Comme la caméra est libre, c'est le MOT qui se retourne —
	// on choisit, pour chaque texte, l'une des deux orientations dans lesquelles
	// il se lit depuis là où l'on est.
	//
	// Le « haut » du texte se calcule : une rotation de `base` autour de Z incline
	// le texte d'autant dans le plan du sol, et le haut part de -Z. Un texte se
	// lit quand son haut vient VERS le visiteur — c'est le sens dans lequel on
	// lit une feuille posée devant soi. Le basculement demande un peu de marge
	// (0,9 m) : sans elle, une caméra qui traîne pile sur la ligne ferait
	// clignoter la salle.
	const _eye = new THREE.Vector3(1e9, 0, 0);
	function faceCamera(camera) {
		if (_eye.distanceToSquared(camera.position) < 0.0625) return;
		_eye.copy(camera.position);
		for (const item of ground) {
			const upX = -Math.sin(item.base);
			const upZ = -Math.cos(item.base);
			const facing = upX * (_eye.x - item.x) + upZ * (_eye.z - item.z);
			const wanted = item.base + (facing > 0.9 ? Math.PI : 0);
			if (item.mesh.rotation.z !== wanted) item.mesh.rotation.z = wanted;
		}
	}

	function dispose() {
		group.traverse((object) => {
			if (object.geometry) object.geometry.dispose();
			if (object.material) {
				const materials = Array.isArray(object.material) ? object.material : [object.material];
				for (const material of materials) {
					if (material.map) material.map.dispose();
					material.dispose();
				}
			}
		});
		scene.remove(group);
		for (const lamp of pools) scene.remove(lamp);
		scene.remove(key);
		scene.remove(fill);
		scene.remove(key.target);
	}

	// La cible de l'ombre suit le centre de la salle : sans elle, l'ombre
	// tomberait à côté dès que le hall s'étend.
	key.target.position.set(midX, 0, midZ);
	key.position.set(midX + sizeX * 0.25, 16, midZ - sizeZ * 0.3);
	key.target.updateMatrixWorld();

	return { group, dispose, faceCamera, key, deckHeight: DIMS.quaiLift };
}

