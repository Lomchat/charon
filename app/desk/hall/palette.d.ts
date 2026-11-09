// Le vocabulaire du desk, tel qu'il est consommé depuis le TypeScript.
//
// `palette.js` reste du JavaScript : il est importé par la salle Three.js, qui
// n'est pas compilée par `tsc` (le `include` du tsconfig s'arrête aux .ts/.tsx).
// Cette déclaration donne aux composants React la surface exacte du module,
// sans avoir à faire remonter Three.js dans le typage.

import type { SessionSummary } from '@/lib/sessionSummary';

/** Une session, telle que le magasin de résumés de Charon la tient
 *  (`useSessionList()`, §14.108) : la ligne de la liste, plus le statut
 *  vivant, l'attention et le DÉTAIL de ce qui attend (`gates`). Le desk n'y
 *  ajoute rien. */
export type DeskSession = SessionSummary;

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
export function roomName(session: DeskSession | null | undefined): string;
export function familyOf(kind: string | null | undefined): Family;
export function hexOf(css: string): number;
export function engineTint(vendor: string | null | undefined): Tint;
export function detourOf(session: DeskSession | null | undefined): { label: string; model: string | null } | null;
export function stateOf(session: DeskSession): DeskState;
export function beaconOf(session: DeskSession): Beacon;
export function beat(state: DeskState | null | undefined, t: number): number;
export function askOf(session: DeskSession): { label: string; css: string } | null;
export function statusWord(session: DeskSession): string;
export function actionWord(action: DeskAction | null | undefined): string;
export function vpsStatusOf(status: string | null | undefined): VpsStatus;
