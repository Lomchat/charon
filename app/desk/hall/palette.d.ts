// Le vocabulaire du desk, tel qu'il est consommé depuis le TypeScript.
//
// `palette.js` reste du JavaScript : il est importé par la salle Three.js, qui
// n'est pas compilée par `tsc` (le `include` du tsconfig s'arrête aux .ts/.tsx).
// Cette déclaration donne aux composants React la surface exacte du module,
// sans avoir à faire remonter Three.js dans le typage.

import type { SessionListItem } from '@/lib/types/api';

/** Une session, plus ce que le desk sait d'elle et que Charon ne dit pas :
 *  le DÉTAIL de ce qui est en attente, appris par le flux SSE quand la session
 *  est celle qu'on regarde. `pendingPermissions` de Charon est une somme —
 *  permissions + questions + plans —, ce qui suffit pour allumer un voyant
 *  mais pas pour lever une main ou deux. */
export type DeskSession = SessionListItem & {
  pendingKinds?: { permission?: boolean; question?: boolean; exit_plan?: boolean };
};

export type DeskState = {
  id: 'question' | 'unread' | 'working' | 'background' | 'ready'
    | 'broken' | 'reconnecting' | 'asleep';
  label: string;
  /** Couleur du voyant qui bat. `null` = voyant fixe, et c'est un fait :
   *  un état qui ne réclame rien ne pulse pas. */
  pulse: string | null;
  /** Cycles par seconde. */
  speed: number;
  amplitude: number;
  /** Teinte fixe, pour les états qui n'ont pas de pulsation. */
  tint?: string;
  hint: string;
};

export type Beacon = { css: string; hex: number; state: DeskState };
/** La marque du moteur, telle que Charon la publie (`PROVIDERS[id].logo`) :
 *  c'est le fichier que sa propre barre latérale affiche, pas un dessin du
 *  desk. `null` pour une famille que le desk ne connaît pas. */
export type Family = { id: string; label: string; logo: string | null; css: string; hex: number };
export type Tint = { css: string; hex: number };
export type VpsStatus = { id: string; label: string; css: string; hex: number };

/** Ce que la salle écoute : un fait, réduit à ce qui se dessine. */
export type DeskAction = {
  kind: string;
  tool?: string;
  detail?: string;
  at?: number;
  peer?: 'in' | 'out';
  who?: string;
};

export const FAMILIES: Family[];
export const PULSES: DeskState[];
export const STATES: Record<DeskState['id'], DeskState>;
export const STATUS_TEXT: Record<string, string>;

export function robotName(session: DeskSession | null | undefined): string;
export function familyOf(kind: string | null | undefined): Family;
export function hexOf(css: string): number;
export function engineTint(vendor: string | null | undefined): Tint;
export function detourOf(session: DeskSession | null | undefined): { label: string; model: string | null } | null;
export function stateOf(session: DeskSession, options?: { selected?: boolean }): DeskState;
export function beaconOf(session: DeskSession, options?: { selected?: boolean }): Beacon;
export function beat(state: DeskState | null | undefined, t: number): number;
export function askOf(session: DeskSession): { label: string; css: string } | null;
export function statusWord(session: DeskSession): string;
export function actionWord(action: DeskAction | null | undefined): string;
export function vpsStatusOf(status: string | null | undefined): VpsStatus;
