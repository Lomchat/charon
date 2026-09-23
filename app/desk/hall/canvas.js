// Petits utilitaires de toile : tout ce qui porte du texte ou de la matière est
// dessiné à la volée. Le desk ne charge qu'une chose : les marques des moteurs,
// et il les prend à Charon (`PROVIDERS[id].logo`, voir `palette.js`) plutôt que
// d'en redessiner une — deux marques pour un même moteur finiraient par diverger.

import * as THREE from '../vendor/three.module.js';

export function makeCanvas(width, height) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return { canvas, ctx: canvas.getContext('2d') };
}

export function toTexture(canvas, { srgb = true, anisotropy = 4, repeat = null } = {}) {
	const texture = new THREE.CanvasTexture(canvas);
	if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = anisotropy;
	if (repeat) {
		texture.wrapS = THREE.RepeatWrapping;
		texture.wrapT = THREE.RepeatWrapping;
		texture.repeat.set(repeat[0], repeat[1]);
	}
	return texture;
}

export function roundRect(ctx, x, y, width, height, radius) {
	const r = Math.min(radius, width / 2, height / 2);
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + width, y, x + width, y + height, r);
	ctx.arcTo(x + width, y + height, x, y + height, r);
	ctx.arcTo(x, y + height, x, y, r);
	ctx.arcTo(x, y, x + width, y, r);
	ctx.closePath();
}

/* ---------------------------------------------------------- les marques */

// Les logos des moteurs, chargés une fois pour toute la salle. `onReady` est
// appelé quand l'image arrive : la toile qui l'attendait se redessine alors,
// sans que l'appelant ait à savoir si elle était là ou non.
const LOGOS = new Map();

export function logoImage(url, onReady) {
	if (!url) return null;
	let entry = LOGOS.get(url);
	if (!entry) {
		entry = { image: new Image(), ready: false, waiting: [] };
		entry.image.decoding = 'async';
		entry.image.onload = () => {
			entry.ready = true;
			const waiting = entry.waiting;
			entry.waiting = [];
			for (const call of waiting) call();
		};
		entry.image.src = url;
		LOGOS.set(url, entry);
	}
	if (entry.ready) return entry.image;
	if (onReady) entry.waiting.push(onReady);
	return null;
}

/** Tronque un texte à la largeur donnée, en ajoutant une ellipse. */
export function fit(ctx, text, maxWidth) {
	const value = String(text ?? '').replace(/\s+/g, ' ').trim();
	if (ctx.measureText(value).width <= maxWidth) return value;
	let cut = value;
	while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
		cut = cut.slice(0, -1);
	}
	return `${cut}…`;
}

/** Découpe un texte en lignes qui tiennent dans la largeur donnée. */
export function wrap(ctx, text, maxWidth, maxLines = 4) {
	const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ');
	const lines = [];
	let line = '';
	for (const word of words) {
		const candidate = line ? `${line} ${word}` : word;
		if (ctx.measureText(candidate).width <= maxWidth) {
			line = candidate;
		} else {
			if (line) lines.push(line);
			line = word;
			if (lines.length === maxLines) break;
		}
	}
	if (line && lines.length < maxLines) lines.push(line);
	if (lines.length === maxLines) {
		lines[maxLines - 1] = fit(ctx, lines[maxLines - 1], maxWidth);
	}
	return lines;
}

/** "4 min ago" — relative time, in English, without a dependency. */
export function ago(ms) {
	if (!ms) return '—';
	const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
	if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86400)}d ago`;
}
