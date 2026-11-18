// Where everything stands. Pure: a model in, a world out — no canvas here.
//
//   folder (Charon's sidebar folder)  →  a stretch of water with its name
//   machine (VPS)                     →  an island, its beacon at the top
//   working directory                 →  a wooden deck on the island
//   session                           →  a station on that deck: a console,
//                                         and the 3×4 tiles around it
//
// The grouping by directory IS the sidebar's (`sidebarPathKey`), in its order.
import { sidebarPathKey } from '@/app/sidebarPathGroups';
import { T } from './art';
import { hashStr, type DeskFolder, type DeskModel, type DeskSession } from './model';

/** A station is CELL_W×CELL_H tiles; the robot never leaves it. From the
 *  top: a band for its marker, the robot and its console, a band for its name. */
export const CELL_W = 3;
export const CELL_H = 4;

export type Station = {
  id: string;
  /** Top-left of the cell, world pixels. */
  x: number;
  y: number;
  /** Feet of the robot at its console / standing beside it. */
  seatX: number; seatY: number;
  restX: number; restY: number;
  /** Bottom-centre of the console (its brazier sits on its right end), top-left of its holo screen. */
  deskX: number; deskY: number;
  holoX: number; holoY: number;
  /** Centre of the name, under the station. */
  labelX: number; labelY: number;
  plot: Plot;
};

export type Plot = {
  key: string;
  vpsId: string;
  cwd: string;
  label: string;
  /** World pixels. */
  x: number; y: number; w: number; h: number;
  stations: Station[];
};

export type Island = {
  vpsId: string;
  name: string;
  folderId: string;
  /** World tiles (origin) and size. */
  tx: number; ty: number; tw: number; th: number;
  /** tw×th: 1 = land. */
  ground: Uint8Array;
  plots: Plot[];
  /** Foot of the beacon, world pixels. */
  beaconX: number; beaconY: number;
  /** A machine without a session: a rock and a small beacon. */
  small: boolean;
  seed: number;
};

export type Zone = { id: string; name: string; x: number; y: number; w: number; h: number };

export type World = {
  islands: Island[];
  zones: Zone[];
  stations: Map<string, Station>;
  /** Everything, and the inhabited part only (what "fit" frames). */
  bounds: { x: number; y: number; w: number; h: number };
  home: { x: number; y: number; w: number; h: number };
  /** Changes exactly when the shape does: the static layers are rebuilt on it. */
  shape: string;
};

const PLOT_PAD = 1;       // tiles of deck around the stations
const PLOT_GAP = 1;       // grass between two decks
const MARGIN = 2;         // grass between the decks and the coast
const HEAD = 3;           // tiles above the decks: the beacon stands there
const ISLAND_GAP = 5;     // water between islands
const ZONE_GAP = 9;       // water between folders
const ISLET_W = 5;
const ISLET_H = 4;
const ISLET_GAP = 2;

type Box = { w: number; h: number; px: number; py: number };

/**
 * Shelf-pack boxes (tallest first) at several widths and keep the tightest
 * result whose shape is closest to `aspect` (screens are wide); `pull` is how
 * much the shape counts against the area. Positions are written into the
 * boxes; the packed size is returned.
 */
function pack(boxes: Box[], gap: number, aspect: number, pull = 0.4): { w: number; h: number } {
  if (!boxes.length) return { w: 0, h: 0 };
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h || a - b);
  const area = boxes.reduce((sum, b) => sum + (b.w + gap) * (b.h + gap), 0);
  const widest = Math.max(...boxes.map((b) => b.w));
  let best: { score: number; at: Array<[number, number]>; w: number; h: number } | null = null;
  for (let k = 0; k < 20; k += 1) {
    const target = Math.max(widest, Math.round(Math.sqrt(area * aspect) * (0.55 + k * 0.08)));
    const at: Array<[number, number]> = [];
    let x = 0; let y = 0; let shelf = 0; let w = 0;
    for (const i of order) {
      const b = boxes[i];
      if (x > 0 && x + b.w > target) { x = 0; y += shelf + gap; shelf = 0; }
      at[i] = [x, y];
      x += b.w + gap;
      shelf = Math.max(shelf, b.h);
      w = Math.max(w, x - gap);
    }
    const h = y + shelf;
    const score = w * h * (1 + pull * Math.abs(Math.log(w / h / aspect)));
    if (!best || score < best.score) best = { score, at, w, h };
  }
  boxes.forEach((b, i) => { [b.px, b.py] = best!.at[i]; });
  return { w: best!.w, h: best!.h };
}

function shortLabel(path: string): string {
  if (path === '~' || path === '/') return path;
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function gridFor(count: number): { cols: number; rows: number } {
  if (count <= 3) return { cols: Math.max(1, count), rows: 1 };
  const cols = Math.min(4, Math.ceil(Math.sqrt(count * 1.4)));
  return { cols, rows: Math.ceil(count / cols) };
}

type Draft = Box & { key: string; cwd: string; sessions: DeskSession[]; cols: number; rows: number };

function buildIsland(vpsId: string, name: string, folderId: string, sessions: DeskSession[]): {
  island: Omit<Island, 'tx' | 'ty'>; drafts: Draft[];
} {
  const seed = hashStr(vpsId);
  if (!sessions.length) {
    const ground = roundedGround(ISLET_W, ISLET_H, seed, 1);
    return {
      island: {
        vpsId, name, folderId, tw: ISLET_W, th: ISLET_H, ground, plots: [],
        beaconX: (ISLET_W * T) / 2, beaconY: 2.6 * T, small: true, seed,
      },
      drafts: [],
    };
  }
  // The sidebar's groups, in its order.
  const groups = new Map<string, DeskSession[]>();
  for (const s of sessions) {
    const key = sidebarPathKey(s.cwd);
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  const drafts: Draft[] = [...groups.entries()].map(([key, list]) => {
    const { cols, rows } = gridFor(list.length);
    return {
      key, cwd: key, sessions: list, cols, rows,
      w: cols * CELL_W + PLOT_PAD * 2, h: rows * CELL_H + PLOT_PAD * 2, px: 0, py: 0,
    };
  });
  // An island is looked at alone, on a wide stage: it leans wide, firmly.
  const inner = pack(drafts, PLOT_GAP, 2.1, 1.3);
  const innerW = Math.max(inner.w, 9);
  const innerH = inner.h;
  const tw = innerW + MARGIN * 2;
  const th = HEAD + innerH + MARGIN;
  for (const d of drafts) { d.px += MARGIN; d.py += HEAD; }
  return {
    island: {
      vpsId, name, folderId, tw, th, ground: roundedGround(tw, th, seed, 3), plots: [],
      beaconX: 2.2 * T, beaconY: (HEAD - 0.1) * T, small: false, seed,
    },
    drafts,
  };
}

/** A rectangle with stepped, rounded corners. */
function roundedGround(tw: number, th: number, _seed: number, corner: number): Uint8Array {
  const ground = new Uint8Array(tw * th).fill(1);
  const cut = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < tw && y < th) ground[y * tw + x] = 0; };
  for (let i = 0; i < corner; i += 1) {
    for (let j = 0; j < corner - i; j += 1) {
      cut(i, j); cut(tw - 1 - i, j); cut(i, th - 1 - j); cut(tw - 1 - i, th - 1 - j);
    }
  }
  return ground;
}

export function buildWorld(model: DeskModel): World {
  const byVps = new Map<string, DeskSession[]>();
  for (const s of model.sessions) {
    const list = byVps.get(s.vpsId);
    if (list) list.push(s);
    else byVps.set(s.vpsId, [s]);
  }
  for (const list of byVps.values()) {
    list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)
      || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || a.id.localeCompare(b.id));
  }

  const islands: Island[] = [];
  const zones: Zone[] = [];
  const stations = new Map<string, Station>();
  const shape: string[] = [];
  let home: World['home'] | null = null;
  const grow = (box: World['home'] | null, x: number, y: number, w: number, h: number) => (box
    ? {
      x: Math.min(box.x, x), y: Math.min(box.y, y),
      w: Math.max(box.x + box.w, x + w) - Math.min(box.x, x),
      h: Math.max(box.y + box.h, y + h) - Math.min(box.y, y),
    }
    : { x, y, w, h });

  // Folders in Charon's order; a machine whose folder is unknown goes last.
  const known = new Set(model.folders.map((f) => f.id));
  const folders = [...model.folders];
  if (model.vps.some((v) => !known.has(v.folderId))) folders.push({ id: '', name: '' });

  // 1. Each folder: its inhabited islands packed tight, its empty machines as
  //    a grid of islets underneath.
  type Block = Box & {
    folder: DeskFolder;
    placed: Array<{ b: ReturnType<typeof buildIsland>; x: number; y: number }>;
  };
  const blocks: Block[] = [];
  for (const folder of folders) {
    const machines = model.vps.filter((v) => (known.has(v.folderId) ? v.folderId : '') === folder.id);
    const big = machines.filter((v) => byVps.has(v.id));
    const small = machines.filter((v) => !byVps.has(v.id));
    if (!big.length && !small.length) continue;
    const built = big.map((v) => buildIsland(v.id, v.name, folder.id, byVps.get(v.id) ?? []));
    const boxes: Box[] = built.map((b) => ({ w: b.island.tw, h: b.island.th, px: 0, py: 0 }));
    const core = pack(boxes, ISLAND_GAP, 1.5);
    const placed = built.map((b, i) => ({ b, x: boxes[i].px, y: boxes[i].py }));
    let w = core.w;
    let h = core.h;
    if (small.length) {
      const perRow = Math.max(4, Math.floor((Math.max(w, 24) + ISLET_GAP) / (ISLET_W + ISLET_GAP)));
      const top = h ? h + ISLAND_GAP : 0;
      small.forEach((v, i) => placed.push({
        b: buildIsland(v.id, v.name, folder.id, []),
        x: (i % perRow) * (ISLET_W + ISLET_GAP),
        y: top + Math.floor(i / perRow) * (ISLET_H + ISLET_GAP + 1),
      }));
      w = Math.max(w, Math.min(small.length, perRow) * (ISLET_W + ISLET_GAP) - ISLET_GAP);
      h = top + Math.ceil(small.length / perRow) * (ISLET_H + ISLET_GAP + 1) - ISLET_GAP - 1;
    }
    blocks.push({ folder, placed, w, h, px: 0, py: 0 });
  }

  // 2. The folders themselves, packed toward the shape of a screen.
  pack(blocks, ZONE_GAP, 1.9);
  for (const block of blocks) {
    zones.push({
      id: block.folder.id, name: block.folder.name,
      x: block.px * T, y: block.py * T, w: block.w * T, h: block.h * T,
    });
    for (const { b, x: ix, y: iy } of block.placed) {
      const tx = block.px + ix;
      const ty = block.py + iy;
      const island: Island = { ...b.island, tx, ty, plots: [] };
      for (const d of b.drafts) {
        const plot: Plot = {
          key: `${island.vpsId}\n${d.key}`, vpsId: island.vpsId, cwd: d.cwd, label: shortLabel(d.cwd),
          x: (tx + d.px) * T, y: (ty + d.py) * T, w: d.w * T, h: d.h * T, stations: [],
        };
        d.sessions.forEach((s, i) => {
          const cx = plot.x + (PLOT_PAD + (i % d.cols) * CELL_W) * T;
          const cy = plot.y + (PLOT_PAD + Math.floor(i / d.cols) * CELL_H) * T;
          const station: Station = {
            id: s.id, x: cx, y: cy, plot,
            deskX: cx + 30, deskY: cy + 42,
            seatX: cx + 30, seatY: cy + 35,
            restX: cx + 11, restY: cy + 42,
            holoX: cx + 34, holoY: cy + 8,
            labelX: cx + 24, labelY: cy + 46,
          };
          plot.stations.push(station);
          stations.set(s.id, station);
        });
        island.plots.push(plot);
        shape.push(`${plot.key}:${d.px},${d.py}:${d.sessions.map((s) => s.id).join(',')}`);
      }
      island.beaconX += tx * T;
      island.beaconY += ty * T;
      islands.push(island);
      shape.push(`${island.vpsId}@${tx},${ty}:${island.tw}x${island.th}`);
      if (!island.small) home = grow(home, tx * T, ty * T, island.tw * T, island.th * T);
    }
  }

  let bounds: World['bounds'] | null = null;
  for (const island of islands) bounds = grow(bounds, island.tx * T, island.ty * T, island.tw * T, island.th * T);
  const all = bounds ?? { x: 0, y: 0, w: 40 * T, h: 24 * T };
  return { islands, zones, stations, bounds: all, home: home ?? all, shape: shape.join('|') };
}
