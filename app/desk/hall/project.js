// Projeter un point du monde sur l'écran — et savoir dire NON.
//
// `Vector3.project()` fait la division perspective dans la foulée, ce qui perd
// le signe de `w` : un point DERRIÈRE la caméra ressort avec des coordonnées
// miroir, souvent tout près du centre de l'écran. Tester `z > 1` après coup ne
// suffit donc pas — et c'est exactement le genre de faux positif qui fait
// cliquer un robot qu'on ne voit pas, ou coller une étiquette au nom d'un robot
// qui est dans le dos du visiteur.
//
// On garde donc `w` jusqu'au bout : en espace caméra la caméra regarde vers -z,
// donc `z >= 0` veut dire « derrière », et `w <= 0` « dans le plan de la caméra ».

import * as THREE from '../vendor/three.module.js';

const _clip = new THREE.Vector4();

/**
 * Projette `position` à l'écran.
 *
 * @param {THREE.Vector3} position
 * @param {THREE.Camera} camera
 * @param {number} width   largeur de la toile, en pixels CSS
 * @param {number} height  hauteur de la toile, en pixels CSS
 * @param {{x:number,y:number}} out  receveur réutilisé par l'appelant
 * @param {number} margin  tolérance en pixels autour du cadre
 * @returns {{x:number,y:number}|null} `null` si le point est derrière la caméra
 *   ou hors du cadre. Ne pas garder `out` au-delà de la boucle : il est partagé.
 */
export function toScreen(position, camera, width, height, out, margin = 0) {
	_clip.set(position.x, position.y, position.z, 1).applyMatrix4(camera.matrixWorldInverse);
	if (_clip.z >= 0) return null;                    // derrière la caméra
	_clip.applyMatrix4(camera.projectionMatrix);
	if (_clip.w <= 1e-6) return null;                 // dans le plan de la caméra

	out.x = ((_clip.x / _clip.w) * 0.5 + 0.5) * width;
	out.y = (-(_clip.y / _clip.w) * 0.5 + 0.5) * height;
	if (out.x < -margin || out.x > width + margin) return null;
	if (out.y < -margin || out.y > height + margin) return null;
	return out;
}
