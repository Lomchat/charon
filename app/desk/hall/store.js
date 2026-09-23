// Les placards de stockage : les robots endormis d'une machine, rangés.
//
// Un robot endormi n'a rien à faire sur le plancher. Il n'y a donc plus un
// robot par dormant mais UNE ARMOIRE PAR MACHINE — et c'est elle qu'on ouvre.
// Le placard dit ce qu'il contient de trois façons, dans cet ordre :
//
//   — sa TAILLE : une porte de plus tous les huit dormants ;
//   — ses DIODES : une par dormant, à la couleur de son moteur ;
//   — sa PLAQUE : le compte, écrit dessus, en gros.
//
// Rien ici ne dépend de React ni de Charon : c'est du mobilier, posé une fois
// par disposition, et interrogé par la salle (le clic) et l'habillage.

import * as THREE from '../vendor/three.module.js';
import { DIMS } from './layout.js';
import * as G from './geom.js';
import { makeCanvas, toTexture, roundRect, fit } from './canvas.js';
import { FAMILIES, familyOf } from './palette.js';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _size = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _color = new THREE.Color();

/** Le nombre de diodes qu'un placard peut porter. Au-delà, les dormants
 *  supplémentaires ne se comptent plus un par un : la plaque dit le reste. */
const MAX_LEDS = 24;
const LED_PITCH = 0.11;

/** La plaque du placard, peinte au-dessus des portes : le compte en gros, la
 *  répartition par moteur, et le nom de la machine — c'est SA plaque. */
function plateTexture(store) {
	const W = 512;
	const H = 128;
	const { canvas, ctx } = makeCanvas(W, H);
	ctx.clearRect(0, 0, W, H);

	// Une plaque CLAIRE, comme les marques de moteur sur les moniteurs : c'est
	// la même famille d'objets, et dans une salle sombre c'est le clair qui se
	// lit de loin — un fond sombre sur un meuble sombre ne dit rien.
	roundRect(ctx, 4, 4, W - 8, H - 8, 16);
	ctx.fillStyle = 'rgba(233, 239, 248, 0.95)';
	ctx.fill();
	ctx.lineWidth = 4;
	ctx.strokeStyle = 'rgba(20, 28, 40, 0.35)';
	ctx.stroke();

	// Le compte, à gauche : c'est ce que la plaque doit dire de loin. Le nombre
	// et son mot sont sur DEUX lignes, à des abscisses fixes : mesurer le texte
	// pour poser le second à côté du premier marchait jusqu'au jour où la police
	// du poste n'est pas celle qu'on croit — ici, rien ne peut se chevaucher.
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'left';
	ctx.font = 'bold 56px "DejaVu Sans", system-ui, sans-serif';
	ctx.fillStyle = '#16202e';
	ctx.fillText(String(store.sessions.length), 28, 38);
	ctx.font = '20px "DejaVu Sans", system-ui, sans-serif';
	ctx.fillStyle = 'rgba(70, 84, 102, 0.95)';
	ctx.fillText('asleep', 28, 76);

	// La répartition par moteur : une barre par famille présente, dans l'ordre
	// du registre de Charon — le même ordre que la légende de l'habillage.
	ctx.textAlign = 'right';
	ctx.font = '20px "DejaVu Sans", system-ui, sans-serif';
	let x = W - 26;
	for (const family of FAMILIES) {
		const n = store.sessions.filter((s) => familyOf(s.kind).id === family.id).length;
		if (!n) continue;
		const w = Math.max(26, (n / store.sessions.length) * (W * 0.4));
		ctx.fillStyle = family.css;
		roundRect(ctx, x - w, 24, w, 20, 6);
		ctx.fill();
		ctx.fillStyle = '#41506a';
		ctx.fillText(String(n), x, 64);
		x -= w + 10;
	}

	ctx.textAlign = 'center';
	ctx.font = '20px "DejaVu Sans Mono", monospace';
	ctx.fillStyle = 'rgba(63, 76, 94, 0.95)';
	ctx.fillText(fit(ctx, store.quai.name, W - 60), W / 2, 104);

	return toTexture(canvas, { anisotropy: 8 });
}

export class Stores {
	constructor(scene, layout) {
		this.scene = scene;
		this.group = new THREE.Group();
		this.group.name = 'placards';
		scene.add(this.group);

		this.byQuai = new Map();
		this.list = layout.quais.filter((quai) => quai.store);

		const capacity = Math.max(1, this.list.length);
		this.body = new THREE.InstancedMesh(
			G.cabinetGeometry(),
			new THREE.MeshStandardMaterial({
				color: 0x3d4553, roughness: 0.58, metalness: 0.26,
				envMapIntensity: 1.15, flatShading: true
			}),
			capacity
		);
		this.leds = new THREE.InstancedMesh(
			G.cabinetLedGeometry(),
			new THREE.MeshBasicMaterial({ toneMapped: false }),
			capacity * MAX_LEDS
		);
		this.plates = [];
		for (const mesh of [this.body, this.leds]) {
			mesh.frustumCulled = false;
			mesh.count = 0;
			mesh.castShadow = true;
			this.group.add(mesh);
		}

		// La plaque et l'anneau de survol : un maillage par placard — ils ne
		// sont pas nombreux (un par machine descendue) et chacun porte son texte.
		for (const quai of this.list) {
			const store = quai.store;
			const w = Math.min(store.w - 0.16, 2.2);
			const plate = new THREE.Mesh(
				new THREE.PlaneGeometry(w, w / 4),
				new THREE.MeshBasicMaterial({
					map: plateTexture(store), transparent: true, toneMapped: false
				})
			);
			// La face avant du placard regarde l'allée, c'est-à-dire -Z dans le
			// repère du quai ; une face de toile regarde +Z. D'où le demi-tour.
			plate.rotation.y = store.yaw + Math.PI;
			plate.position.set(store.x, store.h - 0.06 - w / 8, store.z);
			plate.translateZ(store.d / 2 + 0.02);
			plate.name = `plaque ${quai.name}`;
			this.group.add(plate);
			this.plates.push(plate);

			const ring = new THREE.Mesh(
				new THREE.RingGeometry(0.5, 0.62, 48),
				new THREE.MeshBasicMaterial({
					color: 0x3ce3cd, transparent: true, opacity: 0.9,
					side: THREE.DoubleSide, depthWrite: false
				})
			);
			ring.rotation.x = -Math.PI / 2;
			ring.position.set(store.x, DIMS.quaiLift + 0.02, store.z);
			ring.scale.set(store.w * 0.66, store.d * 1.05, 1);
			ring.visible = false;
			this.group.add(ring);

			this.byQuai.set(quai.id, {
				quai, store, plate, ring, index: this.byQuai.size
			});
		}

		this._lay();
	}

	/** Une matrice par placard : la géométrie unitaire prend les dimensions du
	 *  quai. Les diodes, elles, se posent dans le même repère, une par dormant. */
	_lay() {
		let led = 0;
		for (const entry of this.byQuai.values()) {
			const { store } = entry;
			_q.setFromEuler(_eu.set(0, store.yaw, 0));
			_m.compose(
				_v.set(store.x, 0, store.z), _q, _size.set(store.w, store.h, store.d)
			);
			this.body.setMatrixAt(entry.index, _m);

			// Les diodes s'alignent sur la façade, sous la plaque : une par
			// dormant, dans l'ordre de Charon, à la couleur de son moteur.
			//
			// Elles se posent en MÈTRES, dans le repère du monde — et non
			// composées dans la matrice du meuble : celle-ci porte la taille du
			// quai (la géométrie est unitaire), donc une diode de cinq
			// centimètres y serait devenue large de deux mètres et haute de
			// trois, détachée du placard qu'elle est censée marquer.
			const shown = Math.min(store.sessions.length, MAX_LEDS);
			const cols = Math.max(3, Math.floor((store.w - 0.2) / LED_PITCH));
			const rows = Math.max(1, Math.ceil(shown / cols));
			const cos = Math.cos(store.yaw);
			const sin = Math.sin(store.yaw);
			for (let i = 0; i < shown; i++) {
				const row = Math.floor(i / cols);
				const inRow = Math.min(cols, shown - row * cols);
				const y = store.h - 0.71 - row * 0.13;
				const x = -((inRow - 1) * LED_PITCH) / 2 + (i % cols) * LED_PITCH;
				const z = -(store.d / 2 + 0.012);
				_m2.compose(
					_v.set(store.x + x * cos + z * sin, y, store.z - x * sin + z * cos),
					_q,
					_one
				);
				this.leds.setMatrixAt(led, _m2);
				// Une diode de dormant ne réclame rien : elle éclaire à la couleur
				// du moteur, à mi-teinte, et ne bat pas.
				this.leds.setColorAt(led, _color.setHex(familyOf(store.sessions[i].kind).hex).multiplyScalar(0.55));
				led++;
			}
		}
		this.body.count = this.byQuai.size;
		this.body.instanceMatrix.needsUpdate = true;
		this.leds.count = led;
		this.leds.instanceMatrix.needsUpdate = true;
		if (this.leds.instanceColor) this.leds.instanceColor.needsUpdate = true;
	}

	/** L'anneau du placard survolé respire, lentement : c'est le seul mouvement
	 *  de la salle qui ne dit rien de l'état d'un robot, et il doit rester
	 *  discret — il désigne, il n'alerte pas. */
	update(time) {
		for (const entry of this.byQuai.values()) {
			if (!entry.ring.visible) continue;
			entry.ring.material.opacity = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(time * 2.2));
		}
	}

	setHover(quaiId) {
		for (const [id, entry] of this.byQuai) entry.ring.visible = id === quaiId;
	}

	/** Le placard sous le curseur : un lancer de rayon sur les carrures. Le
	 *  rayon touche la première armoire rencontrée — c'est celle qu'on vise. */
	pick(raycaster) {
		if (!this.byQuai.size) return null;
		const hits = raycaster.intersectObject(this.body, false);
		if (!hits.length) return null;
		for (const entry of this.byQuai.values()) {
			if (entry.index === hits[0].instanceId) return entry;
		}
		return null;
	}

	dispose() {
		this.scene.remove(this.group);
		for (const mesh of [this.body, this.leds]) {
			mesh.geometry.dispose();
			mesh.material.dispose();
			mesh.dispose();
		}
		for (const entry of this.byQuai.values()) {
			entry.ring.geometry.dispose();
			entry.ring.material.dispose();
		}
		for (const plate of this.plates) {
			plate.geometry.dispose();
			plate.material.map?.dispose();
			plate.material.dispose();
		}
		this.plates.length = 0;
		this.byQuai.clear();
	}
}
