// La flotte.
//
// Un robot par session, mais un seul jeu de géométries : chaque partie mobile
// est un InstancedMesh dont on réécrit la matrice par robot et par image. Cent
// robots coûtent ainsi une vingtaine d'appels de dessin, et l'animation reste
// une affaire de matrices — pas de graphe de scène à parcourir.
//
// Deux vocabulaires se superposent, et rien d'autre :
//   — la FAMILLE (le moteur) est peinte sur le carénage et MARQUÉE sur le dos
//     du moniteur, face à l'allée ;
//   — l'ÉTAT est une couleur qui bat — celle du robot ENTIER, pas seulement de
//     son voyant —, une posture, et un anneau au sol.
// Le nom, lui, ne se lit pas ici : c'est une carte posée sur le bureau, derrière
// le moniteur (`plates.js`), et ce fichier ne fait que lui passer sa matrice et
// sa couleur — celles du robot, au même battement.
//
// Les robots endormis ne sont pas dessinés du tout. Un dormant n'a pas de
// poste, pas de nom, pas de place au sol : il est rangé dans le placard de sa
// machine (voir `store.js`), et c'est le placard qu'on ouvre.

import * as THREE from '../vendor/three.module.js';
import { DIMS, DESK_Z } from './layout.js';
import * as G from './geom.js';
import { makeCanvas, toTexture, roundRect, logoImage } from './canvas.js';
import { beaconOf, beat, familyOf, engineTint, detourOf, stateOf, askOf, FAMILIES } from './palette.js';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _white = new THREE.Color(0xffffff);
const _shell = new THREE.Color();

/** Palier : les mouvements du robot sont mécaniques, pas organiques. */
const step = (value) => Math.round(value * 3) / 3;

/** Les postures, une par état. La couleur du voyant dit l'état ; la pose le
 *  confirme, et c'est elle qu'on lit de loin quand le voyant n'est qu'un point.
 *  Chaque entrée est la table complète d'une posture — aucune ne se déduit
 *  d'une autre, pour qu'on puisse régler l'une sans toucher aux autres. */
const POSE = {
	// au travail : penché sur l'écran, les deux mains au clavier
	working: {
		lean: -0.24, sway: 0.010, bob: 0.0022, bobSpeed: 26,
		yawAmp: 0.06, yawSpeed: 0.37, pitch: -0.10,
		type: 0.09, typeSpeed: 11, arms: 'type'
	},
	// tâche de fond : penché, frappe très lente
	background: {
		lean: -0.13, sway: 0.020, bob: 0.0018, bobSpeed: 5,
		yawAmp: 0.22, yawSpeed: 0.21, pitch: -0.02,
		type: 0.012, typeSpeed: 1.6, arms: 'type'
	},
	// tour fini, non lu : redressé, mains aux genoux, tête vers l'allée
	unread: {
		lean: -0.02, sway: 0.004, bob: 0.0014, bobSpeed: 9,
		yawAmp: 0.05, yawSpeed: 0.6, pitch: 0.04,
		type: 0, typeSpeed: 0, arms: { x: -0.35 }
	},
	// à l'arrêt : redressé, mains posées, tête qui balaie lentement
	ready: {
		lean: -0.06, sway: 0.020, bob: 0.0016, bobSpeed: 8,
		yawAmp: 0.30, yawSpeed: 0.23, pitch: 0.02,
		type: 0.012, typeSpeed: 1.2, arms: { x: 0 }
	},
	// question posée : une main levée, ouverte vers le ciel
	question: {
		lean: -0.02, sway: 0, bob: 0.0016, bobSpeed: 7,
		yawAmp: 0.04, yawSpeed: 0.5, pitch: 0.03,
		type: 0, typeSpeed: 0, arms: 'ask'
	},
	// permission demandée : les deux mains levées
	permission: {
		lean: -0.02, sway: 0, bob: 0.0016, bobSpeed: 7,
		yawAmp: 0.03, yawSpeed: 0.4, pitch: 0.03,
		type: 0, typeSpeed: 0, arms: 'both'
	},
	// en panne : effondré sur le clavier, tête basse, bras abandonnés devant
	broken: {
		lean: -0.42, sway: 0, bob: 0, bobSpeed: 1,
		yawAmp: 0.02, yawSpeed: 0.2, pitch: -0.18,
		type: 0, typeSpeed: 0, arms: { x: 0.5 }
	},
	// reconnexion : buste droit, tête qui balaie large
	reconnecting: {
		lean: -0.04, sway: 0, bob: 0.0014, bobSpeed: 12,
		yawAmp: 0.52, yawSpeed: 1.6, pitch: 0.03,
		type: 0, typeSpeed: 0, arms: { x: 0 }
	},
	asleep: {
		lean: 0, sway: 0, bob: 0, bobSpeed: 0.5, yawAmp: 0, yawSpeed: 0.14,
		pitch: -0.22, type: 0, typeSpeed: 0, arms: null
	}
};

/** L'état d'une session, traduit en posture. La permission l'emporte sur la
 *  question : c'est le seul cas où le robot lève les deux mains, et ce geste
 *  doit rester rare pour rester lisible. */
export function poseOf(session, options) {
	const state = stateOf(session, options);
	if (state.id === 'question') return askOf(session)?.label === 'permission requested' ? POSE.permission : POSE.question;
	return POSE[state.id] ?? POSE.ready;
}

/** La plaque du dos de moniteur : une surface claire, bordée à la couleur du
 *  moteur, et la marque de Charon dessus. Claire parce que c'est le point le
 *  plus lumineux de chaque poste vu depuis l'allée — dans une salle sombre,
 *  c'est ce qui se lit avant le robot lui-même. */
function drawTag(ctx, family) {
	const S = 256;
	ctx.clearRect(0, 0, S, S);
	ctx.fillStyle = '#eef3fa';
	roundRect(ctx, 10, 10, S - 20, S - 20, 30);
	ctx.fill();
	ctx.lineWidth = 14;
	ctx.strokeStyle = family.css;
	ctx.stroke();
	const image = logoImage(family.logo);
	if (image) ctx.drawImage(image, 46, 46, S - 92, S - 92);
}

/** L'écran d'un robot : allumé quand ça travaille, éteint quand ça dort. */
export function screenColor(session, out) {
	const base = String(session.liveStatus ?? session.status ?? '');
	if (base === 'sleeping') return out.setHex(0x16233a);
	const state = stateOf(session);
	switch (state.id) {
		case 'question': return out.setHex(0xffb84d);
		case 'working': return out.setHex(0xbfe4ff);
		case 'unread': return out.setHex(0x357a63);
		case 'background': return out.setHex(0x2f7787);
		case 'broken': return out.setHex(0x9c3733);
		case 'reconnecting': return out.setHex(0xbb6f2c);
		default: return out.setHex(0x16233a);
	}
}

export class Fleet {
	constructor(scene, capacity = 256) {
		this.scene = scene;
		this.capacity = capacity;

		// C'est l'environnement cuit qui éclaire ces carrures : sans lui, un
		// métal n'a rien à réfléchir et le robot vire à la silhouette noire.
		const shell = new THREE.MeshStandardMaterial({
			color: 0xb3bccb, roughness: 0.46, metalness: 0.34,
			envMapIntensity: 1.25, flatShading: true
		});
		const dark = new THREE.MeshStandardMaterial({
			color: 0x5c6675, roughness: 0.56, metalness: 0.3,
			envMapIntensity: 1.1, flatShading: true
		});
		// Le mobilier — poste, selle — est plus SOMBRE que la carrure du
		// robot. C'est ce qui fait tenir la silhouette : sans cet écart, un robot
		// clair assis à un bureau clair n'est plus qu'une tache pâle sur une
		// autre, et on ne lit plus qui travaille.
		const furniture = new THREE.MeshStandardMaterial({
			color: 0x2b323d, roughness: 0.68, metalness: 0.24,
			envMapIntensity: 0.95, flatShading: true
		});
		const accent = new THREE.MeshStandardMaterial({
			color: 0xffffff, roughness: 0.5, metalness: 0.15,
			envMapIntensity: 1.3, flatShading: true
		});
		// L'anneau au sol est peint : il reçoit la lumière de la salle, il ne
		// l'émet pas. Le halo, lui, est additif — c'est de la lumière.
		const paint = () => new THREE.MeshBasicMaterial({
			transparent: true, opacity: 0.55, depthWrite: false
		});
		const leds = () => new THREE.MeshBasicMaterial({ toneMapped: false });
		const halos = () => new THREE.MeshBasicMaterial({
			transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
			depthWrite: false, toneMapped: false
		});

		const make = (geometry, material, name, shadows = false) => {
			const mesh = new THREE.InstancedMesh(geometry, material, capacity);
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			mesh.frustumCulled = false;
			mesh.count = 0;
			mesh.name = name;
			if (shadows) mesh.castShadow = true;
			scene.add(mesh);
			return mesh;
		};

		this.mesh = {
			legs: make(G.legsGeometry(), shell, 'jambes', true),
			torso: make(G.torsoGeometry(), shell, 'buste', true),
			head: make(G.headGeometry(), shell, 'tête', true),
			armL: make(G.armGeometry(-1), shell, 'bras gauche', true),
			armR: make(G.armGeometry(1), shell, 'bras droit', true),
			accent: make(G.accentGeometry(), accent, 'bandeau'),
			badge: make(G.badgeGeometry(), accent, 'pastille de moteur'),
			deskTag: make(G.deskTagGeometry(), accent, 'marque de famille'),
			deskBadge: make(G.deskBadgeGeometry(), accent, 'pastille de poste'),
			visor: make(G.visorGeometry(), leds(), 'visière'),
			visorHalo: make(G.visorHaloGeometry(), halos(), 'halo de visière'),
			core: make(G.coreGeometry(), leds(), 'cœur'),
			coreHalo: make(G.coreHaloGeometry(), halos(), 'halo de cœur'),
			desk: make(G.deskGeometry(DESK_Z, DIMS.desk.h), furniture, 'poste', true),
			chair: make(G.chairGeometry(), furniture, 'selle', true),
			plateFoot: make(G.plateFootGeometry(), furniture, 'socle de plaque'),
			screen: make(G.screenFaceGeometry(), leds(), 'écran'),
			screenHalo: make(G.screenFaceGeometry(), halos(), 'halo d’écran'),
			// L'anneau de service : ce qu'on lit du haut de la salle.
			ring: make(G.poolRingGeometry(), paint(), 'anneau de service'),
			ringGlow: make(G.poolGlowGeometry(), halos(), 'halo de service'),
			cable: make(G.cableGeometry(), dark, 'câble de service')
		};

		// Le dos du moniteur porte la marque du moteur, et c'est la seule face
		// que l'allée voit d'un robot assis. Une toile par famille — trois
		// textures, pas une par robot —, chacune sur son maillage instancié.
		// `paint` la redessine quand le logo arrive : il vient de Charon, donc
		// du réseau, et il peut manquer à la première image.
		for (const family of FAMILIES) {
			const { canvas, ctx } = makeCanvas(256, 256);
			const texture = toTexture(canvas, { anisotropy: 8 });
			const paint = () => {
				drawTag(ctx, family);
				texture.needsUpdate = true;
			};
			paint();
			logoImage(family.logo, paint);
			this.mesh[`tag:${family.id}`] = make(
				G.deskTagGeometry(),
				new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
				`marque ${family.id}`
			);
		}

		// Ce que la salle doit savoir de chaque robot pour poser une étiquette,
		// une bulle ou un écran texturé.
		this.anchors = { heads: [], screens: [], plates: [] };
		this.bySession = new Map();
	}

	/** Tout rendre : géométries, matières et toiles. La flotte est reconstruite
	 *  à chaque fois que la FORME de la salle change, et une reconstruction qui
	 *  laisse ses textures derrière elle finit par remplir la mémoire du
	 *  navigateur au bout de quelques dizaines de bascules de la flotte. */
	dispose() {
		for (const mesh of Object.values(this.mesh)) {
			this.scene.remove(mesh);
			mesh.geometry.dispose();
			mesh.material.map?.dispose();
			mesh.material.dispose();
			mesh.dispose();
		}
		this.mesh = {};
		this.bySession.clear();
		this.anchors.heads.length = 0;
		this.anchors.screens.length = 0;
		this.anchors.plates.length = 0;
	}

	_grow(capacity) {
		this.capacity = capacity;
		for (const [name, mesh] of Object.entries(this.mesh)) {
			const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
			grown.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			grown.frustumCulled = false;
			grown.count = mesh.count;
			grown.name = mesh.name;
			grown.castShadow = mesh.castShadow;
			this.scene.remove(mesh);
			mesh.dispose();
			this.scene.add(grown);
			this.mesh[name] = grown;
		}
	}

	/** Index stable d'une session : son rang dans l'ordre des identifiants. */
	_index(fleet) {
		const ids = fleet.sessions.map((s) => s.id).sort();
		return new Map(ids.map((id, index) => [id, index]));
	}

	update(fleet, layout, time) {
		if (fleet.sessions.length > this.capacity) this._grow(fleet.sessions.length + 32);
		const index = this._index(fleet);
		// L'état d'une session vit dans le MODÈLE, pas dans le plan. La salle est
		// bâtie une fois et garde, dans `layout.quais[].desks[].session`, l'objet
		// de ce moment-là ; elle n'est pas reconstruite quand une session passe de
		// « au travail » à « fini », et c'est voulu — c'est ce qui permet de
		// repeindre les robots sans rebâtir le hall à chaque battement. Encore
		// faut-il lire l'objet VIVANT : sans cette table, un robot qui finissait
		// son tour restait bleu, et vert seulement à la prochaine reconstruction
		// de la salle (ouverture, endormissement, changement de quai). Le plan ne
		// dit pas l'état, il dit où l'on se tient.
		const live = new Map(fleet.sessions.map((s) => [s.id, s]));
		const n = {};
		for (const name of Object.keys(this.mesh)) n[name] = 0;

		this.anchors.heads.length = 0;
		this.anchors.screens.length = 0;
		this.anchors.plates.length = 0;
		this.bySession.clear();

		/** Pose une matrice et, si la pièce est colorée, sa couleur au même rang.
		 *  La couleur est un entier 0xRRGGBB ou un `THREE.Color` déjà composé —
		 *  le carénage a besoin du second : sa teinte se calcule (mélange avec
		 *  la couleur d'état, battement) et se repose sur cinq pièces. */
		const emit = (name, matrix, color) => {
			const i = n[name];
			const mesh = this.mesh[name];
			mesh.setMatrixAt(i, matrix);
			if (color !== undefined) {
				mesh.setColorAt(i, color.isColor ? color : _color.setHex(color));
			}
			n[name] = i + 1;
		};

		/** Repère du robot : position au sol et cap. */
		const place = (x, z, yaw) => {
			_eu.set(0, yaw, 0);
			_q.setFromEuler(_eu);
			_m.compose(_v.set(x, 0, z), _q, _one);
			return _m;
		};

		/** Repère d'une pièce mobile : pivot du robot, décalage, rotation propre. */
		const joint = (base, local, rotation, scale) => {
			_eu.set(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0);
			_q.setFromEuler(_eu);
			_m2.compose(_v.set(local[0], local[1], local[2]), _q, scale ?? _one);
			return _m3.multiplyMatrices(base, _m2);
		};

		/** L'anneau au sol : posé à plat, jamais en relief. Le halo suit la même
		 *  cadence, un peu plus large quand le voyant monte — c'est la lumière
		 *  que l'anneau pose sur le béton, pas sa peinture. Un état sans
		 *  pulsation garde son anneau fixe : c'est ce qui le distingue. */
		const ring = (name, glowName, x, z, state, tint, slot, t, scale = 1) => {
			const pulse = beat(state, t + (slot % 7) * 0.11);
			_eu.set(-Math.PI / 2, 0, 0);
			_q.setFromEuler(_eu);
			_m2.compose(_v.set(x, 0.018, z), _q, _one);
			emit(name, _m2, _color.setHex(tint).multiplyScalar(0.5 + 0.5 * pulse).getHex());
			const spread = scale * (1 + pulse * 0.16);
			_scale.set(spread, spread, 1);
			_m3.compose(_v.set(x, 0.014, z), _q, _scale);
			emit(glowName, _m3, _color.setHex(tint).multiplyScalar(0.16 + 0.66 * pulse).getHex());
		};

		for (const quai of layout.quais) {
			/* ------------------------------------------- les robots au poste */
			for (const desk of quai.desks) {
				// Le poste est celui du plan, la session est celle du modèle : le
				// plan ne connaît que des identifiants, et n'a pas à vieillir.
				const session = live.get(desk.session.id) ?? desk.session;
				const slot = index.get(session.id) ?? 0;
				const base = place(desk.x, desk.z, desk.yaw);
				const t = time + (slot % 17) * 0.37;

				const state = stateOf(session);
				const beacon = beaconOf(session);
				const pose = poseOf(session);
				const working = state.id === 'working' || state.id === 'background';
				const pending = state.id === 'question';
				const pulse = beat(state, t + (slot % 7) * 0.11);
				const vivid = 0.42 + 0.58 * pulse;
				// Le gain du battement : ce que vaut la couleur de l'état à cet
				// instant. Le carénage s'en sert ; la plaque de nom bat à la même
				// cadence, avec son propre gain borné à 1 — sa toile est BLANCHE,
				// c'est la matière qui la teint, et un gain au-dessus de 1 ferait
				// blanchir la carte à chaque pointe. Le sommet de son battement vaut
				// donc exactement la couleur du voyant, et le robot, lui, la dépasse
				// d'un tiers : c'est le robot qui pulse, la plaque qui le dit.
				const gain = state.pulse ? 0.72 + 0.58 * pulse : 0.86;
				const plateGain = state.pulse ? 0.55 + 0.45 * pulse : 1;
				const family = familyOf(session.kind);
				const detour = detourOf(session);

				// Le battement peint le robot ENTIER. La couleur de l'état
				// recouvre le carénage, des pieds à la tête, et son intensité
				// suit le même battement que le voyant : c'est ce qui se lit du
				// fond de la salle, quand le voyant n'est plus qu'un point.
				//
				// Au repos la teinte demeure, plus discrète : un robot sans rien
				// à signaler ne s'efface pas, il s'éclaire à la couleur de son
				// moteur — la salle reste lisible même immobile.
				_shell
					.copy(_white)
					.lerp(_color.setHex(beacon.hex), 0.24 + 0.62 * pulse)
					.multiplyScalar(gain);

				emit('legs', joint(base, [0, 0, 0], {}), _shell);

				const bob = Math.sin(t * pose.bobSpeed) * pose.bob;
				const torsoRotation = { x: pose.lean, z: Math.sin(t * 3.1) * pose.sway * 0.06 };
				const torsoMatrix = joint(base, [0, G.PIVOT.torso[1] + bob, G.PIVOT.torso[2]], torsoRotation);
				const torso = torsoMatrix.clone();
				emit('torso', torso, _shell);
				// Visière et cœur portent déjà leur position : le halo, lui, est
				// centré sur l'origine et reçoit le décalage. Les confondre
				// faisait flotter le voyant dix centimètres devant le visage.
				emit('core', torso, _color.setHex(beacon.hex).multiplyScalar(0.35 + 0.65 * vivid).getHex());
				const corePulse = 1.15 + pulse * 0.5;
				emit('coreHalo', joint(torso, G.CORE_CENTER, {}, _v.set(corePulse, corePulse, 1).clone()),
					_color.setHex(beacon.hex).multiplyScalar(0.25 + 0.55 * pulse).getHex());
				emit('accent', joint(torso, [0, 0, 0], {}), family.hex);
				// Une session détournée porte la pastille de son vrai moteur.
				if (detour) {
					emit('badge', joint(torso, [0, 0, 0], {}), engineTint(detour.label).hex);
				}

				const headLocal = [
					G.PIVOT.head[0] - G.PIVOT.torso[0],
					G.PIVOT.head[1] - G.PIVOT.torso[1],
					G.PIVOT.head[2] - G.PIVOT.torso[2]
				];
				const headRotation = {
					y: step(Math.sin(t * pose.yawSpeed)) * pose.yawAmp,
					x: pose.pitch + Math.sin(t * 0.23) * 0.02
				};
				const headMatrix = joint(torso, headLocal, headRotation);
				const head = headMatrix.clone();
				emit('head', head, _shell);
				emit('visor', head, _color.setHex(beacon.hex).multiplyScalar(0.4 + 0.6 * vivid).getHex());
				const visorPulse = 1.15 + pulse * 0.7 + (pending ? 0.35 : 0);
				emit('visorHalo', joint(head, G.VISOR_CENTER, {}, _v.set(visorPulse, visorPulse, 1).clone()),
					_color.setHex(beacon.hex).multiplyScalar(0.22 + 0.5 * pulse).getHex());

				// Les bras suivent la posture : frappe, repos, ou main levée.
				for (const [name, side, pivot] of [
					['armL', -1, G.PIVOT.shoulderL],
					['armR', 1, G.PIVOT.shoulderR]
				]) {
					const local = [pivot[0], pivot[1] - G.PIVOT.torso[1], pivot[2]];
					if (pose.arms === 'ask' || pose.arms === 'both') {
						// Main ouverte vers le ciel : c'est le seul geste volontaire
						// de la salle, il doit se voir du fond de l'allée. La levée
						// se fait autour de X — autour de Z, le bras partait de
						// côté et la main ne montait que de cinq centimètres.
						if (pose.arms === 'both' || side > 0) {
							emit(name, joint(torso, local, {
								x: 1.55 + Math.sin(t * 1.6) * 0.08, z: side * 0.3
							}), _shell);
						} else {
							emit(name, joint(torso, local, { x: 0 }), _shell);
						}
					} else if (pose.arms === 'type') {
						// Frappe mécanique : des créneaux, pas des sinusoïdes.
						const phase = t * pose.typeSpeed + (side > 0 ? Math.PI : 0);
						const hit = Math.sign(Math.sin(phase)) * 0.5 + 0.5;
						emit(name, joint(torso, local, { x: -hit * pose.type }), _shell);
					} else if (pose.arms) {
						emit(name, joint(torso, local, { x: pose.arms.x }), _shell);
					}
				}

				// Le poste, la selle, l'écran. La marque est posée sur le dos du
				// moniteur : de l'allée, c'est la seule face qu'on voit du robot.
				emit('desk', base.clone());
				emit('chair', base.clone());
				emit(`tag:${family.id}`, base.clone());
				if (detour) {
					emit('deskBadge', base.clone(), engineTint(detour.label).hex);
				}
				const screenMatrix = joint(base, G.SCREEN.center, { x: G.SCREEN.tilt });
				const screen = screenMatrix.clone();
				emit('screen', screen, screenColor(session, _color).getHex());
				const glow = working ? 1.5 : state.id === 'unread' ? 1.12 : 0.9;
				emit('screenHalo', joint(base, G.SCREEN.center, { x: G.SCREEN.tilt },
					_v.set(glow, glow, 1).clone()), screenColor(session, _color).getHex());

				// L'anneau de service, au sol, autour du poste : c'est lui qu'on
				// lit du haut de la salle et depuis l'entrée. Sa couleur est
				// celle du voyant, donc de l'état.
				ring('ring', 'ringGlow', desk.x, desk.z, state, beacon.hex, slot, t, 1);
				emit('cable', base.clone());
				// Le socle de la plaque, puis la plaque elle-même : elle est
				// texturée, donc à part (`plates.js`) — on ne lui passe que sa
				// matrice et la couleur du battement, composée ici.
				emit('plateFoot', base.clone());

				const anchor = new THREE.Vector3(desk.x, 1.52, desk.z);
				this.bySession.set(session.id, { session, anchor, index: slot, asleep: false, screen, state, beacon });
				this.anchors.heads.push({ session, position: anchor, index: slot, asleep: false, state, beacon });
				this.anchors.screens.push({ session, index: slot, matrix: screen });
				this.anchors.plates.push({
					session,
					matrix: joint(base, G.PLATE.center, { x: G.PLATE.tilt, y: G.PLATE.yaw }).clone(),
					color: _color.setHex(beacon.hex).multiplyScalar(plateGain).getHex()
				});
			}

			/* -------------------------------------- les robots en veille */
			// Il n'y en a plus dans la salle, et c'est le seul endroit où la
			// flotte dit non : aucun nœud n'est posé pour une session endormie.
			// Un dormant n'a ni poste, ni nom, ni voyant — il est rangé dans le
			// placard de sa machine (`store.js`), et c'est le placard qu'on
			// ouvre. Un robot debout dans une alvéole disait « je suis là » sans
			// jamais rien dire de plus, et peuplait l'allée de figurants.
		}

		for (const [name, mesh] of Object.entries(this.mesh)) {
			mesh.count = n[name] ?? 0;
			mesh.instanceMatrix.needsUpdate = true;
			if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
		}
	}

	/** Le robot le plus proche d'un point, pour les bulles et les étiquettes. */
	nearest(point, maxDistance = Infinity) {
		let best = null;
		let bestDistance = maxDistance;
		for (const entry of this.bySession.values()) {
			const distance = entry.anchor.distanceTo(point);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = entry;
			}
		}
		return best;
	}
}
