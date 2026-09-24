// Le vocabulaire visuel du desk.
//
// Deux règles, et une seule source pour chacune :
//
//   1. CE QU'UN ROBOT EST. La famille (le moteur) se lit à la couleur du
//      carénage — c'est un fait de Charon, pas une invention du desk.
//   2. CE QU'UN ROBOT DEMANDE. Trois états pulsent, et trois seulement :
//      bleu = au travail, orange = une question attend, vert = un tour est
//      fini et personne ne l'a ouvert. Tout le reste reste fixe : dans une
//      salle sombre, ce qui bouge est ce qui réclame.
//
// La règle (2) n'est pas réécrite ici. Elle est IMPORTÉE de Charon — le même
// `sessionUnread.ts` qui décide de la pastille verte de sa propre barre
// latérale. Si Charon change d'avis sur ce qu'est « fini, pas ouvert », le
// desk change d'avis dans la même seconde, sans que personne y touche.

import { isWorkingStatus, showsUnreadCue } from '@/app/sessionUnread';
import { PROVIDERS, SESSION_PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';

/* ------------------------------------------------------------------ familles */

/** Couleur de la famille. Charon ne nomme pas ses moteurs par une couleur —
 *  ce sont ses logos (`PROVIDERS[kind].logo`), pas ses jetons. La teinte est
 *  donc au desk, mais la LISTE et la MARQUE viennent du registre : un backend
 *  déclaré demain apparaît dans la légende et sur les moniteurs sans qu'on
 *  touche à ce fichier.
 *
 *  `logo` est le fichier que Charon affiche lui-même dans sa barre latérale et
 *  ses réglages. Le desk ne redessine pas une marque : il prend la sienne. */
const FAMILY_TINT = {
	claude: '#d97757',
	codex: '#2fb98d',
	cursor: '#8f7bff'
};
const UNKNOWN_TINT = '#9aa4b2';

export const FAMILIES = SESSION_PROVIDERS.map((id) => ({
	id,
	label: PROVIDERS[id].label,
	logo: PROVIDERS[id].logo,
	css: FAMILY_TINT[id] ?? UNKNOWN_TINT,
	hex: hexOf(FAMILY_TINT[id] ?? UNKNOWN_TINT)
}));

export function familyOf(kind) {
	const id = asSessionProvider(kind);
	return FAMILIES.find((f) => f.id === id) ?? {
		id, label: String(kind), logo: null,
		css: UNKNOWN_TINT, hex: hexOf(UNKNOWN_TINT)
	};
}

export function hexOf(css) {
	return parseInt(css.replace('#', ''), 16);
}

/** Le moteur réellement servi, quand il sort de la famille (session détournée
 *  vers un endpoint custom). Le desk ne connaît pas la liste des fournisseurs
 *  tiers — Charon non plus —, on tire donc une teinte stable du nom : le même
 *  endpoint garde la même pastille d'une session à l'autre. */
export function engineTint(vendor) {
	const name = String(vendor ?? '');
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	const hue = hash % 360;
	return { css: `hsl(${hue} 62% 62%)`, hex: hslToHex(hue, 0.62, 0.62) };
}

/** HSL → entier 0xRRGGBB. Les voyants instanciés se colorent par entier, pas
 *  par chaîne CSS : il faut donc convertir, une fois par teinte. */
function hslToHex(h, s, l) {
	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const match = l - chroma / 2;
	const sector = Math.floor(h / 60) % 6;
	const table = [
		[chroma, second, 0], [second, chroma, 0], [0, chroma, second],
		[0, second, chroma], [second, 0, chroma], [chroma, 0, second]
	][sector];
	const channel = (value) => Math.round((value + match) * 255);
	return (channel(table[0]) << 16) | (channel(table[1]) << 8) | channel(table[2]);
}

/** L'endpoint qui détourne une session, s'il y en a un. Charon range l'état de
 *  connexion dans `session.endpoint` ; le desk n'en lit qu'une chose — le nom,
 *  pour la pastille. */
export function detourOf(session) {
	const active = session?.endpoint?.active;
	if (!active) return null;
	return { label: active.name || active.model || 'endpoint', model: active.model ?? null };
}

/* --------------------------------------------------------------------- états */

/**
 * Les cinq états du desk, dans l'ordre de priorité où ils se décident.
 *
 * `pulse` est la couleur du voyant qui bat ; `null` = voyant fixe. `speed` est
 * en cycles par seconde : le travail bat vite (une machine qui mouline), une
 * question bat plus lentement et plus fort (elle attend après toi), un tour
 * fini bat lentement (il peut attendre, mais pas indéfiniment).
 */
export const STATES = {
	question: {
		id: 'question', label: 'waiting on you', pulse: '#ff9f43', speed: 0.85,
		amplitude: 1, hint: 'a permission or a question is up — the robot has its hand raised'
	},
	unread: {
		id: 'unread', label: 'done, unread', pulse: '#35d07f', speed: 0.5,
		amplitude: 0.85, hint: 'the turn ended and nobody has read it'
	},
	working: {
		id: 'working', label: 'working', pulse: '#4da3ff', speed: 1.55,
		amplitude: 0.9, hint: 'the turn is running'
	},
	background: {
		id: 'background', label: 'background', pulse: '#4da3ff', speed: 0.42,
		amplitude: 0.7, hint: 'the turn ended, but what it launched is still running'
	},
	ready: {
		id: 'ready', label: 'idle', pulse: null, speed: 0,
		amplitude: 0, hint: 'awake, nothing running, nothing to read'
	},
	broken: {
		id: 'broken', label: 'failed', pulse: null, speed: 0,
		amplitude: 0, tint: '#ff5b5b', hint: 'last turn failed, or the session is broken'
	},
	reconnecting: {
		id: 'reconnecting', label: 'reconnecting', pulse: null, speed: 0,
		amplitude: 0, tint: '#ffa23c', hint: 'the link to the machine is coming back'
	},
	asleep: {
		id: 'asleep', label: 'asleep', pulse: null, speed: 0,
		amplitude: 0, tint: '#3f6ea8', hint: 'stored in its machine’s cabinet, behind the desks'
	}
};

/** Les trois pulsations, et elles seules. C'est ce que la légende énumère. */
export const PULSES = [STATES.working, STATES.question, STATES.unread];

/**
 * L'état d'une session, décidé par les règles de Charon.
 *
 * Chaque ligne est la copie conforme d'un test que Charon fait déjà :
 *   - `base`      : `liveStatus ?? status`        (Sidebar)
 *   - `waiting`   : gate en attente ET statut actif, parce qu'une permission
 *                   n'a de sens que sur une session qui peut la consommer
 *   - `unread`    : `showsUnreadCue`, importé
 *   - `working`   : `isWorkingStatus`, importé
 * On ne réinvente rien : on lit la même chose, dans le même ordre.
 */
export function stateOf(session, { selected = false } = {}) {
	const base = String(session.liveStatus ?? session.status ?? '');
	const pending = Number(session.pendingPermissions ?? 0);

	if (base === 'sleeping') return STATES.asleep;
	if (pending > 0 && base === 'active') return STATES.question;
	if (showsUnreadCue({
		unreadStop: session.unreadStop,
		status: base,
		pendingPermissions: pending,
		selected
	})) return STATES.unread;
	if (base === 'background') return STATES.background;
	if (isWorkingStatus(base)) return STATES.working;
	if (base === 'error' || base === 'failed' || base === 'killed') return STATES.broken;
	if (base === 'reconnecting') return STATES.reconnecting;
	return STATES.ready;
}

/** La couleur du voyant : celle de la pulsation, sinon la teinte fixe de
 *  l'état, sinon celle de la famille — un robot au repos s'éclaire à sa
 *  couleur, ce qui suffit à lire la salle de loin. */
export function beaconOf(session, { selected = false } = {}) {
	const state = stateOf(session, { selected });
	if (state.pulse) return { css: state.pulse, hex: hexOf(state.pulse), state };
	const tint = state.tint ?? familyOf(session.kind).css;
	return { css: tint, hex: hexOf(tint), state };
}

/** Le battement d'un état, entre 0 et 1, à l'instant `t` (en secondes).
 *  Un état sans pulsation renvoie 0 : son voyant est fixe, et c'est justement
 *  ce qui le distingue de ceux qui réclament. La montée est adoucie (`^1.6`)
 *  pour que le voyant s'allume franchement plutôt que de clignoter. */
export function beat(state, t) {
	if (!state?.pulse || !state.speed) return 0;
	const phase = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * state.speed);
	return Math.pow(phase, 1.6);
}

/* -------------------------------------------------------------- les machines */

/**
 * L'état d'un VPS, tel que Charon le nomme (`agentStatus`).
 *
 * La nuance compte : `missing` veut dire « SSH passe, l'agent n'est pas
 * installé » — la machine répond, on peut y aller. `error` veut dire qu'on
 * n'a même pas pu lui parler. Ce ne sont pas les mêmes machines, donc pas la
 * même couleur.
 */
const VPS_STATUS = {
	ok: { id: 'ok', label: 'online', css: '#3f9f7a', hex: hexOf('#3f9f7a') },
	missing: { id: 'missing', label: 'no agent', css: '#c08b3a', hex: hexOf('#c08b3a') },
	error: { id: 'error', label: 'unreachable', css: '#c0483f', hex: hexOf('#c0483f') },
	unknown: { id: 'unknown', label: 'never tested', css: '#6b7787', hex: hexOf('#6b7787') }
};

export function vpsStatusOf(status) {
	return VPS_STATUS[String(status ?? 'unknown')] ?? VPS_STATUS.unknown;
}

/* ------------------------------------------------------- la question, en clair */

/** Le nom d'un robot, en une seule ligne.
 *
 *  Le handle d'abord : c'est le nom sous lequel l'agent répond dans le réseau
 *  de Charon, donc le seul qui permette de l'appeler. À défaut, le titre que
 *  quelqu'un lui a donné dans la barre latérale — c'est ce que l'œil cherche
 *  quand il balaie la salle. À défaut seulement, l'identifiant tronqué.
 *
 *  Une seule fonction pour tous les endroits qui nomment un robot (l'étiquette
 *  au-dessus de la tête, le bandeau de l'écran, la plaque du bureau, l'en-tête
 *  du modal) : autrement le même robot finirait par s'appeler plusieurs choses
 *  différentes. La salle s'en sert à travers `roomName`, qui n'en retire qu'un
 *  signe. */
export function robotName(session) {
	if (session?.handle) return `@${session.handle}`;
	const name = String(session?.name ?? '').trim();
	if (name) return name;
	return String(session?.id ?? '?').slice(0, 6);
}

/** Le même nom, écrit comme la SALLE l'écrit : sans l'arobase.
 *
 *  `@api` est une adresse — la façon d'appeler un agent dans le réseau de
 *  Charon —, et c'est à ce titre qu'elle reste dans les panneaux, où l'on
 *  écrit pour de bon. Sur une plaque de bureau, l'arobase ne dit rien : elle
 *  mange la largeur de la carte, donc la taille des lettres, qui se règle sur
 *  la place disponible (`plates.js`), et elle fait ressembler un nom de robot
 *  à une adresse e-mail. La salle nomme, les panneaux adressent : c'est la
 *  même fonction qui décide, moins ce signe. */
export function roomName(session) {
	const name = robotName(session);
	return name.charCodeAt(0) === 64 ? name.slice(1) : name;
}

/** Ce qui est demandé, quand quelque chose est demandé. `pendingPermissions`
 *  de la liste est une SOMME (permissions + questions + plans) : le desk
 *  suit le détail par le flux SSE, et retombe sur la somme sinon. */
export function askOf(session) {
	const kinds = session.pendingKinds;
	if (kinds?.permission) return { label: 'permission requested', css: STATES.question.pulse };
	if (kinds?.question) return { label: 'question asked', css: '#ffd166' };
	if (kinds?.exit_plan) return { label: 'plan to approve', css: '#ffd166' };
	if ((session.pendingPermissions ?? 0) > 0) return { label: 'waiting for an answer', css: STATES.question.pulse };
	return null;
}

/** Le libellé d'état de Charon, repris tel quel (Sidebar § STATUS_TEXT) là où
 *  le desk a besoin d'un mot — la fiche, jamais la salle. */
export const STATUS_TEXT = {
	active: 'ready',
	thinking: 'working',
	starting: 'starting',
	sleeping: 'asleep',
	error: 'failed',
	failed: 'last turn failed',
	background: 'background',
	reconnecting: 'reconnecting',
	ready: 'ready'
};

export function statusWord(session) {
	const base = String(session.liveStatus ?? session.status ?? '');
	if ((session.pendingPermissions ?? 0) > 0 && base === 'active') return 'you are needed';
	return STATUS_TEXT[base] ?? base;
}

/** L'action en cours, telle que le flux la rapporte. Le desk n'invente pas :
 *  si Charon n'a rien dit, l'écran dit « — ». */
export function actionWord(action) {
	if (!action) return '—';
	switch (action.kind) {
		case 'tool': return `tool ${action.tool}`;
		case 'text': return 'writing a reply';
		case 'think': return 'thinking';
		case 'user': return 'message received';
		case 'stop': return 'turn finished';
		case 'compact': return 'compacting context';
		case 'bg': return 'background task';
		case 'peer': return action.peer ? `message ${action.peer === 'in' ? 'from' : 'to'} @${action.who}` : 'robot to robot';
		case 'error': return 'error';
		case 'perm': return 'permission requested';
		case 'question': return 'question asked';
		default: return action.kind;
	}
}
