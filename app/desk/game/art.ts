// Every pixel of the board is drawn here, by code: no image file, no atlas to
// ship. A sprite is a few rows of characters and a palette; `bake` paints it
// once into a small canvas that the renderer then blits.

export const T = 16; // one tile, in world pixels

export type Sprite = HTMLCanvasElement;
type Pal = Record<string, string>;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function bake(rows: string[], pal: Pal): Sprite {
  const w = Math.max(...rows.map((r) => r.length));
  const c = makeCanvas(w, rows.length);
  const g = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const colour = pal[row[x]];
      if (!colour) continue;
      g.fillStyle = colour;
      g.fillRect(x, y, 1, 1);
    }
  });
  return c;
}

/* ───────────────────────────────── the world's colours ─────────────────── */

export const INK = '#0c0e15';

export const WATER = {
  deep: '#081120',
  mid: '#0b182b',
  ripple: '#14304f',
  glint: '#23527d',
  foam: '#3a7ba3',
  shallow: '#102544',
};

export const LAND = {
  grass: '#22382e',
  grassDark: '#1c2f27',
  grassLight: '#2c4a3a',
  blade: '#3d6b4d',
  rim: '#4f8a5f',
  cliff: '#232a3a',
  cliffDark: '#171c28',
  cliffLine: '#2f3950',
  deck: '#4b3a2f',
  deckDark: '#3a2c24',
  deckLight: '#5d4a3b',
  deckEdge: '#261c17',
  shroom: '#58e6d9',
  mat: '#34405a',
  matEdge: '#28324a',
};

/* ─────────────────────────────────────────────── robots ─────────────────── */

export type RobotKind = 'claude' | 'codex' | 'cursor';

type Rect = [number, number, number, number];

export type RobotArt = {
  head: Sprite;
  torso: Sprite;
  legs: Record<'stand' | 'walkA' | 'walkB' | 'sit', Sprite>;
  armL: Record<'down' | 'up', Sprite>;
  armR: Record<'down' | 'up', Sprite>;
  /** Lit in the robot's mood colour, in head coordinates. */
  eyes: Rect[];
  lamp: Rect;
  /** One wide eye that sweeps while the robot works. */
  scanner: boolean;
  /** The chest light, in torso coordinates: the session's own colour. */
  chest: Rect;
};

const HEADS: Record<RobotKind, string[]> = {
  claude: [
    '.......oo.......',
    '.......oo.......',
    '.......oo.......',
    '....oooooooo....',
    '...ohhHHHHHBo...',
    '...oHVVVVVVBo...',
    '...oHVVVVVVDo...',
    '...oHVVVVVVDo...',
    '...oBBBBBBDDo...',
    '....oooooooo....',
  ],
  codex: [
    '................',
    '......oooo......',
    '......oVVo......',
    '..oooooooooooo..',
    '..ohhHHHHHHHBo..',
    '.ooHVVVVVVVVBoo.',
    '.ooHVVVVVVVVDoo.',
    '..oHHHHHHHHDDo..',
    '..oBBBBBBBBDDo..',
    '...oooooooooo...',
  ],
  cursor: [
    '................',
    '................',
    '.....oooooo.....',
    '....ohhHHHBo....',
    '...oHHVVVVHBo...',
    '..oHVVVVVVVVDo..',
    '..oHVVVVVVVVDo..',
    '...oBBBBBBBDo...',
    '....oBBBBBDo....',
    '.....oooooo.....',
  ],
};

const TORSO = [
  '.....oBBBBo.....',
  '....oHBBBBDo....',
  '....oHBVVBDo....',
  '....oBBVVBDo....',
  '....oBBBBDDo....',
  '....oooooooo....',
];

const LEGS = {
  stand: [
    '....oBDooBDo....',
    '....oBDooBDo....',
    '...oBBDooBDDo...',
    '...oooooooooo...',
  ],
  walkA: [
    '....oBDooBDo....',
    '...oBBDooBDo....',
    '...ooooooBDDo...',
    '........ooooo...',
  ],
  walkB: [
    '....oBDooBDo....',
    '....oBDooBDDo...',
    '...oBBDoooooo...',
    '...ooooo........',
  ],
  sit: [
    '................',
    '................',
    '..oBBBDooBDDDo..',
    '..oooooooooooo..',
  ],
};

const ARM_L = {
  down: ['.ooo', 'oHBo', 'oHBo', 'oBBo', '.oo.'],
  up: ['.oo.', 'oHBo', 'oHBo', 'oHBo', 'oBBo', '.ooo'],
};
const ARM_R = {
  down: ['ooo.', 'oBDo', 'oBDo', 'oBDo', '.oo.'],
  up: ['.oo.', 'oBDo', 'oBDo', 'oBDo', 'oBDo', 'ooo.'],
};

const ROBOT_PAL: Record<RobotKind, Pal> = {
  // Warm clay.
  claude: { o: '#1d1210', h: '#f7b89b', H: '#e9936f', B: '#d97757', D: '#a5543a', V: '#261714' },
  // Paper white, graphite joints.
  codex: { o: '#14171d', h: '#ffffff', H: '#eef0f4', B: '#d5d9e2', D: '#9aa1b1', V: '#1b1f29' },
  // Slate with a cold edge.
  cursor: { o: '#0d1016', h: '#9fb1cc', H: '#7486a3', B: '#586882', D: '#3b4960', V: '#0f141d' },
};

const ROBOT_META: Record<RobotKind, Pick<RobotArt, 'eyes' | 'lamp' | 'scanner' | 'chest'>> = {
  claude: { eyes: [[6, 5, 1, 2], [9, 5, 1, 2]], lamp: [7, 0, 2, 2], scanner: false, chest: [7, 2, 2, 2] },
  codex: { eyes: [[5, 5, 2, 2], [9, 5, 2, 2]], lamp: [7, 2, 2, 1], scanner: false, chest: [7, 2, 2, 2] },
  cursor: { eyes: [[6, 5, 4, 2]], lamp: [7, 3, 2, 1], scanner: true, chest: [7, 2, 2, 2] },
};

function buildRobot(kind: RobotKind): RobotArt {
  const pal = ROBOT_PAL[kind];
  const each = <K extends string>(set: Record<K, string[]>) => Object.fromEntries(
    Object.entries(set).map(([key, rows]) => [key, bake(rows as string[], pal)]),
  ) as Record<K, Sprite>;
  return {
    head: bake(HEADS[kind], pal),
    torso: bake(TORSO, pal),
    legs: each(LEGS),
    armL: each(ARM_L),
    armR: each(ARM_R),
    ...ROBOT_META[kind],
  };
}

export type RobotPose = {
  /** 0 or 1: the head and torso ride one pixel lower. */
  bob: number;
  legs: keyof typeof LEGS;
  armL: 'down' | 'up';
  armR: 'down' | 'up';
  /** Extra pixels on each arm (typing, waving). */
  armLdy: number;
  armRdy: number;
  /** null = eyes shut / powered down. */
  eye: string | null;
  lamp: string | null;
  chest: string | null;
  /** 0..1 along the visor, scanner robots only. */
  scan: number;
  alpha: number;
};

export const ROBOT_W = 16;
export const ROBOT_H = 20;

/** Draw a robot with its FEET at (x, y). */
export function drawRobot(g: CanvasRenderingContext2D, art: RobotArt, x: number, y: number, pose: RobotPose): void {
  const left = Math.round(x) - 8;
  const top = Math.round(y) - ROBOT_H;
  const sit = pose.legs === 'sit' ? 2 : 0;
  const up = top + pose.bob + sit;
  if (pose.alpha < 1) g.globalAlpha = pose.alpha;
  g.drawImage(art.legs[pose.legs], left, top + 16);
  g.drawImage(art.torso, left, up + 10);
  if (pose.chest) {
    g.fillStyle = pose.chest;
    g.fillRect(left + art.chest[0], up + 10 + art.chest[1], art.chest[2], art.chest[3]);
  }
  if (pose.armL === 'up') g.drawImage(art.armL.up, left, up + 6 + pose.armLdy);
  else g.drawImage(art.armL.down, left + 1, up + 11 + pose.armLdy);
  if (pose.armR === 'up') g.drawImage(art.armR.up, left + 12, up + 6 + pose.armRdy);
  else g.drawImage(art.armR.down, left + 11, up + 11 + pose.armRdy);
  g.drawImage(art.head, left, up);
  if (pose.eye) {
    g.fillStyle = pose.eye;
    if (art.scanner) {
      const [ex, ey, ew, eh] = art.eyes[0];
      const span = 4;
      g.fillRect(left + ex - 2 + Math.round(pose.scan * span), up + ey, ew, eh);
    } else {
      for (const [ex, ey, ew, eh] of art.eyes) g.fillRect(left + ex, up + ey, ew, eh);
    }
  }
  if (pose.lamp) {
    g.fillStyle = pose.lamp;
    g.fillRect(left + art.lamp[0], up + art.lamp[1], art.lamp[2], art.lamp[3]);
  }
  if (pose.alpha < 1) g.globalAlpha = 1;
}

/* ───────────────────────────────────────────────── props ───────────────── */

const DESK_ROWS = [
  '..oooooooooooooooo..',
  '.oMMMMMMMMMMMMMMMMo.',
  '.oMkkkMkkkkkMkkkMMo.',
  '.oMMMMMMMMMMMMMMMMo.',
  'oooooooooooooooooooo',
  'omNNNNNNNNNNNNNNNNmo',
  'omNNnNNNNNNNNNNnNNmo',
  'omNNNNNNNNNNNNNNNNmo',
  'omNNNNNNNNNNNNNNNNmo',
  'oooooooooooooooooooo',
  '.oo..............oo.',
  '.oo..............oo.',
];
const DESK_PAL: Pal = { o: '#10131b', M: '#5a6480', k: '#262c3b', N: '#343c50', n: '#4a5570', m: '#454e66' };

const LANTERN_ROWS = [
  '..ooo..',
  '.oYYYo.',
  '.oYWYo.',
  '.oYYYo.',
  '..ooo..',
  '...o...',
  '...o...',
  '...o...',
  '...o...',
  '...o...',
  '...o...',
  '..ooo..',
];
const LANTERN_PAL: Pal = { o: '#14161d', Y: '#ffc763', W: '#fff3c9' };

const CRATE_ROWS = [
  'oooooooooo',
  'oCcCCCCcCo',
  'ocCcccCcco',
  'oCcCCCCcCo',
  'oCcCCCCcCo',
  'ocCcccCcco',
  'oCcCCCCcCo',
  'oooooooooo',
];
const CRATE_PAL: Pal = { o: '#17110d', C: '#7a5c3e', c: '#5c452f' };

const BUSH_ROWS = [
  '...oooo...',
  '.ooGgGGoo.',
  'oGGgGGgGGo',
  'oGgGGGGgGo',
  'oGGGgGGGGo',
  '.oooooooo.',
];
const BUSH_PAL: Pal = { o: '#101a15', G: '#2f5a41', g: '#44805a' };

const SIGN_ROWS = [
  'oooooooooooooo',
  'oSSSSSSSSSSSSo',
  'oSssssssssssSo',
  'oSSSSSSSSSSSSo',
  'oooooooooooooo',
  '..oo......oo..',
  '..oo......oo..',
  '..oo......oo..',
];
const SIGN_PAL: Pal = { o: '#17110d', S: '#8a6a45', s: '#6b5136' };

const BOAT_ROWS = [
  '..........o...........',
  '.........oYo..........',
  '..........o...........',
  'oo........o.........oo',
  'oWoooooooooooooooooWo.',
  '.oWWwwwwwwwwwwwwwWWo..',
  '..oWwwwwwwwwwwwwwWo...',
  '...oooooooooooooooo...',
];
const BOAT_PAL: Pal = { o: '#120e0c', W: '#6f5238', w: '#553d2a', Y: '#ffc763' };

/** The island's beacon: a banded tower whose lamp says what the machine needs. */
function beacon(scale: 'tall' | 'small'): Sprite {
  const tall = scale === 'tall';
  const w = tall ? 20 : 12;
  const h = tall ? 46 : 24;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d')!;
  const mid = w / 2;
  const box = (x: number, y: number, bw: number, bh: number, colour: string) => {
    g.fillStyle = colour;
    g.fillRect(Math.round(x), y, Math.round(bw), bh);
  };
  const roofH = tall ? 5 : 3;
  const roomH = tall ? 7 : 4;
  const roomW = tall ? 8 : 6;
  // Finial and roof.
  box(mid - 1, 0, 2, 2, INK);
  for (let i = 0; i < roofH; i += 1) {
    const rw = 4 + i * 2;
    box(mid - rw / 2 - 1, 2 + i, rw + 2, 1, INK);
    box(mid - rw / 2, 2 + i, rw, 1, i === 0 ? '#9a4a4a' : '#7a3434');
    box(mid + rw / 2 - 2, 2 + i, 2, 1, '#5a2626');
  }
  // Lamp room: the frame only — the glass is left open for the live lamp.
  const roomY = 2 + roofH;
  box(mid - roomW / 2 - 1, roomY, roomW + 2, 1, INK);
  box(mid - roomW / 2 - 1, roomY + roomH - 1, roomW + 2, 1, INK);
  box(mid - roomW / 2 - 1, roomY, 1, roomH, INK);
  box(mid + roomW / 2, roomY, 1, roomH, INK);
  box(mid - 0.5, roomY, 1, roomH, INK);
  // Gallery.
  const galleryY = roomY + roomH;
  const galleryW = tall ? 14 : 10;
  box(mid - galleryW / 2, galleryY, galleryW, 2, INK);
  box(mid - galleryW / 2 + 1, galleryY, galleryW - 2, 1, '#56607a');
  // Shaft, widening toward the ground, in bands.
  const shaftY = galleryY + 2;
  const baseH = tall ? 6 : 3;
  const shaftH = h - shaftY - baseH;
  const topW = tall ? 8 : 6;
  const botW = tall ? 12 : 8;
  const band = tall ? 6 : 4;
  for (let i = 0; i < shaftH; i += 1) {
    const sw = Math.round(topW + ((botW - topW) * i) / Math.max(1, shaftH - 1));
    const light = Math.floor(i / band) % 2 === 0;
    box(mid - sw / 2 - 1, shaftY + i, sw + 2, 1, INK);
    box(mid - sw / 2, shaftY + i, sw, 1, light ? '#aeb5c6' : '#6a4350');
    box(mid - sw / 2, shaftY + i, 1, 1, light ? '#d8dce6' : '#845664');
    box(mid + sw / 2 - Math.max(2, Math.round(sw / 4)), shaftY + i, Math.max(2, Math.round(sw / 4)), 1, light ? '#7f879a' : '#4a2f3a');
  }
  if (tall) box(mid - 1, shaftY + shaftH - 5, 2, 5, '#1a1d27');
  // Footing.
  const baseY = h - baseH;
  const baseW = tall ? 16 : 10;
  box(mid - baseW / 2 - 1, baseY, baseW + 2, baseH, INK);
  box(mid - baseW / 2, baseY, baseW, baseH - 1, '#3b4358');
  box(mid - baseW / 2, baseY, baseW, 1, '#58627c');
  return c;
}

/** Where the open glass of a beacon sits, relative to its top-left. */
export const BEACON_GLASS = {
  tall: { x: 6, y: 8, w: 8, h: 5 },
  small: { x: 3, y: 6, w: 6, h: 2 },
};

/* ─────────────────────────────────────────── icons and markers ──────────── */

export type IconName =
  | 'shell' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'plan' | 'peer'
  | 'say' | 'compact' | 'other' | 'bang' | 'ask' | 'check' | 'cross' | 'zzz' | 'think';

const ICONS: Record<IconName, string[]> = {
  shell: ['#......', '.#.....', '..#....', '.#.....', '#..####', '.......', '.......'],
  edit: ['.....##', '....###', '...###.', '..###..', '.###...', '##.....', '#......'],
  read: ['######.', '#....##', '#.##..#', '#.....#', '#.###.#', '#.....#', '#######'],
  search: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
  web: ['.#####.', '#.#.#.#', '#######', '#.#.#.#', '#######', '#.#.#.#', '.#####.'],
  agent: ['...#...', '.#####.', '.#.#.#.', '.#####.', '..###..', '.#.#.#.', '.#...#.'],
  plan: ['#.####.', '.......', '#.####.', '.......', '#.###..', '.......', '#.#####'],
  peer: ['.......', '#######', '##...##', '#.#.#.#', '#..#..#', '#######', '.......'],
  say: ['.......', '######.', '.......', '####...', '.......', '#####..', '.......'],
  compact: ['#.....#', '.#...#.', '..#.#..', '.......', '..#.#..', '.#...#.', '#.....#'],
  other: ['...#...', '.#.#.#.', '..###..', '###.###', '..###..', '.#.#.#.', '...#...'],
  bang: ['..##...', '..##...', '..##...', '..##...', '.......', '..##...', '..##...'],
  ask: ['.####..', '##..##.', '....##.', '..###..', '..##...', '.......', '..##...'],
  check: ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  cross: ['#.....#', '##...##', '.##.##.', '..###..', '.##.##.', '##...##', '#.....#'],
  zzz: ['.......', '.#####.', '....#..', '...#...', '..#....', '.#####.', '.......'],
  think: ['.......', '.......', '.......', '#..#..#', '.......', '.......', '.......'],
};

/** Paint a 7×7 icon in one colour, top-left at (x, y). */
export function drawIcon(g: CanvasRenderingContext2D, name: IconName, x: number, y: number, colour: string): void {
  const rows = ICONS[name];
  g.fillStyle = colour;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let c = 0; c < row.length; c += 1) if (row[c] === '#') g.fillRect(x + c, y + r, 1, 1);
  }
}

/** A balloon with a glyph: the marker that bounces over a robot's head. */
function balloon(icon: IconName, fill: string, edge: string): Sprite {
  const c = makeCanvas(13, 15);
  const g = c.getContext('2d')!;
  g.fillStyle = INK;
  g.fillRect(2, 0, 9, 1);
  g.fillRect(1, 1, 11, 1);
  g.fillRect(0, 2, 13, 8);
  g.fillRect(1, 10, 11, 1);
  g.fillRect(2, 11, 9, 1);
  g.fillRect(5, 12, 3, 1);
  g.fillRect(6, 13, 1, 1);
  g.fillStyle = fill;
  g.fillRect(2, 1, 9, 1);
  g.fillRect(1, 2, 11, 8);
  g.fillRect(2, 10, 9, 1);
  g.fillRect(6, 11, 1, 1);
  g.fillStyle = edge;
  g.fillRect(2, 1, 9, 1);
  g.fillRect(1, 2, 1, 6);
  drawIcon(g, icon, 3, 2, INK);
  return c;
}

/** The brazier at the end of a console: the session's prompt cache burns in it. */
const BRAZIER_ROWS = ['h.....h', 'oMMMMMo', '.ooooo.'];

const FLAME_WIDE = [0.45, 0.8, 1, 0.8, 0.45];
const FLAME_THIN = [0.6, 1, 0.6];

/**
 * A fire with its base centred on (cx, baseY). `size` (0..1] is how much of
 * it is left: eight pixels tall and five wide when full, shrinking a pixel at
 * a time down to two glowing embers. It sways, faster when `lively`.
 */
export function drawFlame(
  g: CanvasRenderingContext2D, cx: number, baseY: number, size: number,
  time: number, ember: string, core: string, lively = false,
): void {
  const peak = Math.max(2, Math.round(2 + 6 * Math.min(1, Math.max(0, size))));
  const shape = peak >= 5 ? FLAME_WIDE : FLAME_THIN;
  const half = (shape.length - 1) / 2;
  const tall = peak > 2;
  const frame = Math.floor(time / (tall ? (lively ? 110 : 170) : 480)) % 4;
  for (let c = 0; c < shape.length; c += 1) {
    let h = Math.max(1, Math.round(peak * shape[c]));
    // The tip breathes; the flanks lick up in turn.
    if (tall && c === half && frame % 2 === 1) h -= 1;
    if (tall && ((c === half - 1 && frame === 1) || (c === half + 1 && frame === 3))) h += 1;
    const x = cx - half + c;
    g.fillStyle = ember;
    g.fillRect(x, baseY - h + 1, 1, h);
    if (c > 0 && c < shape.length - 1 && h > 2) {
      g.fillStyle = core;
      g.fillRect(x, baseY - h + 3, 1, h - 2);
    }
  }
  if (peak >= 6) {
    g.fillStyle = ember;
    g.fillRect(cx + [0, -1, 0, 1][frame], baseY - peak, 1, 1);
  }
  if (!tall && frame % 2 === 0) {
    g.fillStyle = core;
    g.fillRect(cx - 1 + (frame === 0 ? 0 : 2), baseY, 1, 1);
  }
}

/* ───────────────────────────────── the mini-game (game/arcade.ts) ───────── */

/** A sprite with a one-pixel dark edge all round: readable on any ground. */
function outlined(src: Sprite, colour = INK): Sprite {
  const c = makeCanvas(src.width + 2, src.height + 2);
  const g = c.getContext('2d')!;
  const dark = makeCanvas(src.width, src.height);
  const d = dark.getContext('2d')!;
  d.drawImage(src, 0, 0);
  d.globalCompositeOperation = 'source-in';
  d.fillStyle = colour;
  d.fillRect(0, 0, src.width, src.height);
  for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2]]) g.drawImage(dark, dx, dy);
  g.drawImage(src, 1, 1);
  return c;
}

const HERO_TOP = [
  '..rrrrrrrr..',
  '.rrrrrrrrrr.',
  '.rrssssssrrr',
  '..skssssks..',
  '..ssssssss..',
  '...ssssss...',
  '..gggggggg..',
  '.GggggggggG.',
  '.GggggggggG.',
  '.s.gggggg.s.',
  '...bbbbbb...',
  '...pppppp...',
];
const HERO_LEGS = {
  stand: ['...pp..pp...', '...pp..pp...', '..BBB..BBB..'],
  walkA: ['...pp..pp...', '..BBB..pp...', '.......BBB..'],
  walkB: ['...pp..pp...', '...pp..BBB..', '..BBB.......'],
};
const HERO_PAL: Pal = {
  r: '#e5484d', s: '#f0c090', k: '#1a1c24', g: '#5c9b55', G: '#3c6b3d', b: '#8a6a45', p: '#3f4f78', B: '#1d2130',
};

const HELI_ROWS = [
  '..............oo....................',
  '..........oooooooooo................',
  '........ooHHHHHHHHHHoo..........oo..',
  '.......oHHGGGGccccGGGGooooooooooGGo.',
  '......oGGGGGGccCCccGGGGGGGGGGGGGGGo.',
  '.....oGGGGGGGccCCccGGGGGGoooooooo...',
  '.....oDGGGGGGGccccGGGGGDo...........',
  '......oDDDDDDDDDDDDDDDDo............',
  '.......oooDDDDDDDDDooo..............',
  '.........o.o.....o.o................',
  '......ooooooooooooooooo.............',
];
const HELI_PAL: Pal = { o: '#0f1218', H: '#8fb07a', G: '#5f8050', D: '#3f5a38', c: '#7fd6e8', C: '#d8f6ff' };

const CHUTE_ROWS = [
  '...oooooooo...',
  '.ooWWRRWWRRoo.',
  'oWWRRWWRRWWRRo',
  'oWRRWWRRWWRRWo',
  '.o..o....o..o.',
  '..o..o..o..o..',
  '...o..oo..o...',
];

/** What can be picked up: a weapon, or a bonus. */
export type PickupKind = 'smg' | 'shotgun' | 'laser' | 'rocket' | 'flame' | 'med' | 'bomb' | 'shield' | 'x2';

const PICKUPS: Record<PickupKind, { frame: string; ink: string; glyph: string[] }> = {
  smg: { frame: '#ffe066', ink: '#ffe066', glyph: ['#.#.#', '#.#.#', '#.#.#', '.....', '#####'] },
  shotgun: { frame: '#ffb86b', ink: '#ffb86b', glyph: ['#.#.#', '.###.', '..#..', '..#..', '..#..'] },
  laser: { frame: '#7cc4ff', ink: '#7cc4ff', glyph: ['.....', '#####', '#####', '.....', '.#.#.'] },
  rocket: { frame: '#ff8fb3', ink: '#ff8fb3', glyph: ['..#..', '.###.', '.###.', '.###.', '#.#.#'] },
  flame: { frame: '#ff8a2a', ink: '#ffe08a', glyph: ['..#..', '.##..', '.###.', '#####', '.###.'] },
  med: { frame: '#ffffff', ink: '#ff5d5d', glyph: ['..#..', '..#..', '#####', '..#..', '..#..'] },
  bomb: { frame: '#9aa1b1', ink: '#e8eef9', glyph: ['...##', '..#..', '.###.', '#####', '.###.'] },
  shield: { frame: '#35d0c7', ink: '#35d0c7', glyph: ['#####', '#####', '#####', '.###.', '..#..'] },
  x2: { frame: '#c9a7ff', ink: '#c9a7ff', glyph: ['..#..', '.###.', '#####', '.###.', '..#..'] },
};

function pickupBox(kind: PickupKind): Sprite {
  const { frame, ink, glyph } = PICKUPS[kind];
  const c = makeCanvas(11, 11);
  const g = c.getContext('2d')!;
  g.fillStyle = INK;
  g.fillRect(0, 0, 11, 11);
  g.fillStyle = frame;
  g.fillRect(1, 1, 9, 9);
  g.fillStyle = '#10131b';
  g.fillRect(2, 2, 7, 7);
  g.fillStyle = ink;
  glyph.forEach((row, y) => { for (let x = 0; x < row.length; x += 1) if (row[x] === '#') g.fillRect(3 + x, 3 + y, 1, 1); });
  return c;
}

export type ArcadeArt = {
  hero: Record<'stand' | 'walkA' | 'walkB', Sprite>;
  heli: Sprite;
  chute: Sprite;
  pickup: Record<PickupKind, Sprite>;
};

let arcadeCached: ArcadeArt | null = null;

export function arcadeArt(): ArcadeArt {
  if (arcadeCached) return arcadeCached;
  const hero = (legs: string[]) => outlined(bake([...HERO_TOP, ...legs], HERO_PAL));
  arcadeCached = {
    hero: { stand: hero(HERO_LEGS.stand), walkA: hero(HERO_LEGS.walkA), walkB: hero(HERO_LEGS.walkB) },
    heli: bake(HELI_ROWS, HELI_PAL),
    chute: bake(CHUTE_ROWS, { o: INK, W: '#f4f6fb', R: '#e5484d' }),
    pickup: Object.fromEntries((Object.keys(PICKUPS) as PickupKind[]).map((k) => [k, pickupBox(k)])) as Record<PickupKind, Sprite>,
  };
  return arcadeCached;
}

/** A little helper that circles a robot while its background tasks run. */
const DRONE_ROWS = ['.ooo.', 'oDDDo', 'oDLDo', '.ooo.'];

export type Art = {
  robots: Record<RobotKind, RobotArt>;
  desk: Sprite;
  lantern: Sprite;
  crate: Sprite;
  bush: Sprite;
  sign: Sprite;
  boat: Sprite;
  beacon: Sprite;
  beaconSmall: Sprite;
  brazier: Sprite;
  drone: Sprite;
  marker: Record<'bang' | 'ask' | 'check' | 'cross', Sprite>;
};

let cached: Art | null = null;

export function art(): Art {
  if (cached) return cached;
  cached = {
    robots: { claude: buildRobot('claude'), codex: buildRobot('codex'), cursor: buildRobot('cursor') },
    desk: bake(DESK_ROWS, DESK_PAL),
    lantern: bake(LANTERN_ROWS, LANTERN_PAL),
    crate: bake(CRATE_ROWS, CRATE_PAL),
    bush: bake(BUSH_ROWS, BUSH_PAL),
    sign: bake(SIGN_ROWS, SIGN_PAL),
    boat: bake(BOAT_ROWS, BOAT_PAL),
    beacon: beacon('tall'),
    beaconSmall: beacon('small'),
    brazier: bake(BRAZIER_ROWS, { h: '#6b7590', M: '#3a4257', o: '#10131b' }),
    drone: bake(DRONE_ROWS, { o: INK, D: '#8fa0bd', L: '#35d0c7' }),
    marker: {
      bang: balloon('bang', '#ffb020', '#ffd98a'),
      ask: balloon('ask', '#ffb020', '#ffd98a'),
      check: balloon('check', '#4ade80', '#a7f3c5'),
      cross: balloon('cross', '#ff5d5d', '#ffa3a3'),
    },
  };
  return cached;
}

/** The sprite set of a provider; one without its own art wears the first. */
export function robotKind(kind: string | null | undefined): RobotKind {
  return kind != null && Object.hasOwn(ROBOT_PAL, kind) ? kind as RobotKind : 'claude';
}
