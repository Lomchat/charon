// Les écrans des robots.
//
// Un écran par robot coûterait cent textures ; on n'en dessine donc que
// quelques-uns, ceux qui sont assez près pour qu'on lise. Le reste de la salle
// se contente de la dalle allumée, qui dit déjà l'état et la couleur.
//
// Ce qu'on lit dessus est le dernier fait que Charon a rapporté pour cette
// session — pas une reconstitution. Le desk ne fabrique aucun texte : quand il
// n'a rien reçu, l'écran dit « — ».
//
// Depuis que la marque du moteur est dessus, l'écran se lit à deux distances :
// de loin c'est une tache de la couleur du moteur avec son symbole — trois
// formes reconnaissables dans toute la salle —, de près c'est la session qui
// raconte ce qu'elle vient de faire.

import * as THREE from '../vendor/three.module.js';
import { makeCanvas, toTexture, roundRect, fit, ago, logoImage } from './canvas.js';
import { actionWord, beaconOf, familyOf, robotName, statusWord } from './palette.js';
import { preview } from './text.js';

const W = 320;
const H = 190;
const FRAME = 7;     // l'épaisseur du cadre, à la couleur du moteur
const PLATE = 104;   // le côté de la plaque claire qui porte la marque

// Temporaires de la boucle : `update` tourne à chaque image sur toute la flotte.
const _at = new THREE.Vector3();
const _nudge = new THREE.Matrix4().makeTranslation(0, 0, 0.004);

class Screen {
	constructor() {
		const { canvas, ctx } = makeCanvas(W, H);
		this.canvas = canvas;
		this.ctx = ctx;
		this.texture = toTexture(canvas, { anisotropy: 8 });
		this.texture.minFilter = THREE.LinearFilter;
		this.mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(0.64, 0.38),
			new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false })
		);
		this.mesh.matrixAutoUpdate = false;
		this.mesh.frustumCulled = false;
		this.mesh.visible = false;
		this.drawn = null;
	}

	draw(session, action) {
		const ctx = this.ctx;
		const family = familyOf(session.kind);
		const beacon = beaconOf(session);
		const last = action ?? { kind: 'idle' };

		ctx.fillStyle = '#070b11';
		ctx.fillRect(0, 0, W, H);

		// Le cadre prend la couleur du moteur. De loin, l'écran est une tache
		// orange, verte ou violette avant d'être un texte : c'est la famille
		// qu'on lit en premier, et c'est ce qu'on vient chercher de l'autre bout
		// de l'allée.
		ctx.fillStyle = family.css;
		ctx.fillRect(0, 0, W, FRAME);
		ctx.fillRect(0, H - FRAME, W, FRAME);
		ctx.fillRect(0, 0, FRAME, H);
		ctx.fillRect(W - FRAME, 0, FRAME, H);

		/* -------------------------------------------------------- la marque */
		// Sur une plaque claire, à gauche : c'est le point le plus lumineux de la
		// salle, et il doit se voir du fond. Le logo vient de Charon — tant qu'il
		// n'est pas arrivé, c'est la couleur du moteur qui tient la place.
		const px = FRAME + 9;
		const py = Math.round((H - PLATE) / 2) - 8;
		ctx.fillStyle = '#eef3fa';
		roundRect(ctx, px, py, PLATE, PLATE, 13);
		ctx.fill();
		const image = logoImage(family.logo);
		if (image) {
			ctx.drawImage(image, px + 9, py + 9, PLATE - 18, PLATE - 18);
		} else {
			ctx.fillStyle = family.css;
			roundRect(ctx, px + 26, py + 26, PLATE - 52, PLATE - 52, 12);
			ctx.fill();
		}

		/* ------------------------------------------------------- les mots */
		const x = px + PLATE + 13;
		const room = W - FRAME - 8 - x;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';

		ctx.font = 'bold 16px "DejaVu Sans Mono", monospace';
		ctx.fillStyle = '#dce8f5';
		ctx.fillText(fit(ctx, robotName(session), room), x, 27);

		ctx.font = '13px "DejaVu Sans Mono", monospace';
		ctx.fillStyle = beacon.css;
		ctx.fillText(fit(ctx, statusWord(session), room), x, 49);

		ctx.font = '12px "DejaVu Sans Mono", monospace';
		ctx.fillStyle = '#63788f';
		ctx.fillText(fit(ctx, actionWord(last), room), x, 74);

		ctx.font = '14px "DejaVu Sans Mono", monospace';
		ctx.fillStyle = last.kind === 'error' ? '#ff8a7a' : '#c6dcf0';
		const lines = [];
		let line = '';
		for (const word of preview(last.detail, 90).split(' ')) {
			const candidate = line ? `${line} ${word}` : word;
			if (ctx.measureText(candidate).width <= room) line = candidate;
			else { if (line) lines.push(line); line = word; }
			if (lines.length === 3) break;
		}
		if (line && lines.length < 3) lines.push(line);
		if (!lines.length) lines.push('—');
		lines.forEach((text, i) => ctx.fillText(fit(ctx, text, room), x, 97 + i * 19));

		// Le pied : depuis quand. Il change de minute en minute, pas de seconde
		// en seconde : c'est la cadence à laquelle l'écran se redessine quand
		// rien ne s'y passe.
		const working = beacon.state.id === 'working';
		ctx.font = '11.5px "DejaVu Sans Mono", monospace';
		ctx.fillStyle = '#4d6379';
		ctx.fillText(ago(last.at ?? session.lastActivityMs), FRAME + 9, H - FRAME - 15);
		if (working && Math.floor(Date.now() / 450) % 2 === 0) {
			ctx.fillStyle = family.css;
			ctx.fillRect(W - FRAME - 22, H - FRAME - 21, 11, 13);
		}

		// La jauge d'état, sous le cadre : elle dit ce que la couleur bat.
		ctx.fillStyle = beacon.css;
		ctx.globalAlpha = 0.8;
		ctx.fillRect(0, H - 4, W * (working ? 0.72 : 0.28), 3);
		ctx.globalAlpha = 1;

		// Balayage : deux lignes sombres, comme un vieil écran.
		ctx.fillStyle = 'rgba(0,0,0,0.13)';
		for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);

		this.texture.needsUpdate = true;
	}
}

export class Screens {
	constructor(scene, max = 26) {
		this.group = new THREE.Group();
		this.group.name = 'écrans';
		scene.add(this.group);
		this.pool = [];
		for (let i = 0; i < max; i++) {
			const screen = new Screen();
			this.group.add(screen.mesh);
			this.pool.push(screen);
		}
	}

	/** Les écrans lisibles : les plus proches de la caméra, plafonnés.
	 *
	 *  La portée est large — la marque du moteur doit se reconnaître d'un bout à
	 *  l'autre de la salle —, mais elle reste bornée : au-delà, la dalle fait
	 *  quelques pixels et une toile de plus ne serait qu'une texture à téléverser
	 *  pour rien. */
	update(anchors, camera, actions, { maxDistance = 52, pinned = null } = {}) {
		const candidates = anchors
			.map((anchor) => ({
				anchor,
				// La matrice de la dalle porte sa position : on la lit dans un
				// vecteur réutilisé plutôt que d'en allouer un par robot et par
				// image — à cent robots, c'est cent objets par image jetés.
				distance: camera.position.distanceTo(
					_at.setFromMatrixPosition(anchor.matrix)
				)
			}))
			.filter((item) => item.distance < maxDistance || item.anchor.session.id === pinned)
			.sort((a, b) => {
				if (a.anchor.session.id === pinned) return -1;
				if (b.anchor.session.id === pinned) return 1;
				return a.distance - b.distance;
			})
			.slice(0, this.pool.length);

		// Les écrans s'effacent quand on s'éloigne, sans à-coup.
		for (const screen of this.pool) screen.wanted = false;
		candidates.forEach((item, i) => {
			const screen = this.pool[i];
			screen.wanted = true;
			const session = item.anchor.session;
			const action = actions?.get(session.id) ?? null;
			// La minute, pas la seconde : un écran qui ne travaille pas ne se
			// redessine que quand son texte change vraiment. Seul le curseur
			// clignotant d'une session au travail demande une toile par seconde.
			const signature = [
				session.liveStatus ?? session.status,
				session.unreadStop ? 1 : 0,
				session.pendingPermissions ?? 0,
				action?.kind, action?.tool, action?.at, action?.detail,
				session.kind,
				Math.floor(Date.now() / 60000)
			].join('|');
			const blink = beaconOf(session).state.id === 'working';
			const tick = blink ? Math.floor(Date.now() / 1000) : 0;
			if (screen.drawn !== signature || tick !== screen.second) {
				screen.second = tick;
				screen.drawn = signature;
				screen.draw(session, action);
			}
			// 4 mm devant la dalle, pour ne pas se battre avec elle.
			screen.mesh.matrix.copy(item.anchor.matrix).multiply(_nudge);
			screen.mesh.visible = true;
		});

		this.pool.forEach((screen) => {
			if (!screen.wanted) screen.mesh.visible = false;
		});
	}
}
