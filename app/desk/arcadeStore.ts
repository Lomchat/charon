'use client';
// The mini-game's HUD (game/arcade.ts): what the board publishes a few times
// a second for the React overlay, and the best score kept in this browser.
// Nothing here touches Charon: the game is a toy played on the board's
// sprites, never on the sessions behind them.
import { useSyncExternalStore } from 'react';
import type { AudioMode } from './game/audio';
import type { Form, KeyHint } from './game/forms';

export type ArcadePhase = 'intro' | 'wave' | 'clear' | 'over';

export type ArcadeHud = {
  on: boolean;
  /** On foot (in 2D or seen in 3D), or in a vehicle (game/tps). */
  mode: 'ground' | 'craft';
  phase: ArcadePhase;
  paused: boolean;
  score: number;
  best: number;
  /** This run beat the record. */
  record: boolean;
  wave: number;
  hp: number;
  maxHp: number;
  shield: number;
  weapon: string;
  /** null = never runs out. */
  ammo: number | null;
  bombs: number;
  /** Score multiplier (combo, doubled by the ×2 bonus). */
  mult: number;
  foes: number;
  /** 0..1 while a boss stands; null otherwise. */
  boss: number | null;
  /** The last thing announced, and when (ms) — the overlay fades it out. */
  banner: string;
  bannerAt: number;
  /** What is heard: music and effects, effects only, nothing (the M key). */
  audio: AudioMode;
  /** In a vehicle: its hull (0..1) and its missiles. */
  hull: number;
  missiles: number;
  /** The vehicles have been reached once: a run may start from there. */
  checkpoint: boolean;
  /** The machine's shape, in a vehicle; null on foot. */
  form: Form | null;
  /** The keys of the way it is played right now (the same array until that changes). */
  keys: KeyHint[];
};

const BEST_KEY = 'desk.arcade.best';

export function readBest(): number {
  try { return Math.max(0, Math.floor(Number(localStorage.getItem(BEST_KEY)) || 0)); } catch { return 0; }
}

export function writeBest(score: number): void {
  try { localStorage.setItem(BEST_KEY, String(Math.floor(score))); } catch { /* private mode */ }
}

const OFF: ArcadeHud = {
  on: false, mode: 'ground', phase: 'intro', paused: false, score: 0, best: 0, record: false, wave: 0, hp: 0, maxHp: 0, shield: 0,
  weapon: '', ammo: null, bombs: 0, mult: 1, foes: 0, boss: null, banner: '', bannerAt: 0, audio: 'all',
  hull: 0, missiles: 0, checkpoint: false, form: null, keys: [],
};

let snapshot: ArcadeHud = OFF;
const listeners = new Set<() => void>();

/** A new reading; nothing is published when nothing shown has changed. */
export function publishArcade(next: ArcadeHud | null): void {
  const value = next ?? { ...OFF, best: readBest() };
  const before = snapshot as Record<string, unknown>;
  const after = value as Record<string, unknown>;
  let changed = false;
  for (const key of Object.keys(after)) if (before[key] !== after[key]) { changed = true; break; }
  if (!changed) return;
  snapshot = value;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useArcade(): ArcadeHud {
  return useSyncExternalStore(subscribe, () => snapshot, () => OFF);
}
