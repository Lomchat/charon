// The machine the pilot boards, in one of its three shapes: a seaplane, a
// gunboat, a tank (`Form`). Each shape is a `Craft`: it knows how it moves,
// where its guns point and where the eye sits behind it. The fight around it
// (combat.ts) is the same for all, and turns one into the other (morph.ts).
import type { Group, Quaternion, Vector3 } from 'three';
import type { ArcadeAudio } from '../audio';
import type { Form } from '../forms';
import type { Input } from './input';
import type { Machine } from './machine';
import type { Rig, Stage } from './stage';

export type CraftEnv = {
  stage: Stage;
  input: Input;
  audio: ArcadeAudio;
  /** The craft is hit. `from`: where it came from, if somewhere. `hard`: nothing dodges it. */
  damage: (amount: number, from: Vector3 | null, hard?: boolean) => void;
  /** A word for the pilot (STALL, PULL UP…), this frame. */
  warn: (text: string) => void;
};

export type Gauges = {
  /** What the dial says, and against what: 1 = its cruising pace (the engine's note follows it). */
  speed: number;
  pace: number;
  /** Height over what lies under it; null for what does not fly. */
  alt: number | null;
  /** The throttle, 0..1; null for what has none (its keys ARE its speed). */
  power: number | null;
  boost: number;
  boostDry: boolean;
  boosting: boolean;
};

/** What its guns are: how fast they fire, how hard, and whether a shot bursts. */
export type Gun = {
  /** Shots per second. */
  rate: number;
  damage: number;
  speed: number;
  /** World units a shot's burst reaches (0: it hits what it touches, nothing else). */
  splash: number;
  /** What one shot adds to the heat (1 = jammed). */
  heat: number;
  /** Its streak: how long, how wide. */
  length: number;
  width: number;
};

/** Where a shape is and how it goes: what one hands to the next when the machine turns into it. */
export type CraftState = {
  pos: Vector3;
  /** Which way it travels, on the ground. */
  yaw: number;
  /** Along that way, world units per second. */
  speed: number;
  boost: number;
  boostDry: boolean;
};

export interface Craft {
  readonly kind: Form;
  /** The machine itself (machine.ts): the same one whatever shape it has; `mesh` is its root. */
  readonly machine: Machine;
  readonly mesh: Group;
  /** Where the machine's root belongs for where this shape is — put there while it is the pilot's, only kept while it is held. */
  readonly rootPos: Vector3;
  readonly rootQuat: Quaternion;
  readonly pos: Vector3;
  readonly vel: Vector3;
  /** Where its hull points, and where its guns do (the same for a plane; a turret turns). */
  readonly fwd: Vector3;
  readonly aim: Vector3;
  readonly radius: number;
  readonly gun: Gun;
  /** Where one stands on the island to board it (world units, on the land). */
  readonly gate: Vector3;
  /** It has arrived and waits, moored. */
  readonly moored: boolean;
  /** Its scripted start is over: it is the pilot's, and may be shot at. */
  readonly live: boolean;
  /** Right now bullets miss it (a barrel roll). */
  readonly dodging: boolean;
  /** Right now a missile loses it (a barrel roll, flares). */
  readonly masked: boolean;
  /**
   * What it has just become by where it went: a plane that touched the sea
   * or the mainland, a boat on the beach, a tank in the water. Read once.
   */
  takeTurn(): Form | null;
  /** A gun's muzzle: `side` is 1 or -1; 0 is where its missiles leave. */
  muzzle(side: number, out: Vector3): Vector3;
  /** Where the pilot sits. */
  seat(out: Vector3): Vector3;
  /** Before it is boarded: it comes in, then waits. */
  idle(dt: number, stage: Stage): void;
  /** Skip its coming in: it is there. */
  moor(): void;
  /** The pilot is aboard: its start begins. */
  cast(): void;
  step(dt: number, env: CraftEnv): void;
  /** Its gun has just fired (a heavy one kicks). */
  fired?(stage: Stage): void;
  /** Where it is and how it goes, for the shape it turns into. */
  state(): CraftState;
  /**
   * It is being turned into (morph.ts): not yet the pilot's, kept where the
   * turning machine is — every frame until `release`. It does not move the
   * machine: the turn does.
   */
  hold(state: CraftState, stage: Stage): void;
  /** The turn is over: the machine stands in this shape, and it is the pilot's. */
  release(stage: Stage): void;
  /** Where the eye sits behind it. */
  rig(dt: number, stage: Stage, out: Rig): void;
  gauges(stage: Stage): Gauges;
  /** It is destroyed. */
  wreck(stage: Stage): void;
  /** `keep`: the machine lives on in another shape; only what was this shape's own goes. */
  dispose(stage: Stage, keep?: boolean): void;
}

/** Machine guns: the plane's, the boat's turret. */
export const MACHINE_GUN: Gun = { rate: 15, damage: 1, speed: 560, splash: 0, heat: 0.021, length: 9, width: 0.55 };
/** The tank's cannon: slow, heavy, and it bursts. */
export const CANNON: Gun = { rate: 1.7, damage: 7, speed: 420, splash: 15, heat: 0.09, length: 6, width: 1.5 };
