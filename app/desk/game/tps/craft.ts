// A vehicle the pilot can take: the seaplane, the gunboat. Each knows how it
// moves, where its guns point and where the eye sits behind it; the fight
// around it (combat.ts) is the same for both.
import type { Group, Vector3 } from 'three';
import type { ArcadeAudio } from '../audio';
import type { Input } from './input';
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
  boost: number;
  boostDry: boolean;
  boosting: boolean;
};

export interface Craft {
  readonly kind: 'plane' | 'boat';
  readonly mesh: Group;
  readonly pos: Vector3;
  readonly vel: Vector3;
  /** Where its hull points, and where its guns do (the same for a plane; a boat's turret turns). */
  readonly fwd: Vector3;
  readonly aim: Vector3;
  readonly radius: number;
  /** Where one stands on the island to board it (world units, on the land). */
  readonly gate: Vector3;
  /** It has arrived and waits, moored. */
  readonly moored: boolean;
  /** Its scripted start is over: it is the pilot's, and may be shot at. */
  readonly live: boolean;
  /** Right now bullets miss it (a barrel roll). */
  readonly dodging: boolean;
  /** Right now a missile loses it (a barrel roll, a boat's flares). */
  readonly masked: boolean;
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
  /** Where the eye sits behind it. */
  rig(dt: number, stage: Stage, out: Rig): void;
  gauges(stage: Stage): Gauges;
  /** It is destroyed. */
  wreck(stage: Stage): void;
  dispose(stage: Stage): void;
}
