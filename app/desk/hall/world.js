// Le monde : la salle, la flotte, les plaques de nom, la caméra.
//
// C'est la seule pièce qui connaisse à la fois Three.js et la forme des données
// de Charon. Elle ne décide de rien : elle reçoit une flotte
// (`{ sessions, vps, folders }`), la pose, et rend une image. Tout ce qui
// touche au métier — qui bat, de quelle couleur, pour quelle raison — est
// décidé par `palette.js`, qui importe les règles de Charon.
//
// La boucle de rendu ne s'arrête jamais d'elle-même : elle s'endort quand
// l'onglet passe en arrière-plan, parce qu'une salle vide qui tourne à 60
// images par seconde sur un portable, c'est une batterie pour rien.

import * as THREE from '../vendor/three.module.js';
import { Camera } from './camera.js';
import { Fleet } from './robots.js';
import { Stores } from './store.js';
import { Screens } from './screens.js';
import { Plates } from './plates.js';
import { Overlay } from './overlay.js';
import { buildEnvironment } from './env.js';
import { buildHall } from './hall.js';
import { computeLayout, findStation, PATH_LEVEL_Y } from './layout.js';
import { toScreen } from './project.js';

/** L'élévation sous laquelle l'œil rase la salle.
 *
 *  Le nom d'un chemin est peint à plat sur le plancher du quai, devant sa file :
 *  c'est la vue du dessus qui le lit. Sous cet angle, une peinture s'écrase en
 *  quelques pixels de haut et le titre flottant reprend le relais ; au-dessus,
 *  le sol parle seul, et un titre de plus ne ferait que couvrir le nom qu'il
 *  double — les deux textes se répondent, l'un sur le plancher, l'autre dans le
 *  ciel, à la verticale l'un de l'autre. */
const TITLE_PHI = 0.4;

/** Ce qui, dans la flotte, change la SALLE (et non ce qu'elle raconte).
 *  Une session qui s'endort quitte son poste, et l'armoire de sa machine
 *  change de taille : la salle bouge. Une session qui passe de « au travail » à
 *  « fini » ne bouge pas — il serait absurde de reconstruire le hall dix fois
 *  par minute pour si peu. */
function layoutSignature(fleet) {
	const parts = [
		`v:${fleet.vps.map((v) => `${v.id}/${v.folderId}`).join(',')}`,
		`f:${fleet.folders.map((f) => f.id).join(',')}`
	];
	const seats = fleet.sessions
		.map((s) => `${s.id}:${s.vpsId}:${String(s.liveStatus ?? s.status) === 'sleeping' ? 'z' : 'a'}`)
		.sort();
	parts.push(`s:${seats.join(',')}`);
	return parts.join('|');
}

export class World {
	constructor(container, { onOpen, onHover, onStore } = {}) {
		this.container = container;
		this.onOpen = onOpen;
		this.onHover = onHover;
		/** Un placard de stockage qu'on ouvre : la liste des robots endormis de
		 *  cette machine. La salle ne la connaît pas — elle dit seulement quel
		 *  quai on a visé. */
		this.onStore = onStore;

		this.renderer = new THREE.WebGLRenderer({
			antialias: true,
			alpha: false,
			powerPreference: 'high-performance'
		});
		this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.14;
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.domElement.className = 'desk-canvas';
		container.appendChild(this.renderer.domElement);

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x080b11);
		this.scene.fog = new THREE.Fog(0x080b11, 60, 190);

		this.camera3 = new THREE.PerspectiveCamera(50, 1, 0.1, 400);

		this.environment = buildEnvironment(this.renderer);
		this.scene.environment = this.environment.texture;

		this.fleet = null;
		this.hall = null;
		this.layout = null;
		this.signature = '';
		this.screens = null;
		this.overlay = new Overlay(this.renderer.domElement.parentNode);
		this.actions = new Map();
		this.model = { sessions: [], vps: [], folders: [] };

		// Le halo de sélection : un anneau net au sol et une colonne de lumière
		// très douce. C'est ce qui dit « c'est celui-là que tu regardes » quand
		// la souris traîne au-dessus de vingt robots identiques.
		this.selection = new THREE.Group();
		const ringMaterial = new THREE.MeshBasicMaterial({
			color: 0xffffff, transparent: true, opacity: 0.85,
			side: THREE.DoubleSide, depthWrite: false
		});
		this.selectionRing = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.80, 48), ringMaterial);
		this.selectionRing.rotation.x = -Math.PI / 2;
		this.selectionRing.position.y = 0.028;
		const beamMaterial = new THREE.MeshBasicMaterial({
			color: 0xffffff, transparent: true, opacity: 0.06,
			blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
		});
		this.selectionBeam = new THREE.Mesh(
			new THREE.CylinderGeometry(0.62, 0.62, 3.4, 20, 1, true), beamMaterial
		);
		this.selectionBeam.position.y = 1.7;
		this.selection.add(this.selectionRing, this.selectionBeam);
		this.selection.visible = false;
		this.scene.add(this.selection);

		this.selectedId = null;
		this.hoveredId = null;
		/** Le quai dont le placard est sous le curseur. Deux sélections
		 *  parallèles : un robot, ou une armoire — jamais les deux. */
		this.hoveredStore = null;
		this.stores = null;
		this.raycaster = new THREE.Raycaster();
		this._ndc = new THREE.Vector2();
		this._pointer = null;
		this.clock = new THREE.Clock();
		this.running = false;
		/** Vrai dès que la première salle a été posée : c'est elle, et elle
		 *  seule, qui a le droit de placer la caméra. */
		this.placed = false;
		this.frameCount = 0;
		this.lastStats = { fps: 0, at: 0 };

		this.controller = new Camera(this.camera3, this.renderer.domElement, {
			bounds: { minX: -30, maxX: 30, minZ: -20, maxZ: 20 }
		});
		this.controller.onClick = (event) => this._click(event);

		// Le survol : on ne garde que le dernier événement, et c'est la boucle de
		// rendu qui résout le robot sous le curseur — une fois par image, pas une
		// fois par pixel parcouru.
		this._onPointerMove = (event) => { this._pointer = event; };
		this._onPointerLeave = () => { this._pointer = null; };
		this.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
		this.renderer.domElement.addEventListener('pointerleave', this._onPointerLeave);

		this._resize = () => this.resize();
		this.observer = new ResizeObserver(this._resize);
		this.observer.observe(container);
		this._onVisibility = () => {
			if (document.hidden) this.stop();
			else this.start();
		};
		document.addEventListener('visibilitychange', this._onVisibility);
		this.resize();
	}

	/* ---------------------------------------------------------------- cycle */

	resize() {
		const width = this.container.clientWidth || 1;
		const height = this.container.clientHeight || 1;
		this.renderer.setSize(width, height, false);
		this.camera3.aspect = width / height;
		this.camera3.updateProjectionMatrix();
	}

	/** La flotte a changé (SSE, sondage, ou état initial). On ne reconstruit la
	 *  salle que si sa FORME a changé ; sinon, on met à jour le récit. */
	update(model, actions) {
		this.model = model;
		if (actions) this.actions = actions;

		const signature = layoutSignature(model);
		if (signature !== this.signature) {
			this.signature = signature;
			this._rebuild(model);
		}
	}

	_rebuild(model) {
		if (this.hall) {
			this.hall.dispose();
			this.hall = null;
		}
		if (this.stores) {
			this.stores.dispose();
			this.stores = null;
		}
		if (this.fleet) {
			this.fleet.dispose();
			this.fleet = null;
		}
		if (this.screens) {
			this.scene.remove(this.screens.group);
			for (const screen of this.screens.pool) {
				screen.mesh.geometry.dispose();
				screen.mesh.material.dispose();
				screen.texture.dispose();
			}
			this.screens = null;
		}
		if (this.plates) {
			this.plates.dispose();
			this.plates = null;
		}
		this.hoveredId = null;
		this.hoveredStore = null;

		this.layout = computeLayout(model);
		// Les titres de chemin : une ancre par file, devant son premier poste.
		// Rien à peindre ici — c'est de la place, l'habillage s'en sert.
		this.pathAnchors = this.layout.quais.flatMap((quai) => quai.levels.map((level) => ({
			key: `${quai.id}:${level.path}`,
			path: level.path,
			count: level.count,
			position: new THREE.Vector3(level.title.x, PATH_LEVEL_Y, level.title.z)
		})));
		this.hall = buildHall(this.scene, this.layout, this.renderer.capabilities.getMaxAnisotropy());
		this.controller.bounds = this.layout.bounds;
		this.fleet = new Fleet(this.scene, Math.max(32, model.sessions.length + 32));
		this.stores = new Stores(this.scene, this.layout);
		this.screens = new Screens(this.scene, 26);
		// Les plaques de nom : une toile par robot debout, contre une seule pour
		// les écrans — un écran se lit de près, un nom doit être là de partout.
		this.plates = new Plates(this.scene);

		// La toute première salle se présente d'elle-même : on se pose à
		// l'entrée, d'où l'allée et les deux rangées sont lisibles. Les
		// reconstructions suivantes ne touchent plus à la caméra — la déplacer
		// sous la main de quelqu'un qui regarde un poste serait une trahison.
		if (!this.placed) {
			this.placed = true;
			this.recenter();
		}

		this.onLayout?.(this.layout);
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.clock.getDelta();
		const loop = () => {
			if (!this.running) return;
			this._frame();
			this.raf = requestAnimationFrame(loop);
		};
		this.raf = requestAnimationFrame(loop);
	}

	stop() {
		this.running = false;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = null;
	}

	/** Les rectangles de l'habillage qui traînent EN BAS de l'écran, en
	 *  coordonnées de la toile — la barre d'aide, pour l'essentiel.
	 *
	 *  Un titre de file ne sait s'écarter que vers le haut (`overlay.js`). Cela
	 *  tombe bien pour ce qui est posé au sol de l'écran : un titre sous la
	 *  barre d'aide remonte d'un cran et se lit. Cela tombe mal pour ce qui est
	 *  posé en haut : un titre sous la carte des compteurs ne remonterait que
	 *  pour sortir du cadre, et un titre à moitié couvert vaut mieux qu'un titre
	 *  absent. Seul le bas est donc déclaré comme obstacle. Mesuré une fois par
	 *  image sur les quelques cartes de l'habillage, pas sur chaque titre. */
	_chrome() {
		const host = this.container.parentNode;
		if (!host) return [];
		const rect = this.container.getBoundingClientRect();
		const out = [];
		for (const element of host.querySelectorAll('.desk-hud .dsk-card, .desk-hud .dsk-hint')) {
			// Un habillage masqué (le modal est ouvert) ne réserve rien.
			if (!element.offsetParent) continue;
			const r = element.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) continue;
			if (r.top - rect.top < rect.height * 0.45) continue;
			out.push({
				x0: r.left - rect.left,
				x1: r.right - rect.left,
				y0: r.top - rect.top,
				y1: r.bottom - rect.top
			});
		}
		return out;
	}

	_frame() {
		const delta = Math.min(0.05, this.clock.getDelta());
		const now = this.clock.elapsedTime;
		if (!this.layout) return;

		this.fleet.update(this.model, this.layout, now);
		// Les noms peints au sol se retournent vers le visiteur : c'est la seule
		// chose de la salle qui dépende de l'endroit d'où on regarde.
		this.hall?.faceCamera(this.camera3);
		this.stores?.update(now);
		// Le survol se résout ici, une fois par image, sur le dernier mouvement
		// connu : projeter trente têtes à chaque `pointermove` d'une souris à
		// 1000 Hz serait du travail jeté.
		if (this._pointer && this.controller.inputEnabled) this.hover(this._pointer);
		this.controller.update(delta);

		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		this.screens.update(
			this.fleet.anchors.screens,
			this.camera3,
			this.actions,
			{ maxDistance: 52, pinned: this.selectedId }
		);

		this._paintSelection(now);
		// Les noms sont des plaques posées sur les bureaux : leur place ne se
		// négocie pas à l'écran, elle est dans la salle. Il ne reste donc à
		// l'habillage que ce qui ne peut pas y être — les titres de file, qui
		// n'existent que sous l'angle rasant, et les bulles en vol.
		this.plates.update(this.fleet.anchors.plates);
		const placed = this._chrome();
		// Les titres de chemin ne se lèvent que sous l'angle rasant : partout
		// ailleurs, le nom est peint à plat sur le plancher du quai, et un titre
		// ne ferait que doubler celui qu'on lit déjà.
		const titles = this.controller.phi < TITLE_PHI ? this.pathAnchors : [];
		this.overlay.drawPaths(titles, this.camera3, width, height, placed);
		// Le nom du robot sous la souris : la salle ne le dit qu'à ses pieds, et
		// de loin on désigne un robot du bout du hall. Rien quand la souris a
		// quitté la toile ou que le modal a pris le clavier — un nom qui traîne
		// au-dessus d'une tête qu'on ne vise plus serait un contresens.
		const under = this._pointer && this.controller.inputEnabled ? this.hoveredId : null;
		this.overlay.drawHover(
			under ? this.fleet.bySession.get(under) ?? null : null,
			this.camera3, width, height
		);
		this.overlay.updateBubbles(delta, this.camera3, width, height);

		this.renderer.render(this.scene, this.camera3);

		this.frameCount++;
		if (now - this.lastStats.at > 1) {
			this.lastStats = { fps: this.frameCount / Math.max(1e-3, now - this.lastStats.at), at: now };
			this.frameCount = 0;
			this.onStats?.(this.lastStats.fps);
		}
	}

	_paintSelection(t) {
		const id = this.hoveredId ?? this.selectedId;
		const entry = id ? this.fleet.bySession.get(id) : null;
		if (!entry) {
			this.selection.visible = false;
			return;
		}
		const beacon = entry.beacon;
		const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
		this.selection.visible = true;
		this.selection.position.set(entry.anchor.x, 0, entry.anchor.z);
		this.selectionRing.material.color.setHex(beacon.hex);
		this.selectionRing.material.opacity = this.hoveredId ? 0.95 : 0.6 + 0.25 * pulse;
		this.selectionBeam.material.color.setHex(beacon.hex);
		this.selectionBeam.material.opacity = 0.035 + 0.03 * pulse;
	}

	/* ------------------------------------------------------------- sélection */

	/** Le rayon sous un événement de pointeur : deux usages en ont besoin — la
	 *  visée d'une armoire et celle d'une plaque de nom —, et il n'y a qu'un
	 *  raycaster et qu'un vecteur NDC dans la salle. */
	_ray(event) {
		const rect = this.renderer.domElement.getBoundingClientRect();
		this._ndc.set(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1
		);
		this.raycaster.setFromCamera(this._ndc, this.camera3);
		return this.raycaster;
	}

	/** Le robot sous le curseur : sa plaque de nom d'abord, puis la tête la plus
	 *  proche du clic. Un raycast sur les maillages instanciés coûterait un
	 *  parcours complet de la flotte à chaque mouvement de souris.
	 *
	 *  Le nom passe en premier parce que c'est lui qu'on vise : on lit
	 *  « @front » et on clique dessus. La plaque est un objet de la salle, posé
	 *  sur le bureau — on la vise donc au rayon, comme une armoire, et non plus
	 *  par un rectangle à l'écran. Elle est DEVANT son robot : quand les deux se
	 *  recouvrent, c'est elle qu'on a cliquée, et c'est le robot qu'elle nomme
	 *  qu'on ouvre. */
	pick(event, radius = 46) {
		if (!this.fleet) return null;
		const rect = this.renderer.domElement.getBoundingClientRect();
		const named = this.plates?.pick(this._ray(event));
		if (named) {
			const entry = this.fleet.bySession.get(named);
			if (entry) return entry;
		}
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		let best = null;
		let bestScore = Infinity;
		// `toScreen` refuse les robots derrière la caméra : sans ça, un robot
		// dos au visiteur se projetterait en miroir près du centre de l'écran, et
		// on ouvrirait sa session en cliquant sur quelqu'un d'autre.
		const point = { x: 0, y: 0 };
		for (const entry of this.fleet.bySession.values()) {
			if (!toScreen(entry.anchor, this.camera3, rect.width, rect.height, point, radius)) continue;
			const distance = Math.hypot(point.x - x, point.y - y);
			if (distance > radius) continue;
			// À distance égale, le robot le plus proche de la caméra gagne :
			// c'est celui que l'œil vise quand deux têtes se chevauchent.
			const depth = this.camera3.position.distanceTo(entry.anchor) * 0.01;
			const score = distance + depth;
			if (score < bestScore) {
				bestScore = score;
				best = entry;
			}
		}
		return best;
	}

	/** Le placard sous le curseur. Un lancer de rayon, ici, et non une
	 *  projection : une armoire fait deux mètres de large et deux de haut, on
	 *  la vise au corps, pas à la tête. */
	pickStore(event) {
		if (!this.stores) return null;
		return this.stores.pick(this._ray(event));
	}

	_click(event) {
		const entry = this.pick(event);
		if (entry) {
			// On sélectionne et on ouvre — rien d'autre. La caméra ne bouge pas :
			// viser un robot, c'est vouloir lire sa session, pas se retrouver
			// collé à lui. La salle reste exactement là où on l'avait laissée, et
			// le modal se referme sur la même image qu'avant.
			this.select(entry.session.id);
			this.onOpen?.(entry.session.id);
			return;
		}
		const store = this.pickStore(event);
		if (!store) {
			this.hoveredId = null;
			this.hoveredStore = null;
			this.stores?.setHover(null);
			return;
		}
		// Un placard ne s'ouvre pas ici : il n'a pas de session à montrer, il a
		// une LISTE. La salle dit seulement quel quai on a visé.
		this.select(null);
		this.onStore?.(store.quai.id);
	}

	hover(event) {
		const entry = this.pick(event);
		const store = entry ? null : this.pickStore(event);
		const id = entry?.session.id ?? null;
		const quaiId = store?.quai.id ?? null;
		if (id === this.hoveredId && quaiId === this.hoveredStore) return;
		this.hoveredId = id;
		this.hoveredStore = quaiId;
		this.stores?.setHover(quaiId);
		this.renderer.domElement.style.cursor = id || quaiId ? 'pointer' : '';
		this.onHover?.(entry?.session ?? null);
	}

	select(id) {
		this.selectedId = id;
	}

	/** Amène la caméra devant un robot, du côté de l'allée d'où on le voit. */
	focusOn(id, radius = 3.2) {
		const station = findStation(this.layout, id);
		if (!station) return;
		this.controller.focusOn(
			new THREE.Vector3(station.x, 1.25, station.z),
			radius,
			{ phi: 0.2 }
		);
	}

	/** Un message entre deux robots : une enveloppe traverse la salle. */
	bubble(edge) {
		if (!this.fleet) return;
		const from = this._anchorFor(edge.fromSession ?? edge.fromHandle);
		const to = this._anchorFor(edge.toSession ?? edge.toHandle);
		if (!from || !to) return;
		this.overlay.spawnBubble(edge, from, to);
	}

	_anchorFor(key) {
		if (!key) return null;
		const direct = this.fleet.bySession.get(key);
		if (direct) return direct.anchor.clone();
		for (const entry of this.fleet.bySession.values()) {
			if (entry.session.handle && `@${entry.session.handle}` === key) return entry.anchor.clone();
		}
		return null;
	}

	/** Le modal s'ouvre : le clavier cesse de piloter la caméra, et l'arc de
	 *  clavier des touches fléchées retourne au champ qui a le focus. */
	setInputEnabled(enabled) {
		this.controller.inputEnabled = enabled;
		if (!enabled) this.controller.keys.clear();
	}

	/** Ramène la caméra à la vue d'entrée : le milieu de l'allée, assez haut
	 *  pour embrasser les deux rangées. C'est ce que voit quelqu'un qui arrive
	 *  sur la page — le point de départ d'où tout est lisible. */
	recenter() {
		if (!this.layout) return;
		const span = this.layout.bounds.maxX - this.layout.bounds.minX;
		this.controller.focusOn(
			new THREE.Vector3(this.layout.center.x, 1.8, this.layout.center.z),
			Math.max(24, span * 0.6),
			{ phi: 0.44 }
		);
		this.controller.wantedTheta = -1.15;
	}

	/* --------------------------------------------------------------- ménage */

	dispose() {
		this.stop();
		this.observer.disconnect();
		document.removeEventListener('visibilitychange', this._onVisibility);
		this.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
		this.renderer.domElement.removeEventListener('pointerleave', this._onPointerLeave);
		this.controller.dispose();
		this.overlay.dispose();
		if (this.hall) this.hall.dispose();
		if (this.stores) this.stores.dispose();
		if (this.screens) {
			for (const screen of this.screens.pool) {
				screen.mesh.geometry.dispose();
				screen.mesh.material.dispose();
				screen.texture.dispose();
			}
			this.scene.remove(this.screens.group);
		}
		if (this.fleet) this.fleet.dispose();
		if (this.plates) this.plates.dispose();
		this.selectionRing.geometry.dispose();
		this.selectionBeam.geometry.dispose();
		this.environment.dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}
}
