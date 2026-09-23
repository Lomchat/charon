// Caméra : orbite et vol libre, sur le même axe.
//
// La caméra regarde toujours `target`. Les déplacements clavier font glisser
// cette cible — on vole donc sans perdre l'orbite —, la souris tourne autour,
// la molette s'éloigne. Un clic sur un robot ne fait que déplacer la cible.
//
// Une seule règle compte ici : la caméra ne doit JAMAIS entrer dans le décor.
// Le rayon minimal est calculé sur la hauteur de la cible, pas fixé à
// l'aveugle, sinon on atterrit dans le béton en se rapprochant d'un poste.

import * as THREE from '../vendor/three.module.js';

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Camera {
	constructor(camera, canvas, { bounds }) {
		this.camera = camera;
		this.canvas = canvas;
		this.bounds = bounds;

		this.target = new THREE.Vector3(0, 2, 0);
		this.wanted = this.target.clone();
		this.radius = 46;
		this.wantedRadius = 46;
		this.theta = -1.15;      // autour de l'axe vertical
		this.wantedTheta = this.theta;
		this.phi = 0.52;         // au-dessus de l'horizon
		this.wantedPhi = this.phi;

		this.keys = new Set();
		this.speed = 14;
		this.dragging = null;
		// Quand un modal couvre la salle, le clavier ne pilote plus la caméra :
		// on ne veut pas que la frappe d'un message fasse voler le hall.
		this.inputEnabled = true;

		this.position = new THREE.Vector3();
		this._apply();
		this.camera.position.copy(this.position);

		this._bind();
	}

	_bind() {
		const canvas = this.canvas;
		this._onDown = (event) => {
			this.dragging = { x: event.clientX, y: event.clientY, button: event.button, moved: 0 };
			canvas.setPointerCapture?.(event.pointerId);
		};
		this._onMove = (event) => {
			if (!this.dragging) return;
			const dx = event.clientX - this.dragging.x;
			const dy = event.clientY - this.dragging.y;
			this.dragging.x = event.clientX;
			this.dragging.y = event.clientY;
			this.dragging.moved += Math.abs(dx) + Math.abs(dy);
			if (this.dragging.button === 0) {
				this.wantedTheta -= dx * 0.0045;
				this.wantedPhi = Math.max(-0.35, Math.min(1.35, this.wantedPhi + dy * 0.0035));
			} else {
				this._pan(dx, dy);
			}
		};
		this._onUp = (event) => {
			if (this.dragging && this.dragging.moved < 6) this.onClick?.(event);
			this.dragging = null;
		};
		this._onWheel = (event) => {
			event.preventDefault();
			this.wantedRadius = Math.max(2.5, Math.min(160, this.wantedRadius * (1 + Math.sign(event.deltaY) * 0.12)));
		};
		this._onKeyDown = (event) => {
			if (!this.inputEnabled) return;
			const tag = event.target?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
			const code = event.code;
			if (['Space', 'ControlLeft', 'ControlRight'].includes(code)) event.preventDefault();
			this.keys.add(code);
		};
		this._onKeyUp = (event) => this.keys.delete(event.code);
		this._onBlur = () => this.keys.clear();

		canvas.addEventListener('pointerdown', this._onDown);
		canvas.addEventListener('pointermove', this._onMove);
		canvas.addEventListener('pointerup', this._onUp);
		canvas.addEventListener('pointercancel', this._onUp);
		canvas.addEventListener('wheel', this._onWheel, { passive: false });
		canvas.addEventListener('contextmenu', (event) => event.preventDefault());
		window.addEventListener('keydown', this._onKeyDown);
		window.addEventListener('keyup', this._onKeyUp);
		window.addEventListener('blur', this._onBlur);
	}

	dispose() {
		const canvas = this.canvas;
		canvas.removeEventListener('pointerdown', this._onDown);
		canvas.removeEventListener('pointermove', this._onMove);
		canvas.removeEventListener('pointerup', this._onUp);
		canvas.removeEventListener('pointercancel', this._onUp);
		canvas.removeEventListener('wheel', this._onWheel);
		window.removeEventListener('keydown', this._onKeyDown);
		window.removeEventListener('keyup', this._onKeyUp);
		window.removeEventListener('blur', this._onBlur);
	}

	_pan(dx, dy) {
		// Déplacement dans le plan de l'écran.
		_forward.set(Math.sin(this.theta), 0, Math.cos(this.theta)).normalize();
		_right.set(_forward.z, 0, -_forward.x);
		const scale = this.radius * 0.0016;
		this.wanted.addScaledVector(_right, dx * scale);
		this.wanted.addScaledVector(_forward, dy * scale);
		this._clamp();
	}

	_clamp() {
		const b = this.bounds;
		this.wanted.x = Math.max(b.minX - 6, Math.min(b.maxX + 6, this.wanted.x));
		this.wanted.z = Math.max(b.minZ - 6, Math.min(b.maxZ + 6, this.wanted.z));
		this.wanted.y = Math.max(0.6, Math.min(26, this.wanted.y));
	}

	/** Amène la caméra sur un point : le clic sur un robot. */
	focusOn(position, radius = 4.2, { phi = 0.28 } = {}) {
		this.wanted.copy(position);
		this.wanted.y = Math.max(1.1, position.y * 0.85);
		this.wantedRadius = radius;
		this.wantedPhi = phi;
	}

	update(delta) {
		// Vol : les touches font glisser la cible, l'orbite suit.
		const keys = this.keys;
		const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
		const slow = keys.has('AltLeft') || keys.has('AltRight');
		let forward = 0;
		let strafe = 0;
		let lift = 0;
		if (keys.has('KeyW') || keys.has('KeyZ') || keys.has('ArrowUp')) forward += 1;
		if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1;
		if (keys.has('KeyA') || keys.has('KeyQ') || keys.has('ArrowLeft')) strafe -= 1;
		if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
		if (keys.has('Space')) lift += 1;
		if (keys.has('ControlLeft') || keys.has('ControlRight')) lift -= 1;

		if (forward || strafe || lift) {
			const speed = this.speed * delta * (fast ? 2.6 : slow ? 0.35 : 1);
			_forward.set(Math.sin(this.theta), 0, Math.cos(this.theta)).normalize();
			_right.set(_forward.z, 0, -_forward.x);
			this.wanted.addScaledVector(_forward, -forward * speed);
			this.wanted.addScaledVector(_right, strafe * speed);
			this.wanted.y += lift * speed;
			this._clamp();
		}

		// Un ressort simple : rien ne saute, tout glisse.
		const ease = 1 - Math.pow(0.0016, delta);
		this.target.lerp(this.wanted, ease);
		this.radius += (this.wantedRadius - this.radius) * ease;
		this.theta += (this.wantedTheta - this.theta) * ease;
		this.phi += (this.wantedPhi - this.phi) * ease;

		this._apply();
		this.camera.lookAt(this.target);
	}

	_apply() {
		const cosPhi = Math.cos(this.phi);
		this.position.set(
			this.target.x + Math.sin(this.theta) * cosPhi * this.radius,
			this.target.y + Math.sin(this.phi) * this.radius,
			this.target.z + Math.cos(this.theta) * cosPhi * this.radius
		);
		this.camera.position.copy(this.position);
	}

	/** Rayon normalisé d'un point de l'écran, pour la sélection. */
	ndc(event) {
		const rect = this.canvas.getBoundingClientRect();
		return new THREE.Vector2(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1
		);
	}
}
