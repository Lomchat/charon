// Géométries de la salle.
//
// Tout est taillé dans des primitives, puis fusionné : chaque partie mobile du
// robot (buste, tête, bras) devient une seule géométrie, dessinée une fois pour
// toute la flotte par un InstancedMesh. Cent robots tiennent alors en une
// vingtaine d'appels de dessin.

import * as THREE from '../vendor/three.module.js';

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();

/** Assemble plusieurs primitives en une seule géométrie. */
export function merge(entries) {
	const positions = [];
	const normals = [];
	const uvs = [];
	let count = 0;

	for (const { geometry, transform } of entries) {
		const source = geometry.index ? geometry.toNonIndexed() : geometry.clone();
		if (transform) {
			_position.fromArray(transform.pos ?? [0, 0, 0]);
			_euler.fromArray(transform.rot ?? [0, 0, 0]);
			_quaternion.setFromEuler(_euler);
			_scale.fromArray(transform.scale ?? [1, 1, 1]);
			_matrix.compose(_position, _quaternion, _scale);
			source.applyMatrix4(_matrix);
		}
		positions.push(source.attributes.position.array);
		normals.push(source.attributes.normal.array);
		const uv = source.attributes.uv;
		uvs.push(uv ? uv.array : new Float32Array(source.attributes.position.count * 2));
		count += source.attributes.position.count;
		source.dispose();
		geometry.dispose();
	}

	const concat = (list, itemSize) => {
		const out = new Float32Array(count * itemSize);
		let offset = 0;
		for (const array of list) {
			out.set(array, offset);
			offset += array.length;
		}
		return out;
	};

	const built = new THREE.BufferGeometry();
	built.setAttribute('position', new THREE.BufferAttribute(concat(positions, 3), 3));
	built.setAttribute('normal', new THREE.BufferAttribute(concat(normals, 3), 3));
	built.setAttribute('uv', new THREE.BufferAttribute(concat(uvs, 2), 2));
	built.computeBoundingSphere();
	return built;
}

/** Petite fabrique : on empile des primitives transformées, on fusionne. */
class Part {
	constructor() {
		this.entries = [];
	}

	add(geometry, transform) {
		this.entries.push({ geometry, transform });
		return this;
	}

	/** Boîte posée en (x, y, z). */
	box(w, h, d, pos, rot) {
		return this.add(new THREE.BoxGeometry(w, h, d), { pos, rot });
	}

	/** Cylindre d'axe Y, ou d'axe X / Z selon `rot`. */
	cyl(radiusTop, radiusBottom, height, pos, rot, segments = 10) {
		return this.add(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), { pos, rot });
	}

	/** Carrure : tronc de pyramide à quatre pans, plus large en haut. */
	taper(widthBottom, widthTop, height, depthRatio, pos) {
		const geometry = new THREE.CylinderGeometry(
			widthTop / Math.SQRT2, widthBottom / Math.SQRT2, height, 4, 1
		);
		return this.add(geometry, { pos, rot: [0, Math.PI / 4, 0], scale: [1, 1, depthRatio] });
	}

	/** Poutre tendue d'un point à un autre : c'est la brique du robot. */
	strut(from, to, width, depth) {
		const a = new THREE.Vector3(...from);
		const b = new THREE.Vector3(...to);
		const direction = new THREE.Vector3().subVectors(b, a);
		const length = direction.length();
		const geometry = new THREE.BoxGeometry(width, depth, length);
		const midpoint = a.clone().addScaledVector(direction, 0.5);
		const quaternion = new THREE.Quaternion().setFromUnitVectors(
			new THREE.Vector3(0, 0, 1), direction.normalize()
		);
		const euler = new THREE.Euler().setFromQuaternion(quaternion);
		return this.add(geometry, { pos: midpoint.toArray(), rot: euler.toArray() });
	}

	/** Sphère basse résolution, pour les articulations. */
	ball(radius, pos) {
		return this.add(new THREE.IcosahedronGeometry(radius, 0), { pos, scale: [1, 0.8, 1] });
	}

	build() {
		return merge(this.entries);
	}
}

export const part = () => new Part();

/* ------------------------------------------------------------------ le robot */

// Repère local : origine au sol sous le robot, il regarde vers -Z.
// Assis : bassin 0,52 · épaules 1,02 · sommet du crâne 1,36.
export const PIVOT = {
	torso: [0, 0.62, 0],
	head: [0, 1.12, -0.01],
	shoulderL: [-0.245, 1.02, -0.06],
	shoulderR: [0.245, 1.02, -0.06]
};

export const VISOR_CENTER = [0, 0.155, -0.115];
export const CORE_CENTER = [0, 0.3, -0.145];

/** Dalle de l'écran : centre de la face allumée, à 2 mm devant la dalle.
 *  Un écran plus large que les épaules du robot l'écraserait : on tient la
 *  taille d'un moniteur réel, pour qu'il reste l'accessoire, pas le sujet. */
export const SCREEN = { center: [0, 1.16, -0.536], tilt: -0.08, w: 0.65, h: 0.39 };

/** Face allumée de l'écran, centrée sur l'origine. */
export function screenFaceGeometry(width = SCREEN.w, height = SCREEN.h) {
	return part().box(width, height, 0.004, [0, 0, 0]).build();
}

/** Jambes, bassin et piètement — la partie qui ne bouge jamais. */
export function legsGeometry() {
	const p = part();
	p.box(0.32, 0.18, 0.26, [0, 0.52, 0.02]);
	for (const side of [-1, 1]) {
		p.cyl(0.07, 0.07, 0.16, [side * 0.17, 0.52, 0.02], [0, 0, Math.PI / 2]);
		p.box(0.15, 0.16, 0.44, [side * 0.12, 0.5, -0.19]);
		p.cyl(0.07, 0.07, 0.17, [side * 0.135, 0.48, -0.4], [0, 0, Math.PI / 2]);
		p.box(0.13, 0.42, 0.15, [side * 0.14, 0.27, -0.42]);
		p.box(0.16, 0.06, 0.3, [side * 0.14, 0.04, -0.34]);
		p.cyl(0.05, 0.05, 0.12, [side * 0.14, 0.09, -0.4], [0, 0, Math.PI / 2]);
	}
	return p.build();
}

/** Buste, dans le repère du pivot de taille. */
export function torsoGeometry() {
	const p = part();
	p.cyl(0.085, 0.085, 0.12, [0, 0.05, 0]);
	p.taper(0.34, 0.44, 0.42, 0.66, [0, 0.27, 0]);
	p.box(0.5, 0.09, 0.26, [0, 0.49, 0]);
	p.box(0.24, 0.2, 0.09, [0, 0.28, 0.17], [0.12, 0, 0]);
	// Grilles d'aération sur les flancs.
	for (const side of [-1, 1]) {
		for (let i = 0; i < 3; i++) {
			p.box(0.02, 0.014, 0.12, [side * 0.185, 0.18 + i * 0.05, 0.0]);
		}
	}
	p.cyl(0.05, 0.055, 0.1, [0, 0.56, -0.01]);
	return p.build();
}

/** Tête, dans le repère du pivot de cou. */
export function headGeometry() {
	const p = part();
	p.box(0.24, 0.2, 0.22, [0, 0.13, -0.01]);
	p.box(0.2, 0.03, 0.06, [0, 0.29, 0.01]);
	p.cyl(0.006, 0.006, 0.2, [0.07, 0.33, 0.04]);
	for (const side of [-1, 1]) {
		p.cyl(0.045, 0.045, 0.04, [side * 0.13, 0.13, -0.01], [0, 0, Math.PI / 2]);
	}
	return p.build();
}

/** Bras entier, rigide, dans le repère de l'épaule. */
export function armGeometry(side) {
	const p = part();
	// La main tombe sur le clavier : 0,36 m devant l'épaule, à hauteur de plateau.
	const elbow = [side * 0.02, -0.13, -0.17];
	const hand = [side * -0.01, -0.23, -0.37];
	p.ball(0.07, [0, 0, 0]);
	p.strut([0, 0, 0], elbow, 0.09, 0.1);
	p.cyl(0.055, 0.055, 0.1, elbow, [0, 0, Math.PI / 2]);
	p.strut(elbow, hand, 0.075, 0.085);
	p.box(0.09, 0.045, 0.12, [hand[0], hand[1] - 0.012, hand[2] - 0.035]);
	return p.build();
}

/** Bandeau lumineux de la visière, dans le repère du cou. */
export function visorGeometry() {
	return part().box(0.2, 0.028, 0.02, VISOR_CENTER).build();
}

/** Même bandeau, centré sur l'origine : le halo se met à l'échelle sans
 *  s'éloigner du visage. */
export function visorHaloGeometry() {
	return part().box(0.2, 0.028, 0.02, [0, 0, 0]).build();
}

/** Cœur lumineux du plastron, dans le repère de la taille. */
export function coreGeometry() {
	const p = part();
	p.box(0.11, 0.06, 0.02, CORE_CENTER);
	p.box(0.02, 0.19, 0.012, [0, 0.3, 0.225]);
	return p.build();
}

export function coreHaloGeometry() {
	return part().box(0.11, 0.06, 0.02, [0, 0, 0]).build();
}

/** Bandeau peint aux couleurs de la famille d'agent : épaulettes et plastron.
 *  C'est ce qui doit se lire depuis l'allée, avant même l'étiquette. */
export function accentGeometry() {
	const p = part();
	for (const side of [-1, 1]) {
		// Épaulette : déborde du carénage d'un centimètre et demi.
		p.box(0.062, 0.072, 0.22, [side * 0.234, 0.5, 0]);
	}
	// Deux bandes de plastron, à la hauteur du regard.
	p.box(0.22, 0.032, 0.02, [0, 0.44, -0.148]);
	p.box(0.17, 0.022, 0.02, [0, 0.365, -0.14]);
	return p.build();
}

/** Pastille du moteur réel, sur le plastron, pour les sessions détournées. */
export function badgeGeometry() {
	return part().box(0.05, 0.05, 0.016, [0.105, 0.315, -0.138]).build();
}

/** Marque du moteur sur le dos du moniteur : le robot assis se cache derrière
 *  son écran, et c'est cette face-là — et elle seule — que l'allée regarde. La
 *  plaque porte donc la marque du moteur, dessinée à la taille du moniteur, et
 *  c'est ce qu'on lit de loin : la salle montre trois symboles, pas cent robots
 *  identiques.
 *
 *  Elle est inclinée comme la dalle et se tient un centimètre derrière elle :
 *  sans cette inclinaison, le haut du moniteur traversait la plaque. */
export function deskTagGeometry() {
	return part().box(0.42, 0.36, 0.012, [0, 1.157, -0.592], [-0.08, 0, 0]).build();
}

/** Pastille du moteur réel, à côté de la marque, sur le même dos de moniteur. */
export function deskBadgeGeometry() {
	return part().box(0.09, 0.09, 0.014, [0.225, 1.16, -0.592]).build();
}

/* --------------------------------------------------------- la plaque de nom */

/** La carte de nom : posée sur le plateau, derrière le moniteur — c'est la
 *  seule bande du bureau que la dalle ne recouvre pas, et la première chose
 *  qu'on voit d'un poste en entrant dans l'allée.
 *
 *  Elle est INCLINÉE à 45°, et c'est tout l'intérêt : à plat, un nom de 1,30 m
 *  vu de l'allée s'écrase à 42 % de sa hauteur et disparaît dès qu'on baisse
 *  l'œil ; debout, il s'efface dès qu'on monte dans la salle. À 45°, la face
 *  vise à mi-chemin entre l'allée et le dessus — 94 % de sa hauteur vu de
 *  l'allée à 25° d'élévation, 71 % vu du dessus. C'est la seule inclinaison qui
 *  se lise des deux endroits d'où l'on regarde un poste.
 *
 *  Le bord bas est posé sur le plateau (y = 0,765) et le haut passe DEVANT le
 *  moniteur, onze centimètres avant sa dalle : la carte s'appuie vers lui sans
 *  jamais le toucher. */
export const PLATE = {
	center: [0, 0.8817, -0.8133],
	tilt: Math.PI / 4,
	yaw: Math.PI,
	w: 1.3,
	d: 0.33
};

/** La face de la plaque, centrée sur son origine — c'est là que se peint le nom. */
export function namePlateGeometry(width = PLATE.w, depth = PLATE.d) {
	return new THREE.PlaneGeometry(width, depth);
}

/** Le socle de la plaque : une barre sombre sur le plateau, dans laquelle la
 *  carte est censée être engagée. Sans elle la carte flotte au-dessus du
 *  bureau — et une carte qui flotte est une étiquette, ce qu'on vient
 *  justement de retirer de la salle. */
export function plateFootGeometry() {
	return part().box(PLATE.w + 0.06, 0.045, 0.12, [0, 0.7875, -0.905]).build();
}

/* ------------------------------------------------------- le voyant au sol */

/** L'anneau de service : un cercle peint au sol autour du poste, qui bat à la
 *  couleur de l'état. C'est LUI qu'on lit du haut de la salle et depuis
 *  l'entrée, quand le voyant du visage n'est qu'un point. */
export function poolRingGeometry(inner = 0.62, outer = 0.86) {
	return new THREE.RingGeometry(inner, outer, 40);
}

/** Le halo de l'anneau : même cercle, plus large, additif — c'est la lumière
 *  que l'anneau pose sur le béton, pas sa peinture. */
export function poolGlowGeometry(inner = 0.30, outer = 1.06) {
	return new THREE.RingGeometry(inner, outer, 40);
}

/** Câble de service : le tortillon qui court du poste au chemin de câbles de
 *  l'allée. Trois segments suffisent à dire « il y a un fil », et c'est ce
 *  genre de détail qui fait qu'une salle a l'air habitée plutôt que posée. */
export function cableGeometry() {
	const p = part();
	p.cyl(0.022, 0.022, 0.9, [0, 0.012, 0.45], [Math.PI / 2, 0, 0], 6);
	p.cyl(0.022, 0.022, 0.34, [0, 0.012, 0.95], [Math.PI / 2 - 0.5, 0, 0], 6);
	return p.build();
}

/* ------------------------------------------------------------------ le mobilier */

/** Poste de travail : plateau, piètement, écran et clavier (repère du robot). */
export function deskGeometry(z, height) {
	const p = part();
	p.box(1.75, 0.05, 1.15, [0, height, z]);
	for (const side of [-1, 1]) {
		p.box(0.06, height, 0.95, [side * 0.78, height / 2, z]);
		p.box(0.42, 0.04, 0.06, [side * 0.78, 0.03, z]);
	}
	// Écran : mât, pied, dalle.
	p.box(0.1, 0.18, 0.12, [0, height + 0.11, z + 0.16]);
	p.box(0.44, 0.03, 0.18, [0, height + 0.02, z + 0.16]);
	p.box(0.66, 0.4, 0.045, [0, height + 0.42, z + 0.16], [-0.08, 0, 0]);
	// Clavier, à portée de main.
	p.box(0.4, 0.025, 0.15, [0, height + 0.04, z + 0.3], [-0.06, 0, 0]);
	return p.build();
}

/** Selle sur piètement à cinq branches. */
export function chairGeometry() {
	const p = part();
	p.box(0.42, 0.06, 0.42, [0, 0.45, 0.02]);
	p.box(0.4, 0.42, 0.06, [0, 0.68, 0.24], [0.12, 0, 0]);
	p.cyl(0.05, 0.05, 0.42, [0, 0.22, 0.02]);
	for (let i = 0; i < 5; i++) {
		const angle = (i / 5) * Math.PI * 2;
		p.box(0.4, 0.035, 0.06, [Math.sin(angle) * 0.2, 0.03, 0.02 + Math.cos(angle) * 0.2], [0, angle, 0]);
	}
	return p.build();
}

/** Placard de stockage : l'armoire à portes du fond de quai, là où dormaient
 *  les robots endormis — un par robot, il n'y a plus qu'une armoire par
 *  machine, et c'est elle qu'on ouvre.
 *
 *  Géométrie UNITAIRE (1 × 1 × 1, origine au sol, face avant en -Z) : c'est
 *  l'instance qui la met aux dimensions du quai. Une armoire étroite et une
 *  large coûtent donc la même géométrie, et la rangée de diodes se place dans
 *  le même repère. */
export function cabinetGeometry() {
	const p = part();
	p.box(1, 0.94, 1, [0, 0.5, 0]);          // corps
	p.box(0.9, 0.06, 0.9, [0, 0.03, 0]);     // socle
	p.box(1.05, 0.05, 1.05, [0, 0.975, 0]);  // chapeau
	// Deux portes en léger relief, chacune avec sa poignée : sans elles,
	// l'armoire n'est qu'un bloc et rien ne dit qu'elle s'ouvre.
	for (const side of [-1, 1]) {
		p.box(0.42, 0.62, 0.03, [side * 0.235, 0.54, -0.5]);
		p.box(0.024, 0.16, 0.024, [side * 0.045, 0.54, -0.525]);
	}
	return p.build();
}

/** Une diode du placard : une par robot endormi, à la couleur de son moteur.
 *  Centrée sur l'origine, l'instance la pose où elle veut. */
export function cabinetLedGeometry() {
	return part().box(0.055, 0.055, 0.022, [0, 0, 0]).build();
}
