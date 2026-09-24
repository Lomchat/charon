// Ce qui flotte au-dessus de la scène : titres de file, bulles de conversation,
// enveloppes en vol.
//
// Le NOM d'un robot n'est plus ici. Il est dans la salle, sur une plaque posée
// à son bureau (`plates.js`) : un nom qui appartient à un lieu se lit à sa
// place, pas dans une couche d'interface collée par-dessus — et c'est aussi
// elle qui porte maintenant le battement de l'état.
//
// Ce qui reste est en DOM, projeté depuis les coordonnées monde : à cent robots
// le texte reste net, à toute distance, et la mise en page se paie une fois par
// image au lieu d'un dessin de glyphes par robot. Ces deux-là ne se cliquent
// pas : un titre de file n'est pas une cible, c'est une légende.

import * as THREE from '../vendor/three.module.js';
import { sidebarPathKey } from '@/app/sidebarPathGroups';
import { toScreen } from './project.js';
import { escapeHtml, preview, shortPath } from './text.js';
import { roomName } from './palette.js';

const _v = new THREE.Vector3();

/** L'altitude du nom survolé : juste au-dessus de la tête, assez pour ne pas la
 *  couvrir. L'ancre d'un robot EST sa tête (1,52 m) : à deux mètres de plus, un
 *  robot au premier plan chassait la boîte hors du cadre, et le nom s'en allait
 *  loin de celui qu'on désigne. */
const HOVER_LIFT = 0.6;

class Pool {
	constructor(container, className) {
		this.container = container;
		this.className = className;
		this.free = [];
		this.used = new Set();
	}

	take() {
		const element = this.free.pop() ?? document.createElement('div');
		element.className = this.className;
		if (!element.parentNode) this.container.appendChild(element);
		element.style.display = '';
		return element;
	}

	release(element) {
		element.style.display = 'none';
		this.free.push(element);
	}
}

export class Overlay {
	constructor(container) {
		this.container = container;
		this.paths = new Pool(container, 'dsk-path');
		this.bubbles = new Pool(container, 'dsk-bubble');
		this.dots = new Pool(container, 'dsk-envelope');
		this.pathState = new Map();
		this.bubbleItems = [];
		/** Le nom du robot sous le curseur : une seule boîte pour toute la salle,
		 *  puisqu'on ne survole qu'un robot à la fois. */
		this.hoverBox = null;
	}

	/** Le nom du robot sous le curseur.
	 *
	 *  La salle écrit déjà ce nom deux fois : à plat sur la plaque de son bureau
	 *  (`plates.js`), et dans le titre de sa file pour les yeux qui rasent le
	 *  sol. Il en manquait une, celle du geste le plus direct — la souris qui
	 *  désigne un robot du bout du hall, là où la plaque ne fait plus que
	 *  quelques pixels. Celle-ci est en DOM, donc nette à toute distance, et
	 *  elle suit le robot : elle ne dit pas seulement « c'est celui-là », elle
	 *  dit son nom — et le chemin avec, celui que le sol peint et que
	 *  l'éloignement efface.
	 *
	 *  Elle se pose au-dessus de la tête, prend la couleur de l'état (le même
	 *  code que la plaque et le voyant), et ne se clique pas : c'est une
	 *  légende, pas une cible — on clique déjà le robot dessous. */
	drawHover(entry, camera, width, height) {
		if (!entry) {
			if (this.hoverBox) this.hoverBox.element.style.display = 'none';
			return;
		}
		let box = this.hoverBox;
		if (!box) {
			const element = document.createElement('div');
			element.className = 'dsk-hover';
			element.style.display = 'none';
			this.container.appendChild(element);
			box = this.hoverBox = { element, drawn: null };
		}
		const name = roomName(entry.session);
		const path = shortPath(sidebarPathKey(entry.session?.cwd), 30);
		const colour = `#${(entry.beacon?.hex ?? 0x9fb4d0).toString(16).padStart(6, '0')}`;
		const signature = `${name}|${path}|${colour}`;
		if (box.drawn !== signature) {
			box.drawn = signature;
			box.element.innerHTML = `<b>${escapeHtml(name)}</b><span>${escapeHtml(path)}</span>`;
			box.element.style.borderColor = colour;
			box.element.style.color = colour;
		}
		const point = { x: 0, y: 0 };
		if (!this._project(
			_v.set(entry.anchor.x, entry.anchor.y + HOVER_LIFT, entry.anchor.z),
			camera, width, height, point
		)) {
			box.element.style.display = 'none';
			return;
		}
		box.element.style.display = '';
		box.element.style.transform =
			`translate(-50%, -100%) translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
	}

	// Un titre hors champ ne sert à rien : la marge est étroite — de quoi le
	// laisser entrer quand sa file vient de sortir du cadre, pas de quoi placer
	// la moitié de la salle dans le vide.
	_project(position, camera, width, height, out) {
		return toScreen(position, camera, width, height, out, 24) !== null;
	}

	/** Titres de chemin : le nom d'une file, devant son premier poste.
	 *
	 *  C'est la seconde écriture du nom — la première est peinte à plat sur le
	 *  plancher du quai (`hall.js`), et c'est elle que la vue du dessus lit.
	 *  Ceux-ci ne servent qu'aux yeux qui rasent la salle (`world.js`), là où une
	 *  peinture au sol s'écrase : un bureau de 74 cm cache le plancher sur plus
	 *  d'un mètre, et les files du fond disparaissent derrière celles du devant.
	 *  L'ancre est donc au-dessus de la bande d'accostage — à la verticale de la
	 *  plaque, elle-même au-dessus des têtes : le seul point de la salle qui soit
	 *  devant tout le monde et devant personne.
	 *
	 *  Un titre ne descend JAMAIS de sa file : il monte seulement s'il tombe sur
	 *  un autre titre ou sur l'habillage du bas — deux voisins de quai se
	 *  chevauchent quand la salle est vue de loin, et un cran d'écart suffit à
	 *  les séparer sans les détacher de leur file, qui est à la même x. Les noms
	 *  des robots, eux, ne sont plus dans cette couche : ils sont posés sur les
	 *  bureaux (`plates.js`), et il n'y a plus rien à ménager entre les deux. */
	drawPaths(entries, camera, width, height, placed = []) {
		const point = { x: 0, y: 0 };
		const step = 3;
		const lift = 2;
		const keep = new Set();
		const ordered = entries
			.map((entry) => ({ entry, distance: camera.position.distanceTo(entry.position) }))
			.sort((a, b) => a.distance - b.distance);

		ordered.forEach(({ entry, distance }, rank) => {
			if (!this._project(entry.position, camera, width, height, point)) return;
			let state = this.pathState.get(entry.key);
			if (!state) {
				state = { element: this.paths.take(), drawn: null, size: null };
				this.pathState.set(entry.key, state);
			}
			const signature = `${entry.path}|${entry.count}`;
			if (state.drawn !== signature) {
				state.drawn = signature;
				state.element.innerHTML =
					`<i></i><span>${escapeHtml(shortPath(entry.path))}</span><b>${entry.count}</b>`;
				state.size = null;
			}
			if (!state.size) {
				state.size = { w: state.element.offsetWidth || 120, h: state.element.offsetHeight || 18 };
			}
			const half = state.size.w / 2 + 4;
			const x = Math.min(Math.max(point.x, half), Math.max(half, width - half));
			const box = { x0: 0, x1: 0, y0: 0, y1: 0 };
			const at = (value) => {
				box.x0 = x - state.size.w / 2 - step;
				box.x1 = x + state.size.w / 2 + step;
				box.y0 = value - state.size.h - step;
				box.y1 = value + step;
				return box;
			};
			const busy = (candidate) => placed.some((other) =>
				candidate.x0 < other.x1 && candidate.x1 > other.x0 &&
				candidate.y0 < other.y1 && candidate.y1 > other.y0
			);

			let y = Math.max(point.y, state.size.h + 6);
			let spot = { ...at(y) };
			for (let i = 0; i < lift && busy(spot); i++) {
				y -= state.size.h + 4;
				spot = { ...at(y) };
			}

			placed.push(spot);
			keep.add(entry.key);
			state.element.style.zIndex = String(Math.max(1, 20 - Math.min(20, rank)));
			state.element.style.transform =
				`translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
			// Un titre du fond de la salle reste lisible : il se ternit, jamais
			// au point qu'on renonce à lire le nom de son chemin.
			state.element.style.opacity = String(Math.max(0.8, Math.min(1, 1.3 - distance / 70)));
		});

		for (const [key, state] of this.pathState) {
			if (keep.has(key)) continue;
			this.paths.release(state.element);
			this.pathState.delete(key);
		}
	}

	/** Bulles de conversation : voyagent, s'affichent, s'effacent. */
	spawnBubble(edge, from, to, { travel = 1.9, hold = 9 } = {}) {
		const dot = this.dots.take();
		dot.textContent = '✉';
		const element = this.bubbles.take();
		element.className = `dsk-bubble ${edge.status === 'sent' ? 'sent' : 'reply'}`;
		element.innerHTML = `
			<span class="from">${escapeHtml(edge.from)}</span>
			<span class="text">${escapeHtml(preview(edge.text, 220))}</span>
			${edge.status === 'replied' ? '<span class="tag">replied</span>' : ''}`;
		element.style.display = 'none';
		this.bubbleItems.push({ element, dot, from: from.clone(), to: to.clone(), t: 0, travel, hold, edge });
	}

	updateBubbles(delta, camera, width, height, onArrive) {
		const point = { x: 0, y: 0 };
		for (let i = this.bubbleItems.length - 1; i >= 0; i--) {
			const item = this.bubbleItems[i];
			item.t += delta;

			if (item.t < item.travel) {
				// L'enveloppe suit un arc : c'est un message lancé, pas un glissement.
				const p = item.t / item.travel;
				const arc = Math.sin(p * Math.PI) * item.from.distanceTo(item.to) * 0.22;
				_v.lerpVectors(item.from, item.to, p);
				_v.y += arc;
				if (this._project(_v, camera, width, height, point)) {
					item.dot.style.transform =
						`translate(-50%, -50%) translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
					item.dot.style.opacity = String(Math.min(1, p * 4) * (1 - Math.max(0, p - 0.85) * 6));
				}
			} else if (item.t < item.travel + item.hold) {
				if (!item.arrived) {
					item.arrived = true;
					item.dot.style.opacity = '0';
					this.dots.release(item.dot);
					item.element.style.display = '';
					onArrive?.(item.edge);
				}
				if (this._project(item.to, camera, width, height, point)) {
					item.element.style.transform =
						`translate(-50%, -100%) translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
					const fade = item.t - (item.travel + item.hold - 1.6);
					item.element.style.opacity = String(fade > 0 ? Math.max(0, 1 - fade / 1.6) : 1);
				}
			} else {
				this.dots.release(item.dot);
				this.bubbles.release(item.element);
				this.bubbleItems.splice(i, 1);
			}
		}
	}

	clearBubbles() {
		for (const item of this.bubbleItems) {
			this.dots.release(item.dot);
			this.bubbles.release(item.element);
		}
		this.bubbleItems.length = 0;
	}

	dispose() {
		this.clearBubbles();
		this.container.querySelectorAll('.dsk-path, .dsk-bubble, .dsk-envelope')
			.forEach((element) => element.remove());
		this.pathState.clear();
	}
}
