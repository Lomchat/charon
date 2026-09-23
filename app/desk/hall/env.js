// La lumière indirecte de la salle.
//
// Un métal n'a rien à montrer s'il n'a rien à réfléchir : sans environnement,
// les carrures sortent en silhouettes noires. On cuit donc, une seule fois au
// démarrage, une petite scène — parois sombres, nappes de néons au plafond,
// sol un peu clair — en carte de pré-filtrage. Les robots y trouvent leurs
// reflets et la salle son ambiance, pour le prix d'un rendu unique.

import * as THREE from '../vendor/three.module.js';

export function buildEnvironment(renderer) {
	const pmrem = new THREE.PMREMGenerator(renderer);

	const room = new THREE.Scene();
	room.background = new THREE.Color(0x0b1018);

	// Les parois : une boîte retournée, vue de l'intérieur.
	const shell = new THREE.Mesh(
		new THREE.BoxGeometry(44, 18, 44),
		new THREE.MeshBasicMaterial({ color: 0x1d2634, side: THREE.BackSide })
	);
	shell.position.y = 6;
	room.add(shell);

	// Les nappes de néons : c'est ce que les carrures accrochent.
	const tube = new THREE.MeshBasicMaterial({ color: 0xe4edff });
	for (const z of [-6, 6]) {
		for (let i = -2; i <= 2; i++) {
			const lamp = new THREE.Mesh(new THREE.BoxGeometry(7, 0.5, 1.4), tube);
			lamp.position.set(i * 8, 13, z);
			room.add(lamp);
		}
	}

	// Un sol plus clair, pour que le dessous des pièces ne soit pas bouché.
	const floor = new THREE.Mesh(
		new THREE.PlaneGeometry(44, 44),
		new THREE.MeshBasicMaterial({ color: 0x2c374b })
	);
	floor.rotation.x = -Math.PI / 2;
	floor.position.y = -1.5;
	room.add(floor);

	// Un rappel chaud, côté entrée : sans lui tout vire au bleu d'hôpital.
	const warm = new THREE.Mesh(
		new THREE.PlaneGeometry(14, 5),
		new THREE.MeshBasicMaterial({ color: 0x6b4a2e })
	);
	warm.position.set(-16, 5, 0);
	warm.rotation.y = Math.PI / 2;
	room.add(warm);

	const target = pmrem.fromScene(room, 0.03);
	pmrem.dispose();

	for (const object of room.children) {
		object.geometry?.dispose();
		object.material?.dispose();
	}
	tube.dispose();

	return { texture: target.texture, dispose: () => target.dispose() };
}
