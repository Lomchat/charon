// Every model of the mini-game's 3D phase, as boxes (voxels.ts): what walks
// the island, what flies, what sails, and what stands there. Noses point to
// +Z, +Y is up, +X is the LEFT side. The robots and the pilot are the board's
// own sprites, given a depth.
//
// Two scales: what comes from the board's pixels (the pilot, the robots on
// foot, pods, pickups, the helicopter) is modelled one unit per PIXEL and
// drawn at `SCALE` (world.ts); the vehicles and what fights them are modelled
// in world units.
import type { Form } from '../forms';
import { chutePixels, heliPixels, heroPixels, pickupPixels, robotPixels, type PickupKind, type RobotKind } from '../art';
import { buildModel, extrude, place, turn, type Box, type Model } from './voxels';

const STEEL = '#343c50';
const STEEL_DARK = '#1c2230';
const STEEL_LIGHT = '#5a6480';
const INK = '#10131b';
const GOLD = '#ffe066';
const EYE = '!#ff4d4d';
const FLAME = '!#ffb86b';
const FLAME_HOT = '!#fff3c9';

/* ─────────────────────────────────────────────────────── the robots ─── */

/** A colour, darker. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const part = (shift: number) => Math.min(255, Math.round(((n >> shift) & 255) * k)).toString(16).padStart(2, '0');
  return `#${part(16)}${part(8)}${part(0)}`;
}

/** A sprite's pixels and palette for the air: its ink outline becomes a dark
 *  rim of its own colour — black lines are drawn, a solid has edges. */
function pixels(kind: RobotKind, legs: 'stand' | 'walkA' | 'walkB' = 'stand'): ReturnType<typeof robotPixels> {
  const { rows, pal, eyes } = robotPixels(kind, legs);
  return { rows, eyes, pal: { ...pal, o: shade(pal.D, 0.62) } };
}

/** A board robot in 3D: thick head, thinner limbs, its eyes lit red. */
function robot(kind: RobotKind, legs: 'stand' | 'walkA' | 'walkB' = 'stand', tint?: string): Box[] {
  const source = pixels(kind, legs);
  const { rows, eyes } = source;
  // A bomber wears its warning: the same robot, its plating reddened.
  const pal = tint ? { ...source.pal, B: tint, H: shade(tint, 1.15), D: shade(tint, 0.7), o: shade(tint, 0.45) } : source.pal;
  const lit = (x: number, y: number) => (eyes.some(([ex, ey, ew, eh]) => x >= ex && x < ex + ew && y >= ey && y < ey + eh) ? EYE : null);
  // Rows 0–9: the head; 10–15: torso and arms; 16–19: legs. The outline sits a little back.
  const depth = (key: string, _x: number, y: number) => (y < 10 ? 9 : y < 16 ? 6 : 4) - (key === 'o' ? 2 : 0);
  return faceForward(extrude(rows, pal, depth, lit), pal.V);
}

/** Eyes are on the face only: behind them, the back of the head. */
function faceForward(boxes: Box[], back: string): Box[] {
  return boxes.flatMap((box): Box[] => {
    const [x, y, z, w, h, d, c] = box;
    return c === EYE ? [[x, y, z + d - 1.6, w, h, 1.6, c], [x, y, z, w, h, d - 1.6, back]] : [box];
  });
}

/** Two tanks on its back, burning. */
function jetpack(): Box[] {
  return [
    [-3.4, 5, -5.4, 2.6, 6, 2.6, STEEL], [0.8, 5, -5.4, 2.6, 6, 2.6, STEEL],
    [-3.4, 10.6, -5.4, 2.6, 0.8, 2.6, STEEL_LIGHT], [0.8, 10.6, -5.4, 2.6, 0.8, 2.6, STEEL_LIGHT],
    [-2.9, 3, -4.9, 1.6, 2, 1.6, FLAME], [1.3, 3, -4.9, 1.6, 2, 1.6, FLAME],
    [-2.5, 1.4, -4.5, 0.8, 1.8, 0.8, FLAME_HOT], [1.7, 1.4, -4.5, 0.8, 1.8, 0.8, FLAME_HOT],
  ];
}

function drone(): Box[] {
  const b: Box[] = [
    [-1.3, -0.7, -1.8, 2.6, 1.4, 3.6, STEEL],
    [-1.0, 0.7, -1.2, 2.0, 0.5, 2.4, STEEL_LIGHT],
    [-0.6, -0.3, 1.8, 1.2, 0.6, 0.35, EYE],
    [-3.2, 0.1, 1.5, 6.4, 0.3, 0.5, STEEL_DARK],
    [-3.2, 0.1, -2.0, 6.4, 0.3, 0.5, STEEL_DARK],
    [-0.1, 1.2, -1.0, 0.2, 1.4, 0.2, STEEL_DARK],
    [-0.25, 2.5, -1.15, 0.5, 0.4, 0.5, EYE],
  ];
  for (const [x, z] of [[3.1, 1.75], [-3.1, 1.75], [3.1, -1.75], [-3.1, -1.75]]) {
    b.push([x - 1.1, 0.45, z - 1.1, 2.2, 0.16, 2.2, '#9aa1b1']);
    b.push([x - 0.2, -0.2, z - 0.2, 0.4, 0.7, 0.4, STEEL_DARK]);
  }
  return b;
}

/** A robot on its feet, a gun in its hand, a jetpack on its back. */
function gunner(): Box[] {
  return place([
    ...place(robot('codex'), 0, 0, 0),
    ...jetpack(),
    [-7.4, 4.6, 1, 1.2, 1.2, 6, INK], [-7.2, 4.9, 6.6, 0.8, 0.8, 0.5, EYE],
  ], 0, -6.5, 0, 0.72);
}

/** A robot riding a delta wing, two burners behind. */
function ace(): Box[] {
  const wing = '#586882';
  const edge = '#9fb1cc';
  const board: Box[] = [
    [-2, 0, 5, 4, 0.7, 4, wing], [-4.5, 0, 1.5, 9, 0.7, 3.5, wing], [-7.5, 0, -2, 15, 0.7, 3.5, wing],
    [-10, 0, -5, 20, 0.7, 3, wing],
    [-10.4, 0.1, -5.2, 0.5, 0.5, 3.2, EYE], [9.9, 0.1, -5.2, 0.5, 0.5, 3.2, EYE],
    [-0.5, 0.1, 9, 1, 0.5, 1.4, edge],
    [-3.6, -0.9, -5.6, 2.2, 1.6, 3, STEEL], [1.4, -0.9, -5.6, 2.2, 1.6, 3, STEEL],
    [-3.2, -0.6, -7.2, 1.4, 1, 1.6, FLAME], [1.8, -0.6, -7.2, 1.4, 1, 1.6, FLAME],
    [-2.9, -0.4, -8.6, 0.8, 0.6, 1.4, FLAME_HOT], [2.1, -0.4, -8.6, 0.8, 0.6, 1.4, FLAME_HOT],
  ];
  return [...board, ...place(robot('cursor'), 0, 0.7, -0.5, 0.62)];
}

/** A gunship: a wide hull under two rotors, a robot's head for a bridge. */
function bomber(): Box[] {
  const clay = '#d97757';
  const dark = '#a5543a';
  const { rows, pal, eyes } = pixels('claude');
  const head = faceForward(extrude(rows.slice(0, 10), pal, (key) => (key === 'o' ? 7 : 9),
    (x, y) => (eyes.some(([ex, ey, ew, eh]) => x >= ex && x < ex + ew && y >= ey && y < ey + eh) ? EYE : null)), pal.V);
  const b: Box[] = [
    [-7, -3, -11, 14, 5, 22, clay],
    [-7.2, -3.4, -10, 14.4, 1, 20, dark],
    [-5, 2, -9, 10, 1.4, 12, dark],
    [-6, -2, 11, 12, 3.4, 2.6, dark],
    // Windows.
    [-7.15, -0.4, 2, 0.3, 1, 6, '!#ffd98a'], [6.85, -0.4, 2, 0.3, 1, 6, '!#ffd98a'],
    // Rotor pods on stub wings.
    [-15, -0.4, -2, 8, 1, 4, STEEL], [7, -0.4, -2, 8, 1, 4, STEEL],
    [-15.5, -1.4, -3, 4, 3, 6, STEEL_DARK], [11.5, -1.4, -3, 4, 3, 6, STEEL_DARK],
    [-17, 1.7, -4.5, 7, 0.2, 9, '#9aa1b1'], [10, 1.7, -4.5, 7, 0.2, 9, '#9aa1b1'],
    // Missile racks.
    [-4.4, -4.4, -3, 1.2, 1.2, 7, STEEL_DARK], [3.2, -4.4, -3, 1.2, 1.2, 7, STEEL_DARK],
    [-4.2, -4.2, 4, 0.8, 0.8, 1, EYE], [3.4, -4.2, 4, 0.8, 0.8, 1, EYE],
    // Tail fins and burners.
    [-0.4, 2, -11.5, 0.8, 5, 4, dark],
    [-5, -1.6, -12.6, 3, 2.4, 1.6, FLAME], [2, -1.6, -12.6, 3, 2.4, 1.6, FLAME],
  ];
  return [...b, ...place(head, 0, 2.6, 6, 0.9)];
}

/** The dreadnought: a colossal head, engines at its temples, guns under its jaw. */
function boss(): Box[] {
  const { rows, pal } = pixels('cursor');
  const head = rows.slice(2, 10);
  // Its whole visor burns.
  const face = faceForward(extrude(head, pal, (key) => (key === 'o' ? 8 : 10), (x, y) => (head[y][x] === 'V' ? EYE : null)), STEEL_DARK);
  const big = place(face, 0, -4, 0, 5.6);
  const pod = (side: number): Box[] => [
    [side * 44 - 7, -6, -22, 14, 14, 40, STEEL],
    [side * 44 - 8, 8, -20, 16, 2, 36, STEEL_LIGHT],
    [side * 44 - 5, -4, 18, 10, 10, 3, STEEL_DARK],
    [side * 44 - 4, -3, -27, 8, 8, 5, FLAME],
    [side * 44 - 2.5, -1.5, -32, 5, 5, 5, FLAME_HOT],
    [side * 36 - 6, -1, -4, 12, 4, 8, STEEL_DARK],
  ];
  const b: Box[] = [
    ...pod(1), ...pod(-1),
    // Antennas and a crown of lights.
    [-1, 40, -6, 2, 16, 2, STEEL_DARK], [-2, 55, -7, 4, 3, 4, EYE],
    [-20, 40, -4, 1.5, 9, 1.5, STEEL_DARK], [18.5, 40, -4, 1.5, 9, 1.5, STEEL_DARK],
    // Turrets under the jaw.
    [-22, -10, 6, 8, 6, 8, STEEL_DARK], [14, -10, 6, 8, 6, 8, STEEL_DARK], [-4, -11, 10, 8, 7, 8, STEEL_DARK],
    [-19.5, -9, 14, 3, 3, 9, INK], [16.5, -9, 14, 3, 3, 9, INK], [-1.5, -9.5, 18, 3, 3, 10, INK],
    [-19, -8.5, 22.6, 2, 2, 1, EYE], [17, -8.5, 22.6, 2, 2, 1, EYE], [-1, -9, 27.6, 2, 2, 1, EYE],
    // Its back: plating, so it is not a mask.
    [-30, -2, -34, 60, 36, 8, STEEL_DARK], [-24, 4, -40, 48, 24, 6, STEEL],
    [-8, 10, -46, 16, 12, 6, FLAME], [-5, 13, -52, 10, 6, 6, FLAME_HOT],
  ];
  return [...big, ...b];
}

function missile(tip: string): Box[] {
  return [
    [-0.35, -0.35, -1.8, 0.7, 0.7, 3.2, '#dfe6f2'],
    [-0.3, -0.3, 1.4, 0.6, 0.6, 0.8, tip],
    [-1, -0.08, -1.8, 2, 0.16, 0.9, STEEL], [-0.08, -1, -1.8, 0.16, 2, 0.9, STEEL],
    [-0.25, -0.25, -2.6, 0.5, 0.5, 0.8, FLAME_HOT],
  ];
}

/** A crate under a balloon: repairs and missiles, to fly through. */
function supply(): Box[] {
  return [
    [-3, -3, -3, 6, 6, 6, '#7a5c3e'],
    [-3.1, -0.6, -3.1, 6.2, 1.2, 6.2, GOLD],
    [-0.6, -3.1, -3.1, 1.2, 6.2, 6.2, '#5c452f'],
    [-0.1, 3, -0.1, 0.2, 7, 0.2, '#cfd6e6'],
    [-4, 10, -4, 8, 6, 8, '!#35d0c7'], [-3, 16, -3, 6, 2, 6, '!#35d0c7'], [-3, 8.6, -3, 6, 1.4, 6, '!#2aa6a0'],
  ];
}

/* ───────────────────────────────────────────── on foot (pixel units) ─── */

/** The pilot: the board's sprite, a thick head, thinner limbs. */
function hero(legs: 'stand' | 'walkA' | 'walkB'): Box[] {
  const { rows, pal } = heroPixels(legs);
  const boxes = extrude(rows, pal, (_key, _x, y) => (y < 6 ? 7 : y < 12 ? 5 : 4));
  // A face is a front: behind it (the head's rows), the same hair as on top.
  const head = rows.length - 6;
  return boxes.flatMap((box): Box[] => {
    const [x, y, z, w, h, d, c] = box;
    return y >= head && (c === pal.s || c === pal.k) ? [[x, y, z + d - 2, w, h, 2, c], [x, y, z, w, h, d - 2, pal.r]] : [box];
  });
}

/** The helicopter of the drops: its side view, given a body, a rotor, a tail. */
function heli(): Box[] {
  const { rows, pal } = heliPixels();
  const body = turn(extrude(rows, { ...pal, o: shade(pal.D, 0.6) }, (key, x) => (key === 'c' || key === 'C' ? 9 : x > 22 ? 3 : 10)));
  return [
    ...body,
    [-22, 11, -2, 44, 0.6, 3, '#cfd6e6'], [-1.5, 11, -22, 3, 0.6, 44, '#7f879a'],
    [-0.4, 10, -0.4, 0.8, 1.2, 0.8, INK],
  ];
}

/** A pod that brings a robot down. */
function pod(): Box[] {
  return [
    [-3, 2, -3, 6, 9, 6, STEEL], [-2.2, 11, -2.2, 4.4, 2, 4.4, STEEL_LIGHT], [-1, 13, -1, 2, 1.2, 2, EYE],
    [-3.6, 0, -0.6, 7.2, 3, 1.2, STEEL_DARK], [-0.6, 0, -3.6, 1.2, 3, 7.2, STEEL_DARK],
    [-3.1, 5, -1, 0.3, 2, 2, EYE], [2.8, 5, -1, 0.3, 2, 2, EYE],
  ];
}

/** A pickup: a dark crate with coloured rims, its sign lit on its top and its faces. */
function pickup(kind: PickupKind): Box[] {
  const { frame, ink, glyph } = pickupPixels(kind);
  const lit = `!${ink}`;
  const b: Box[] = [
    [-5, 0, -5, 10, 10, 10, '#10131b'],
    [-5.5, 0, -5.5, 11, 1.4, 11, frame], [-5.5, 9, -5.5, 11, 1.4, 11, frame],
  ];
  glyph.forEach((row, j) => {
    for (let i = 0; i < row.length; i += 1) {
      if (row[i] !== '#') continue;
      b.push([i - 2.5, 10.4, j - 2.5, 1, 0.5, 1, lit]);
      b.push([i - 2.5, 7.4 - j, 5, 1, 1, 0.5, lit], [1.5 - i, 7.4 - j, -5.5, 1, 1, 0.5, lit]);
    }
  });
  return b;
}

function chute(): Box[] {
  const { rows, pal } = chutePixels();
  return extrude(rows, pal, (key) => (key === 'o' ? 2 : 10));
}

/* ───────────────────────────────────────────────── on the water ─── */

/** A robot on a jet-ski. */
function skimmer(): Box[] {
  const red = '#8a3038';
  return [
    [-1.7, -0.5, -4.2, 3.4, 1.7, 8, red], [-1.1, -0.3, 3.8, 2.2, 1.3, 1.8, red], [-0.5, -0.1, 5.6, 1, 0.9, 1, shade(red, 0.7)],
    [-1.75, 0.3, -4.2, 3.5, 0.4, 8, '#ffb86b'], [-1, 1.2, -3, 2, 0.7, 3.4, INK], [-1.6, 1.4, 1.6, 3.2, 0.5, 0.5, STEEL_LIGHT],
    [-0.7, -0.2, -5, 1.4, 0.9, 0.9, FLAME],
    ...place(robot('cursor'), 0, 1.4, -1.4, 0.36),
  ];
}

/** A floating mine: it drifts to the boat. */
function mine(): Box[] {
  const b: Box[] = [[-2.4, -2.4, -2.4, 4.8, 4.8, 4.8, STEEL_DARK], [-2.9, -1.4, -1.4, 5.8, 2.8, 2.8, STEEL], [-1.4, -1.4, -2.9, 2.8, 2.8, 5.8, STEEL], [-1.4, -2.9, -1.4, 2.8, 5.8, 2.8, STEEL]];
  for (const [x, y, z] of [[3.4, 0, 0], [-3.4, 0, 0], [0, 0, 3.4], [0, 0, -3.4], [0, 3.4, 0], [2.4, 2.4, 2.4], [-2.4, 2.4, -2.4], [2.4, 2.4, -2.4], [-2.4, 2.4, 2.4]]) {
    b.push([x - 0.4, y - 0.4, z - 0.4, 0.8, 0.8, 0.8, STEEL_LIGHT]);
  }
  b.push([-0.5, 2.9, -0.5, 1, 0.8, 1, EYE]);
  return b;
}

/** The robots' own gunboat: thick, a robot's head for a bridge, guns fore and aft. */
function warship(): Box[] {
  const clay = '#a5543a';
  const { rows, pal, eyes } = pixels('claude');
  const head = faceForward(extrude(rows.slice(0, 10), pal, (key) => (key === 'o' ? 7 : 9),
    (x, y) => (eyes.some(([ex, ey, ew, eh]) => x >= ex && x < ex + ew && y >= ey && y < ey + eh) ? EYE : null)), pal.V);
  return [
    [-6, -1.6, -15, 12, 3.6, 26, STEEL], [-4.6, -1.6, 11, 9.2, 3.6, 3, STEEL], [-2.8, -1.6, 14, 5.6, 3.4, 2.4, STEEL], [-1.2, -1.4, 16.4, 2.4, 3, 1.6, STEEL],
    [-6.05, 0.6, -15, 12.1, 0.6, 26, clay], [-5.4, 2, -14.4, 10.8, 0.4, 25, STEEL_DARK],
    [-3.6, 2.4, -9, 7.2, 3.4, 8, clay], [-3.66, 4, -8, 7.32, 1, 6, '!#ffd98a'],
    [-2, 2.4, 4, 4, 1.6, 4, STEEL_DARK], [-0.4, 3, 7.6, 0.8, 0.8, 5.4, INK], [-0.3, 3.1, 12.8, 0.6, 0.6, 0.6, EYE],
    [-2, 2.4, -14, 4, 1.6, 3.6, STEEL_DARK], [-0.4, 3, -17.6, 0.8, 0.8, 4, INK],
    [-4.4, -0.6, -16.2, 2.4, 2, 1.4, FLAME], [2, -0.6, -16.2, 2.4, 2, 1.4, FLAME],
    ...place(head, 0, 5.8, -5, 0.62),
  ];
}

/* ─────────────────────────────────────────── what stands on the islands ─── */

/** A machine's beacon, seen from the air: a banded tower, its lamp lit. */
function lighthouse(): Box[] {
  return [
    [-9, 0, -9, 18, 8, 18, '#232a3a'], [-7, 8, -7, 14, 3, 14, '#2f3950'],
    [-5.5, 11, -5.5, 11, 12, 11, '#e8eef9'], [-5, 23, -5, 10, 9, 10, '#b5483f'],
    [-4.5, 32, -4.5, 9, 11, 9, '#e8eef9'], [-4, 43, -4, 8, 7, 8, '#b5483f'],
    [-6.5, 50, -6.5, 13, 1.6, 13, '#232a3a'],
    [-3.2, 51.6, -3.2, 6.4, 6.4, 6.4, '!#fff3c9'],
    [-4.6, 58, -4.6, 9.2, 2, 9.2, '#b5483f'], [-2.6, 60, -2.6, 5.2, 2.4, 5.2, '#8a342d'],
    [-0.4, 62.4, -0.4, 0.8, 4, 0.8, '#232a3a'],
  ];
}

function lantern(): Box[] {
  return [
    [-0.5, 0, -0.5, 1, 9, 1, '#14161d'], [-1.2, 9, -1.2, 2.4, 0.6, 2.4, '#14161d'],
    [-1, 9.6, -1, 2, 2.6, 2, '!#ffc763'], [-1.3, 12.2, -1.3, 2.6, 0.7, 2.6, '#14161d'],
  ];
}

function bush(): Box[] {
  return [
    [-4, 0, -3, 8, 3, 6, '#2f5a41'], [-2.6, 3, -2.2, 5.2, 2, 4.4, '#44805a'], [-5, 0, -1.4, 2, 1.6, 3, '#22382e'],
  ];
}

function consoleDesk(): Box[] {
  return [
    [-9, 0, -2.5, 18, 5, 5, '#343c50'], [-9.5, 5, -3, 19, 1, 6, '#5a6480'],
    [-6, 6, -1.6, 12, 5, 0.6, '#262c3b'], [-5.4, 6.6, -0.95, 10.8, 3.8, 0.2, '!#7cc4ff'],
  ];
}

type Frames = Record<'stand' | 'walkA' | 'walkB', Model>;

export type SkyModels = {
  drone: Model; gunner: Model; ace: Model; bomber: Model; boss: Model;
  missile: Model; foeMissile: Model; supply: Model;
  skimmer: Model; mine: Model; warship: Model;
  lighthouse: Model; lantern: Model; bush: Model; console: Model;
  /** On foot, in pixel units: the pilot, each robot (and the reddened one), in their walk's frames. */
  hero: Frames;
  walker: Record<RobotKind | 'red', Frames>;
  heli: Model; pod: Model; chute: Model;
  pickup: Record<PickupKind, Model>;
};

const FRAMES = ['stand', 'walkA', 'walkB'] as const;
const frames = (make: (legs: (typeof FRAMES)[number]) => Box[]): Frames => Object.fromEntries(FRAMES.map((f) => [f, buildModel(make(f))])) as Frames;
const PICKUP_KINDS: PickupKind[] = ['smg', 'shotgun', 'laser', 'rocket', 'flame', 'med', 'bomb', 'shield', 'x2'];

let cache: SkyModels | null = null;

export function skyModels(): SkyModels {
  cache ??= {
    drone: buildModel(drone()),
    gunner: buildModel(gunner()),
    ace: buildModel(ace()),
    bomber: buildModel(bomber(), 1.5),
    boss: buildModel(boss()),
    missile: buildModel(missile('!#ffe066'), 1.3),
    foeMissile: buildModel(missile(EYE), 1.6),
    supply: buildModel(supply()),
    skimmer: buildModel(skimmer()),
    mine: buildModel(mine()),
    warship: buildModel(warship()),
    hero: frames(hero),
    walker: {
      claude: frames((legs) => robot('claude', legs)),
      codex: frames((legs) => robot('codex', legs)),
      cursor: frames((legs) => robot('cursor', legs)),
      red: frames((legs) => robot('claude', legs, '#c8322f')),
    },
    heli: buildModel(heli()),
    pod: buildModel(pod()),
    chute: buildModel(chute()),
    pickup: Object.fromEntries(PICKUP_KINDS.map((k) => [k, buildModel(pickup(k))])) as Record<PickupKind, Model>,
    lighthouse: buildModel(lighthouse()),
    lantern: buildModel(lantern()),
    bush: buildModel(bush()),
    console: buildModel(consoleDesk()),
  };
  return cache;
}
