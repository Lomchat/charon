// Les plaques de nom : le nom d'un robot, posé sur son bureau.
//
// Il flottait au-dessus des têtes en DOM (`overlay.js`), à taille constante
// quelle que soit la distance — une étiquette d'interface collée sur un lieu.
// Il est maintenant un objet de la salle, incliné sur le plateau derrière le
// moniteur (`geom.js`, `PLATE`), et il BAT : la matière porte la couleur de
// l'état, à la même cadence et avec le même code couleur que le voyant, la
// carrure et l'anneau au sol.
//
// La carte porte deux choses à la fois, et c'est ce qui a décidé de sa toile :
//   — le NOM, à l'encre sur un champ clair, et il la REMPLIT : le nom d'une
//     carte de visite est écrit gros, sinon la carte ne sert à rien. Il se lit
//     de l'allée et du dessus, pas du fond de la salle — à quinze mètres, un
//     nom de 1,30 m fait huit pixels par caractère, aucune police n'y peut
//     rien ;
//   — l'ÉTAT, par la matière : le champ de la toile étant blanc, la couleur de
//     la carte EST celle du voyant (multipliée par le battement). De loin, quand
//     le nom n'est plus qu'une trace, la salle montre donc une pastille de la
//     couleur de l'état sur chaque poste — le même code que la barre latérale.
// Elle s'occulte, en revanche : un poste cache la plaque du poste derrière lui.
//
// La couleur est sur la matière, pas dans les pixels : une carte repeinte à
// chaque battement serait une texture téléversée soixante fois par seconde, par
// robot. Le nom seul déclenche un repeint — et une carte blanche tient dans le
// même dessin qu'une carte sombre, pour un filtre en moins.

import * as THREE from '../vendor/three.module.js';
import { namePlateGeometry } from './geom.js';
import { makeCanvas, toTexture, fit } from './canvas.js';
import { robotName } from './palette.js';

const W = 640;
const H = 160;
/** L'épaisseur du liseré, et la marge que l'encre doit laisser entre lui et
 *  elle. Vingt-six pixels de chaque côté : la carte fait 33 cm de haut, les
 *  lettres en occupent les deux tiers, et il reste de quoi voir le cadre — un
 *  liséré qu'un nom vient toucher ne détache plus rien. */
const MARGIN = 26;
/** L'encre du nom et du liseré : assez sombre pour tenir sur les quatre couleurs
 *  d'état les plus claires (le vert et le bleu), assez bleutée pour appartenir à
 *  la salle plutôt qu'à une imprimante. */
const INK = '#0b1220';
/** La police du nom, et sa graisse. */
const FAMILY = '"DejaVu Sans Mono", monospace';
/** Ce qu'on ajoute à la graisse grasse : un trait du même encre, tracé SOUS les
 *  lettres, qui les épaissit d'autant de chaque côté. Le mono de DejaVu n'a pas
 *  de poids noir — à 9 % de la taille, il en prend un, et les contre-formes
 *  (le trou du « e ») restent ouvertes. C'est ce trait qui fait qu'un nom se lit
 *  du fond de la salle et non seulement de l'allée. */
const WEIGHT = 0.09;
/** La taille à laquelle on mesure pour en déduire celle qui tiendra : les
 *  métriques d'une police sont linéaires, une seule mesure suffit donc — et
 *  elle est prise sur la VRAIE police du navigateur, pas sur une table de
 *  constantes qui mentirait sur la machine d'à côté. */
const REF = 100;
/** En dessous, on ne rétrécit plus : on tronque (`fit`). Un nom de trente
 *  caractères ne doit pas finir en fil de fer. */
const MIN = 34;

/** Au-delà, on rend vraiment la toile : c'est elle qui coûte (400 Ko), et une
 *  salle qui a vu cent robots un jour n'a pas à garder cent plaques vides. */
const SPARE = 24;

/** La plus grande taille où le nom tient dans la carte, trait compris.
 *
 *  Deux murs, et on prend le plus bas : la largeur de la carte (un nom long
 *  descend), et sa hauteur (un nom court ne monte pas au-delà du cadre). On
 *  mesure les deux à `REF` — l'encre réelle, ascendants et jambages compris,
 *  telle que la police du navigateur la dessine — et on ramène le tout à
 *  l'échelle. Le trait de graisse pousse les lettres de `WEIGHT` × la taille
 *  vers l'extérieur : il se paie des deux côtés, donc il entre dans les deux
 *  budgets. */
function nameSize(ctx, text) {
	ctx.font = `bold ${REF}px ${FAMILY}`;
	const metrics = ctx.measureText(text);
	const width = Math.max(1, metrics.width) / REF;
	const height = (
		(Math.max(0, metrics.actualBoundingBoxAscent) || REF * 0.72) +
		Math.max(0, metrics.actualBoundingBoxDescent)
	) / REF;
	return Math.max(MIN, Math.min(
		Math.floor((W - MARGIN * 2) / (width + WEIGHT)),
		Math.floor((H - MARGIN * 2) / (height + WEIGHT))
	));
}

class Plate {
	constructor() {
		const { canvas, ctx } = makeCanvas(W, H);
		this.canvas = canvas;
		this.ctx = ctx;
		// Contrairement aux écrans (`screens.js`), on GARDE les mipmaps : au loin
		// la plaque doit se réduire à une pastille d'une seule couleur, et non
		// faire scintiller ses lettres. Le nom, lui, se lit à la distance où la
		// texture est encore entière — les mipmaps n'y touchent pas.
		this.texture = toTexture(canvas, { anisotropy: 8 });
		this.mesh = new THREE.Mesh(
			namePlateGeometry(),
			new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false })
		);
		this.mesh.matrixAutoUpdate = false;
		this.mesh.frustumCulled = false;
		this.mesh.visible = false;
		this.mesh.userData.sessionId = null;
		this.drawn = null;
		this.stamp = -1;
	}

	draw(session) {
		const ctx = this.ctx;
		// Le champ est BLANC : la matière le multiplie par la couleur de l'état,
		// donc blanc × couleur = la couleur elle-même, exactement celle du voyant
		// (`beaconOf`), et le battement la fait monter et descendre d'un facteur
		// borné à 1 — la carte ne blanchit jamais. Un fond sombre n'aurait donné
		// que des lettres colorées : de loin, une tache noire où l'état ne se
		// devine plus, alors que la carte est justement ce qui doit rester lisible
		// du fond de la salle.
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, W, H);
		// Le liseré est à l'encre, comme le nom : c'est une plaque imprimée, pas
		// une pastille de lumière, et le cadre la détache du plateau clair.
		ctx.strokeStyle = INK;
		ctx.lineWidth = 7;
		ctx.strokeRect(3.5, 3.5, W - 7, H - 7);

		const name = robotName(session);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'alphabetic';

		// Le nom prend toute la carte : c'est la seule mesure qui décide s'il se
		// lit du fond de la salle, et une carte de visite se remplit. Ce qui
		// l'arrête, ce n'est ni un barème ni un cran de taille, c'est la place —
		// largeur du cadre, hauteur du cadre —, et un nom long paie sa longueur.
		const size = nameSize(ctx, name);
		ctx.font = `bold ${size}px ${FAMILY}`;
		// Le trait mange la largeur : ce qu'on rend au nom, c'est la carte moins
		// les marges moins l'épaississement. Un nom qui ne tient pas même à la
		// plus petite taille est tronqué ici, et alors seulement.
		const text = fit(ctx, name, W - MARGIN * 2 - size * WEIGHT);
		const metrics = ctx.measureText(text);
		const ascent = Math.max(0, metrics.actualBoundingBoxAscent) || size * 0.72;
		const descent = Math.max(0, metrics.actualBoundingBoxDescent);
		const y = H / 2 + (ascent - descent) / 2;

		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.lineWidth = Math.max(2, size * WEIGHT);
		ctx.strokeStyle = INK;
		ctx.fillStyle = INK;
		ctx.fillText(text, W / 2, y);
		ctx.strokeText(text, W / 2, y);
		this.texture.needsUpdate = true;
	}

	dispose() {
		this.mesh.geometry.dispose();
		this.mesh.material.dispose();
		this.texture.dispose();
	}
}

export class Plates {
	constructor(scene) {
		this.group = new THREE.Group();
		this.group.name = 'plaques de nom';
		scene.add(this.group);
		// Une plaque par robot DEBOUT, gardée tant qu'il l'est : la toile suit la
		// session, pas le rang dans la file. Un robot qui s'endort rend la sienne
		// au pool, et le robot qui se réveille ailleurs la reprend — la salle ne
		// téléverse donc jamais plus de toiles qu'elle ne compte de robots.
		this.bySession = new Map();
		this.spare = [];
		this.live = [];
		this.frame = 0;
	}

	_make() {
		const plate = new Plate();
		this.group.add(plate.mesh);
		return plate;
	}

	_recycle(plate) {
		plate.mesh.visible = false;
		plate.mesh.userData.sessionId = null;
		plate.drawn = null;
		this.spare.push(plate);
		while (this.spare.length > SPARE) this._forget(this.spare.pop());
	}

	_forget(plate) {
		this.group.remove(plate.mesh);
		plate.dispose();
	}

	/** Les plaques des robots debout. `anchors` vient de `robots.js` : il porte,
	 *  pour chaque robot, la matrice du plateau et la couleur déjà composée —
	 *  l'état et son battement se calculent là-bas, avec ceux du robot, et le
	 *  desk ne les recalcule pas ici : deux calculs d'un même battement finissent
	 *  toujours par diverger d'une image. */
	update(anchors) {
		this.frame++;
		this.live.length = 0;
		for (const anchor of anchors) {
			const session = anchor.session;
			let plate = this.bySession.get(session.id);
			if (!plate) {
				plate = this.spare.pop() ?? this._make();
				this.bySession.set(session.id, plate);
			}
			plate.stamp = this.frame;
			// Le nom seul décide d'un repeint : la couleur, elle, change à chaque
			// image sans qu'on retouche la toile.
			const name = robotName(session);
			if (plate.drawn !== name) {
				plate.drawn = name;
				plate.draw(session);
			}
			plate.mesh.matrix.copy(anchor.matrix);
			plate.mesh.material.color.setHex(anchor.color);
			plate.mesh.userData.sessionId = session.id;
			plate.mesh.visible = true;
			this.live.push(plate.mesh);
		}
		for (const [id, plate] of this.bySession) {
			if (plate.stamp === this.frame) continue;
			this.bySession.delete(id);
			this._recycle(plate);
		}
	}

	/** La plaque sous le rayon, s'il y en a une : c'est le nom qu'on vise.
	 *  Le tri par distance rend la plaque de DEVANT — celle qu'on voit. */
	pick(raycaster) {
		if (!this.live.length) return null;
		const hits = raycaster.intersectObjects(this.live, false);
		return hits.length ? hits[0].object.userData.sessionId ?? null : null;
	}

	dispose() {
		for (const plate of [...this.bySession.values(), ...this.spare]) this._forget(plate);
		this.bySession.clear();
		this.spare.length = 0;
		this.live.length = 0;
		// Le groupe part avec : une salle rebâtie vingt fois laisserait sinon
		// vingt groupes vides dans la scène.
		this.group.removeFromParent();
	}
}
