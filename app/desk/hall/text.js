// Le peu de texte qui vient de Charon et se retrouve dans le DOM.
//
// Les messages entre robots et les questions ont été écrits par des modèles :
// ils peuvent contenir n'importe quoi. Ce qui entre dans une bulle passe par
// ici, sans exception.

export function escapeHtml(text) {
	return String(text ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Une ligne lisible à partir d'un texte qui peut faire dix mille caractères. */
export function preview(text, max = 120) {
	const clean = String(text ?? '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Un chemin de travail raccourci : on retire des segments par la tête, comme
 *  le fait la barre latérale de Charon — la queue est ce qui distingue deux
 *  chemins, c'est donc elle qu'on garde. L'ellipse dit que c'est tronqué. */
export function shortPath(path, max = 34) {
	const clean = String(path ?? '');
	if (clean.length <= max) return clean;
	const parts = clean.split('/').filter(Boolean);
	let rest = parts;
	while (rest.length > 1) {
		const text = `…/${rest.join('/')}`;
		if (text.length <= max) return text;
		rest = rest.slice(1);
	}
	const short = `…/${rest[0] ?? clean}`;
	return short.length <= max ? short : `…${short.slice(-(max - 1))}`;
}
