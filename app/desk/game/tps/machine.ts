// The machine the pilot boards, as ONE body: the same parts — a fuselage,
// two wings, two floats, a tail, a canopy, two guns… — put together three
// ways. A seaplane, a gunboat and a tank are three POSES of these parts, and
// turning from one into another is the parts themselves swinging, folding
// and sliding there. Nothing appears, nothing vanishes, nothing changes
// colour: what was the wing IS the boat's side, what was the float IS the
// tank's track.
//
//   plane   wings out, floats down on their struts, guns under the wings
//   boat    the fuselage down on the water between its floats, the wings
//           swept back and stood up along it as its sides, the canopy raised
//           into a wheelhouse, the guns on a turret forward
//   tank    the floats let down as tracks (their soles drop, the wheels
//           between show), the wings laid over them as skirts, the tail
//           drawn in, the guns run out long on a turret amidships
//
// A turn goes through a folded state common to all three (`fold`): one shape
// folds into it, the next unfolds from it — each part in its own time.
//
// Heights are from the SOLES (y = 0: what the machine rests on — the water
// under its floats, the ground under its tracks), +Z is the nose, +X the left.
import { Group, Quaternion, Vector3 } from 'three';
import type { Form } from '../forms';
import { buildModel, instance, type Box, type Model } from './voxels';

const WHITE = '#dfe6f2';
const BELLY = '#9aa8c0';
const GOLD = '#ffe066';
const DARK = '#2a3650';
const INK = '#10131b';
const STEEL = '#343c50';
const STEEL_DARK = '#1c2230';
const STEEL_LIGHT = '#5a6480';
const GLASS = '!#7cc4ff';
const SOLE = '#55607a';

type Shape = Form | 'fold';
type Turn = ['x' | 'y' | 'z', number];
type Pose = { p: [number, number, number]; r?: Turn[]; s?: [number, number, number] };
type Span = [number, number];
type PartDef = {
  name: string;
  boxes: Box[];
  /** In the turret: it turns with the guns. */
  turret?: boolean;
  poses: Record<Shape, Pose>;
  /** When, in the unfolding of each shape (0..1), this part moves. */
  when: Record<Form, Span>;
};

const HALF = Math.PI / 2;
const deg = (a: number): number => (a * Math.PI) / 180;

/** The parts that come in pairs: `s` is 1 on the left (+X), -1 on the right. */
function sides(make: (s: 1 | -1) => PartDef): PartDef[] {
  return [make(1), make(-1)];
}

const DEFS: PartDef[] = [
  {
    name: 'body',
    boxes: [[-1.5, -0.2, -4.5, 3, 1.6, 9, WHITE], [-1.5, -1.2, -4.5, 3, 1, 9, BELLY]],
    poses: { plane: { p: [0, 4.3, 1.5] }, fold: { p: [0, 2.2, 1.5] }, boat: { p: [0, 1.2, 1.5] }, tank: { p: [0, 2.2, 0] } },
    when: { plane: [0, 0.55], boat: [0, 0.5], tank: [0, 0.5] },
  },
  {
    name: 'nose',
    boxes: [[-1.55, -1.25, 0, 3.1, 2.7, 0.8, GOLD], [-1.2, -1, 0.8, 2.4, 2.2, 1.6, DARK], [-0.4, -0.3, 2.4, 0.8, 0.8, 0.5, INK]],
    poses: { plane: { p: [0, 4.3, 5.2] }, fold: { p: [0, 2.2, 5.2] }, boat: { p: [0, 1.2, 5.2] }, tank: { p: [0, 2.2, 3.7] } },
    when: { plane: [0, 0.55], boat: [0, 0.5], tank: [0, 0.5] },
  },
  {
    name: 'tail',
    boxes: [[-1, -0.1, -4, 2, 1.3, 4, WHITE], [-1, -0.7, -4, 2, 0.6, 4, BELLY], [-0.6, -0.3, -5.6, 1.2, 1.2, 1.6, WHITE]],
    poses: { plane: { p: [0, 4.3, -3] }, fold: { p: [0, 2.2, -3] }, boat: { p: [0, 1.2, -3] }, tank: { p: [0, 2.2, -1] } },
    when: { plane: [0, 0.55], boat: [0, 0.5], tank: [0, 0.5] },
  },
  {
    // The fin: the boat's mast; drawn down into the tail on the tank.
    name: 'fin',
    boxes: [[-0.25, 0, -1.3, 0.5, 2.6, 2.6, WHITE], [-0.25, 2.6, -1, 0.5, 0.8, 2, GOLD]],
    poses: { plane: { p: [0, 5.1, -7.3] }, fold: { p: [0, 3, -7.3] }, boat: { p: [0, 2, -7.3] }, tank: { p: [0, 1, -5] } },
    when: { plane: [0, 0.55], boat: [0, 0.5], tank: [0, 0.5] },
  },
  ...sides((s) => ({
    // The tailplane: swept aft, it is the boat's stern step and the tank's engine deck.
    name: `stab${s}`,
    boxes: [[0, 0, -1.1, 3.6, 0.35, 2.2, WHITE]] as Box[],
    poses: {
      plane: { p: [0, 4.7, -7.3], r: s > 0 ? [] : [['y', Math.PI]] },
      fold: { p: [s * 1.15, 2.7, -6.6], r: [['y', HALF]] },
      boat: { p: [s * 1.15, 1.7, -6.6], r: [['y', HALF]] },
      tank: { p: [s * 1.15, 3.4, -4.6], r: [['y', HALF]] },
    },
    when: { plane: [0.4, 0.95], boat: [0, 0.45], tank: [0.05, 0.5] },
  })),
  ...sides((s) => ({
    // A wing: swept back along the body, then stood up as the boat's side, or laid over the track as the tank's skirt.
    name: `wing${s}`,
    boxes: [
      [0, -0.25, -1.7, 7.5, 0.5, 3.4, WHITE], [7.5, -0.25, -1.7, 2, 0.5, 3.4, GOLD],
      [9.3, -0.2, -0.3, 0.5, 0.4, 0.7, s > 0 ? '!#ff5d5d' : '!#4ade80'],
    ] as Box[],
    poses: {
      plane: { p: [0, 5.15, 2.3], r: s > 0 ? [] : [['y', Math.PI]] },
      fold: { p: [s * 3.3, 2.7, 3.3], r: [['y', HALF]] },
      boat: { p: [s * 3.53, 1, 3.3], r: [['y', HALF], ['z', s * deg(70)]] },
      tank: { p: [s * 2.78, 2.92, 4.75], r: [['y', HALF], ['z', s * deg(-30)]], s: [1, 1, 0.8] },
    },
    when: { plane: [0.25, 0.9], boat: [0.15, 0.8], tank: [0.3, 0.85] },
  })),
  ...sides((s) => ({
    // A float: a hull beside the boat's; the upper run of the tank's track.
    name: `float${s}`,
    boxes: [[-0.7, -0.55, -4.75, 1.4, 1.1, 9.5, WHITE], [-0.5, -0.35, 4.75, 1, 0.8, 1.2, WHITE]] as Box[],
    poses: { plane: { p: [s * 3.4, 0.85, 1.25] }, fold: { p: [s * 2.2, 0.75, 1.25] }, boat: { p: [s * 2.2, 0.75, 1.25] }, tank: { p: [s * 2.6, 1.75, -0.4] } },
    when: { plane: [0, 0.6], boat: [0, 0.4], tank: [0.1, 0.6] },
  })),
  ...sides((s) => ({
    // Its sole: on the tank it drops to the ground, and is the track's lower run.
    name: `sole${s}`,
    boxes: [[-0.7, -0.15, -4.3, 1.4, 0.3, 8.6, SOLE]] as Box[],
    poses: { plane: { p: [s * 3.4, 0.2, 1.1] }, fold: { p: [s * 2.2, 0.15, 1.1] }, boat: { p: [s * 2.2, 0.15, 1.1] }, tank: { p: [s * 2.6, 0.15, -0.4], s: [1, 1, 1.1] } },
    when: { plane: [0, 0.6], boat: [0, 0.4], tank: [0.1, 0.6] },
  })),
  ...sides((s) => ({
    // The wheels, inside the float until the track opens.
    name: `wheels${s}`,
    boxes: [0, 1, 2, 3, 4].map((i) => [-0.55, -0.45, -4.3 + i * 1.85, 1.1, 0.9, 1.3, STEEL] as Box),
    poses: {
      plane: { p: [s * 3.4, 0.85, 1.25], s: [0.9, 0.5, 0.95] }, fold: { p: [s * 2.2, 0.75, 1.25], s: [0.9, 0.5, 0.95] },
      boat: { p: [s * 2.2, 0.75, 1.25], s: [0.9, 0.5, 0.95] }, tank: { p: [s * 2.6, 0.75, -0.4], s: [1.05, 1, 1] },
    },
    when: { plane: [0, 0.6], boat: [0, 0.4], tank: [0.3, 0.75] },
  })),
  ...sides((s) => ({
    // The struts: they carry the plane on its floats, and are drawn in for the rest.
    name: `strut${s}`,
    boxes: [[-0.15, 0, -1.65, 0.3, 2.1, 0.3, STEEL_DARK], [-0.15, 0, 1.35, 0.3, 2.1, 0.3, STEEL_DARK]] as Box[],
    poses: {
      plane: { p: [s * 3.4, 1.4, 1.7] }, fold: { p: [s * 2.2, 0.7, 1.7], s: [1, 0.05, 1] },
      boat: { p: [s * 2.2, 0.7, 1.7], s: [1, 0.05, 1] }, tank: { p: [s * 2.6, 1.7, 0], s: [1, 0.05, 1] },
    },
    when: { plane: [0.15, 0.75], boat: [0, 0.4], tank: [0, 0.4] },
  })),
  {
    // What lifts the canopy into a wheelhouse: inside the fuselage otherwise.
    name: 'riser',
    boxes: [[-1.25, 0, -1.85, 2.5, 1.6, 3.7, WHITE], [-1.3, 1.3, -1.9, 2.6, 0.3, 3.8, STEEL_DARK]],
    poses: {
      plane: { p: [0, 4.6, 1.8], s: [0.9, 0.3, 0.9] }, fold: { p: [0, 2.5, 1.8], s: [0.9, 0.3, 0.9] },
      boat: { p: [0, 2.6, -1.2] }, tank: { p: [0, 2.5, 0.5], s: [0.9, 0.3, 0.9] },
    },
    when: { plane: [0, 0.4], boat: [0.35, 0.85], tank: [0, 0.4] },
  },
  {
    name: 'canopy',
    boxes: [[-1, 0, -1.6, 2, 1.1, 3.2, GLASS], [-1.05, 0, -0.1, 2.1, 1.15, 0.25, DARK]],
    poses: { plane: { p: [0, 5.7, 1.8] }, fold: { p: [0, 3.6, 1.8] }, boat: { p: [0, 4.2, -1.2] }, tank: { p: [0, 3.6, 3], s: [1, 0.7, 0.6] } },
    when: { plane: [0, 0.55], boat: [0.35, 0.85], tank: [0.3, 0.7] },
  },
  {
    // The turret's housing: inside the fuselage on the plane.
    name: 'mount', turret: true,
    boxes: [[-1.7, 0, -1.7, 3.4, 1, 3.4, STEEL_DARK], [-1.2, 1, -1.4, 2.4, 1.5, 2.9, STEEL], [-1.3, 2.5, -1.5, 2.6, 0.3, 3.1, STEEL_LIGHT]],
    poses: {
      plane: { p: [0, -0.6, 0], s: [0.5, 0.3, 0.5] }, fold: { p: [0, -0.6, 0], s: [0.5, 0.3, 0.5] },
      boat: { p: [0, 0, 0] }, tank: { p: [0, 0, 0], s: [1.35, 0.85, 1.5] },
    },
    when: { plane: [0, 0.4], boat: [0.45, 0.85], tank: [0.45, 0.85] },
  },
  ...sides((s) => ({
    // A gun: under a wing on the plane, in the turret on the rest — run out long on the tank.
    name: `gun${s}`, turret: true,
    boxes: [[-0.225, -0.225, 0, 0.45, 0.45, 2.4, INK]] as Box[],
    poses: {
      plane: { p: [s * 5.025, 0.375, 1.4] }, fold: { p: [s * 0.5, 0.3, 0.5], s: [1, 1, 0.6] },
      boat: { p: [s * 0.63, 1.725, 1.4], s: [1, 1, 1.85] }, tank: { p: [s * 0.5, 1.2, 2.4], s: [1.6, 1.6, 2.9] },
    },
    when: { plane: [0.5, 1], boat: [0.6, 1], tank: [0.6, 1] },
  })),
];

/** Where the turret turns, on each shape. */
const PIVOT: Record<Shape, [number, number, number]> = { plane: [0, 4.3, 2], fold: [0, 2.2, 2], boat: [0, 2.6, 3.4], tank: [0, 3.6, -0.6] };
const PIVOT_WHEN: Record<Form, Span> = { plane: [0, 0.55], boat: [0, 0.5], tank: [0, 0.5] };

/**
 * How high the middle of each shape is over its soles: what a craft calls
 * its position (plane: the fuselage; boat: its deck line; tank: the ground).
 */
export const DATUM: Record<Form, number> = { plane: 4.3, boat: 1.3, tank: 0 };
/** The turret's pivot, and how far along the guns the muzzles are, for each shape that has one. */
export const TURRET: Record<'boat' | 'tank', { y: number; z: number; gun: number; reach: number }> = {
  boat: { y: PIVOT.boat[1], z: PIVOT.boat[2], gun: 1.725, reach: 1.4 + 2.4 * 1.85 },
  tank: { y: PIVOT.tank[1], z: PIVOT.tank[2], gun: 1.2, reach: 2.4 + 2.4 * 2.9 },
};
/** Where the nose part's front is (the propeller's place), in the nose's own frame. */
export const NOSE_TIP = 2.95;

type Set = { p: Vector3; q: Quaternion; s: Vector3 };
type Part = { group: Group; sets: Record<Shape, Set>; when: Record<Form, Span> };

const AXIS = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };
const q1 = new Quaternion();
const ONE = new Quaternion();

function setOf(pose: Pose): Set {
  const q = new Quaternion();
  // Each turn about a fixed axis, in the order written.
  for (const [axis, angle] of pose.r ?? []) q.premultiply(q1.setFromAxisAngle(AXIS[axis], angle));
  return { p: new Vector3(...pose.p), q, s: new Vector3(...(pose.s ?? [1, 1, 1])) };
}

const models = new Map<string, Model>();
const ease = (k: number): number => k * k * (3 - 2 * k);
const within = (k: number, [from, to]: Span): number => ease(Math.max(0, Math.min(1, (k - from) / (to - from))));

export class Machine {
  /** Its soles' frame: a craft puts it where it is. */
  readonly root = new Group();
  /** What turns with the guns, about the turret's pivot. */
  readonly turret = new Group();
  private parts = new Map<string, Part>();
  private pivots: Record<Shape, Vector3>;
  /** The turret's bearing when a turn began: it comes back to centre first. */
  private bearing = new Quaternion();

  constructor(public form: Form) {
    this.root.add(this.turret);
    this.pivots = { plane: new Vector3(...PIVOT.plane), boat: new Vector3(...PIVOT.boat), tank: new Vector3(...PIVOT.tank), fold: new Vector3(...PIVOT.fold) };
    for (const def of DEFS) {
      let model = models.get(def.name);
      if (!model) { model = buildModel(def.boxes); models.set(def.name, model); }
      const group = instance(model);
      (def.turret ? this.turret : this.root).add(group);
      this.parts.set(def.name, {
        group, when: def.when,
        sets: { plane: setOf(def.poses.plane), boat: setOf(def.poses.boat), tank: setOf(def.poses.tank), fold: setOf(def.poses.fold) },
      });
    }
    this.set(form);
  }

  /** A part, to hang something on (a propeller on the nose, lights). */
  part(name: string): Group {
    return this.parts.get(name)!.group;
  }

  /** Stand in a shape, whole. */
  set(form: Form): void {
    this.form = form;
    for (const part of this.parts.values()) {
      const to = part.sets[form];
      part.group.position.copy(to.p);
      part.group.quaternion.copy(to.q);
      part.group.scale.copy(to.s);
    }
    this.turret.position.copy(this.pivots[form]);
  }

  /** A turn begins: the turret will come back to centre from where it points now. */
  begin(): void {
    this.bearing.copy(this.turret.quaternion);
  }

  /**
   * Part of the way from one shape to another (k: 0..1): the first folds into
   * the state common to all, the second unfolds from it, each part in its time.
   */
  blend(from: Form, to: Form, k: number): void {
    const folding = k < 0.5;
    const form = folding ? from : to;
    // How far out of the fold this half is: all the way at either end of the turn, none in the middle.
    const open = folding ? 1 - k * 2 : k * 2 - 1;
    for (const part of this.parts.values()) {
      const a = part.sets.fold;
      const b = part.sets[form];
      const t = within(open, part.when[form]);
      part.group.position.lerpVectors(a.p, b.p, t);
      part.group.quaternion.slerpQuaternions(a.q, b.q, t);
      part.group.scale.lerpVectors(a.s, b.s, t);
    }
    this.turret.position.lerpVectors(this.pivots.fold, this.pivots[form], within(open, PIVOT_WHEN[form]));
    this.turret.quaternion.slerpQuaternions(this.bearing, ONE, ease(Math.min(1, k * 5)));
    if (k >= 1) this.form = to;
  }

  /** Point the guns along a direction of the world (null: straight ahead). */
  aim(dir: Vector3 | null): void {
    if (!dir) { this.turret.quaternion.identity(); return; }
    // In the hull's own frame: a bearing, an elevation.
    v1.copy(dir).applyQuaternion(q1.copy(this.root.quaternion).invert());
    this.turret.rotation.set(-Math.asin(Math.max(-1, Math.min(1, v1.y))), Math.atan2(v1.x, v1.z), 0, 'YXZ');
  }

  /** The turret's pivot, in the world. */
  pivot(out: Vector3): Vector3 {
    return out.copy(this.turret.position).applyQuaternion(this.root.quaternion).add(this.root.position);
  }
}

const v1 = new Vector3();
