// What the 3D phase sees of the fight on foot. The fight itself — the pilot,
// the robots, the shots, the pods, the pickups, every rule — is still run by
// game/arcade.ts on the board's own plane, in board pixels, exactly as in 2D:
// the 3D phase only LOOKS at it from behind the pilot. That is why nothing
// jumps when the view changes: it is the same game.
import type { PickupKind, RobotKind } from '../art';

export type GroundFoe = {
  type: string; x: number; y: number; hp: number; maxHp: number;
  flash: number; sleep: number; state: number; t: number; seed: number;
};

export type GroundShot = {
  x: number; y: number; vx: number; vy: number; life: number; r: number;
  kind: 'bullet' | 'laser' | 'rocket' | 'flame' | 'foe'; colour: string;
};

export type GroundPod = { x: number; y: number; t: number; max: number; type: string };
export type GroundPickup = { x: number; y: number; kind: PickupKind; age: number; fall: number };

export type GroundScene = {
  clock: number;
  pilot: {
    x: number; y: number;
    /** Where the gun points (a unit vector on the board). */
    aimX: number; aimY: number;
    /** Seconds it has been walking; 0 = standing. */
    stride: number;
    /** On the island (not yet dropped, not down). */
    shown: boolean;
    /** Just hit: it flickers. */
    blink: boolean;
    shield: number;
    hp: number;
    /** Its weapon's colour, and whether it just fired. */
    gun: string;
    flash: boolean;
  };
  foes: readonly GroundFoe[];
  shots: readonly GroundShot[];
  pods: readonly GroundPod[];
  pickups: readonly GroundPickup[];
  /** The helicopter of the drops, on its way across. */
  heli: { x: number; y: number } | null;
};

export type GroundPort = {
  scene: () => GroundScene;
  /** How a kind of robot looks: whose sprite, how big, flying, reddened. */
  look: (type: string) => { art: RobotKind | 'drone'; scale: number; fly: boolean; red: boolean };
  /** The closest point of the island one can stand on. */
  nearestLand: (x: number, y: number) => { x: number; y: number };
  /**
   * The pilot boards a vehicle: the fight on foot stops for good. Returns
   * whether a wave was under way, what stood on the island, and what the wave
   * had not sent yet: its `share` of the whole (0..1), its boss among it.
   */
  leave: () => { fighting: boolean; foes: Array<{ type: string; x: number; y: number }>; share: number; boss: boolean };
};
