// The parts of the board that never move: an island's ground, cliffs and decks
// are painted ONCE per shape into a canvas of their own, then blitted. The
// water is the only scenery redrawn every frame.
import { LAND, T, WATER, art, makeCanvas } from './art';
import { sitePad, type Island, type Site, type Slot, type Station, type Team } from './layout';
import { blend, seeded } from './model';

const CLIFF = 11;
const REFLECT = 5;
/** Water painted around the island (its shallows): the layer overhangs by this. */
const SHORE = 9;

export type Light = { x: number; y: number; r: number; colour: string; alpha: number };

export type IslandLayer = {
  canvas: HTMLCanvasElement;
  /** World pixels of the canvas' top-left. */
  x: number;
  y: number;
  /** Lantern glows, world pixels. */
  lights: Light[];
  /** Where a cliff meets the water (world pixels, top-left of a 16px run). */
  foam: Array<[number, number]>;
};

export function paintIsland(island: Island): IslandLayer {
  const { tw, th, ground } = island;
  const ox = island.tx * T;
  const oy = island.ty * T;
  const canvas = makeCanvas(tw * T + SHORE * 2, th * T + CLIFF + REFLECT + SHORE * 2);
  const g = canvas.getContext('2d')!;
  g.translate(SHORE, SHORE);
  const random = seeded(island.seed ^ 0x51f15e);
  const land = (x: number, y: number) => x >= 0 && y >= 0 && x < tw && y < th && ground[y * tw + x] === 1;
  const lights: Light[] = [];
  const foam: Array<[number, number]> = [];

  // Shallows: two lighter rings of water hugging the coast.
  for (const [grow, colour] of [[SHORE, WATER.mid], [5, WATER.shallow]] as const) {
    g.fillStyle = colour;
    for (let y = 0; y < th; y += 1) {
      for (let x = 0; x < tw; x += 1) {
        if (land(x, y)) g.fillRect(x * T - grow, y * T - grow + 2, T + grow * 2, T + grow * 2 + CLIFF - 4);
      }
    }
  }

  // Cliffs, under every tile whose south is water.
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      if (!land(x, y) || land(x, y + 1)) continue;
      const px = x * T;
      const py = (y + 1) * T;
      g.fillStyle = LAND.cliff;
      g.fillRect(px, py, T, CLIFF);
      g.fillStyle = LAND.cliffLine;
      g.fillRect(px, py, T, 1);
      g.fillStyle = LAND.cliffDark;
      g.fillRect(px, py + CLIFF - 4, T, 4);
      // Cracks.
      for (let i = 0; i < 3; i += 1) {
        const cx = px + Math.floor(random() * T);
        g.fillRect(cx, py + 2 + Math.floor(random() * 3), 1, 3 + Math.floor(random() * 3));
      }
      if (!land(x - 1, y)) { g.fillStyle = LAND.cliffLine; g.fillRect(px, py, 1, CLIFF - 2); }
      if (!land(x + 1, y)) { g.fillStyle = LAND.cliffDark; g.fillRect(px + T - 1, py, 1, CLIFF); }
      // Its shadow on the water.
      g.fillStyle = 'rgba(4, 8, 16, 0.55)';
      g.fillRect(px, py + CLIFF, T, REFLECT - 2);
      g.fillStyle = 'rgba(4, 8, 16, 0.28)';
      g.fillRect(px, py + CLIFF + REFLECT - 2, T, 2);
      foam.push([ox + px, oy + py + CLIFF - 1]);
    }
  }

  // Ground.
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      if (!land(x, y)) continue;
      const px = x * T;
      const py = y * T;
      g.fillStyle = LAND.grass;
      g.fillRect(px, py, T, T);
      for (let i = 0; i < 10; i += 1) {
        g.fillStyle = random() < 0.5 ? LAND.grassDark : LAND.grassLight;
        g.fillRect(px + Math.floor(random() * T), py + Math.floor(random() * T), 1 + Math.floor(random() * 2), 1);
      }
      if (random() < 0.3) {
        g.fillStyle = LAND.blade;
        const bx = px + 2 + Math.floor(random() * 12);
        const by = py + 3 + Math.floor(random() * 10);
        g.fillRect(bx, by, 1, 2);
        g.fillRect(bx + 2, by + 1, 1, 1);
      }
      // The lit rim where the grass meets the void.
      const n = land(x, y - 1); const w = land(x - 1, y); const e = land(x + 1, y);
      if (!n) { g.fillStyle = LAND.rim; g.fillRect(px, py, T, 1); g.fillStyle = LAND.blade; g.fillRect(px, py + 1, T, 1); }
      if (!w) { g.fillStyle = LAND.blade; g.fillRect(px, py, 1, T); }
      if (!e) { g.fillStyle = LAND.grassDark; g.fillRect(px + T - 1, py, 1, T); }
      if (!n && !w) g.clearRect(px, py, 2, 1), g.clearRect(px, py, 1, 2);
      if (!n && !e) g.clearRect(px + T - 2, py, 2, 1), g.clearRect(px + T - 1, py, 1, 2);
    }
  }

  // Decks.
  const sprites = art();
  const taken = new Uint8Array(tw * th);
  for (const plot of island.plots) {
    const px = plot.x - ox;
    const py = plot.y - oy;
    for (let y = py / T; y < (py + plot.h) / T; y += 1) {
      for (let x = px / T; x < (px + plot.w) / T; x += 1) taken[y * tw + x] = 1;
    }
    g.fillStyle = LAND.deckEdge;
    g.fillRect(px - 1, py - 1, plot.w + 2, plot.h + 4);
    g.fillStyle = LAND.deck;
    g.fillRect(px, py, plot.w, plot.h);
    // Planks: a seam every four pixels, joints staggered.
    for (let y = 0; y < plot.h; y += 4) {
      g.fillStyle = LAND.deckDark;
      g.fillRect(px, py + y + 3, plot.w, 1);
      const shift = (y / 4) % 2 === 0 ? 0 : 9;
      for (let x = shift + 5 + Math.floor(random() * 6); x < plot.w; x += 17 + Math.floor(random() * 5)) {
        g.fillRect(px + x, py + y, 1, 3);
      }
      if (random() < 0.5) {
        g.fillStyle = LAND.deckLight;
        g.fillRect(px + Math.floor(random() * (plot.w - 8)), py + y, 4 + Math.floor(random() * 6), 1);
      }
    }
    g.fillStyle = LAND.deckLight;
    g.fillRect(px, py, plot.w, 1);
    // A team's rug, its lead's dais, the place of each of its crew.
    for (const team of plot.teams) paintRug(g, team, ox, oy);
    paintFreePlace(g, plot.slot, ox, oy);
    // A woven mat under each station that stands alone.
    for (const station of plot.stations) {
      if (station.team) { paintTeamPlace(g, station, station.team, ox, oy); continue; }
      const mx = station.x - ox + 2;
      const my = station.y - oy + 33;
      g.fillStyle = LAND.matEdge;
      g.fillRect(mx, my, 44, 12);
      g.fillStyle = LAND.mat;
      g.fillRect(mx + 1, my + 1, 42, 10);
      g.fillStyle = LAND.matEdge;
      for (let x = 3; x < 42; x += 4) g.fillRect(mx + x, my + 2 + ((x >> 2) % 2) * 4, 2, 1);
      g.clearRect(mx, my, 1, 1); g.clearRect(mx + 43, my, 1, 1);
      g.fillStyle = LAND.deck;
      g.fillRect(mx, my, 1, 1); g.fillRect(mx + 43, my, 1, 1);
      g.fillRect(mx, my + 11, 1, 1); g.fillRect(mx + 43, my + 11, 1, 1);
    }
    // Its sign, and a lantern at the far corner.
    g.drawImage(sprites.sign, px + 3, py + 4);
    const lx = px + plot.w - 9;
    const ly = py + 2;
    g.drawImage(sprites.lantern, lx, ly);
    lights.push({ x: ox + lx + 3.5, y: oy + ly + 4, r: 26, colour: '#ffc763', alpha: 0.2 });
  }

  // The deck being built: nothing grows where it stands.
  const site = island.site;
  for (let y = Math.floor((site.y - oy) / T); y < (site.y - oy + site.h) / T; y += 1) {
    for (let x = Math.floor((site.x - ox) / T); x < (site.x - ox + site.w) / T; x += 1) {
      if (x >= 0 && y >= 0 && x < tw && y < th) taken[y * tw + x] = 1;
    }
  }
  paintSite(g, site, ox, oy);

  // What grows on the rest: bushes, glowing caps, a crate or two.
  for (let y = 0; y < th; y += 1) {
    for (let x = 0; x < tw; x += 1) {
      if (!land(x, y) || taken[y * tw + x]) continue;
      const px = x * T;
      const py = y * T;
      const roll = random();
      if (island.small) continue;
      if (y < 3 && x < 4) continue; // the beacon's foot
      if (roll < 0.07) g.drawImage(sprites.bush, px + 3, py + 6);
      else if (roll < 0.15) {
        for (let i = 0; i < 2 + Math.floor(random() * 3); i += 1) {
          const mx = px + 2 + Math.floor(random() * 11);
          const my = py + 3 + Math.floor(random() * 10);
          g.fillStyle = LAND.shroom;
          g.fillRect(mx, my, 2, 1);
          g.fillStyle = '#b8fff6';
          g.fillRect(mx, my, 1, 1);
          g.fillStyle = '#0f2a2a';
          g.fillRect(mx, my + 1, 1, 1);
        }
      } else if (roll < 0.17 && land(x, y + 1)) g.drawImage(sprites.crate, px + 3, py + 5);
    }
  }

  return { canvas, x: ox - SHORE, y: oy - SHORE, lights, foam };
}

/* ───────────────────────────────── teams, free places, building sites ───── */

const SHADE = '#10131b';

/** A team's rug: one carpet in its colour under its lead's row and its crew's. */
function paintRug(g: CanvasRenderingContext2D, team: Team, ox: number, oy: number): void {
  const x = team.x - ox + 2;
  const y = team.y - oy + 25;
  const w = team.w - 4;
  const h = team.h - 25 - 2;
  const edge = blend(team.tint, SHADE, 0.3);
  const body = blend(team.tint, SHADE, 0.66);
  const weave = blend(team.tint, SHADE, 0.52);
  // Its shadow on the planks, then the carpet and its border.
  g.fillStyle = 'rgba(8, 10, 16, 0.35)';
  g.fillRect(x + 1, y + h, w, 1);
  g.fillStyle = edge;
  g.fillRect(x, y, w, h);
  g.fillStyle = body;
  g.fillRect(x + 1, y + 1, w - 2, h - 2);
  g.fillStyle = weave;
  g.fillRect(x + 3, y + 3, w - 6, 1); g.fillRect(x + 3, y + h - 4, w - 6, 1);
  g.fillRect(x + 3, y + 3, 1, h - 6); g.fillRect(x + w - 4, y + 3, 1, h - 6);
  // The weave: a staggered stitch.
  for (let j = 7; j < h - 6; j += 5) {
    for (let i = 7 + ((j / 5) % 2 ? 3 : 0); i < w - 7; i += 6) g.fillRect(x + i, y + j, 2, 1);
  }
  // Fringes at both ends.
  g.fillStyle = edge;
  for (let j = 1; j < h - 1; j += 2) { g.fillRect(x - 1, y + j, 1, 1); g.fillRect(x + w, y + j, 1, 1); }
}

/** Where a member of a team stands: the lead's dais, or a lighter patch of the rug. */
function paintTeamPlace(g: CanvasRenderingContext2D, station: Station, team: Team, ox: number, oy: number): void {
  const x = station.x - ox;
  const y = station.y - oy;
  if (!station.lead) {
    g.fillStyle = blend(team.tint, SHADE, 0.3);
    g.fillRect(x + 2, y + 33, 44, 12);
    g.fillStyle = blend(team.tint, SHADE, 0.5);
    g.fillRect(x + 3, y + 34, 42, 10);
    return;
  }
  // The dais: a plate of the consoles' metal, a lip in the team's colour.
  const dx = x + 3;
  const dy = y + 27;
  const dw = 42;
  const dh = 17;
  g.fillStyle = 'rgba(6, 8, 14, 0.5)';
  g.fillRect(dx + 1, dy + dh + 3, dw, 2);
  g.fillStyle = '#1b202d';
  g.fillRect(dx, dy + dh, dw, 3);
  g.fillStyle = '#343c50';
  g.fillRect(dx, dy, dw, dh);
  g.fillStyle = '#4a5570';
  g.fillRect(dx, dy, dw, 1);
  g.fillStyle = '#2a3142';
  g.fillRect(dx + 14, dy + 2, 1, dh - 4); g.fillRect(dx + 27, dy + 2, 1, dh - 4);
  g.fillStyle = blend(team.tint, '#ffffff', 0.15);
  g.fillRect(dx, dy + dh - 1, dw, 1);
  g.fillStyle = blend(team.tint, SHADE, 0.45);
  g.fillRect(dx, dy + dh, dw, 1);
}

/** The free console's place: a mat only outlined — nobody stands there yet. */
function paintFreePlace(g: CanvasRenderingContext2D, slot: Slot, ox: number, oy: number): void {
  const x = slot.x - ox + 2;
  const y = slot.y - oy + 33;
  g.fillStyle = 'rgba(8, 10, 16, 0.22)';
  g.fillRect(x + 1, y + 1, 42, 10);
  g.fillStyle = LAND.deckLight;
  for (let i = 1; i < 43; i += 4) { g.fillRect(x + i, y, 2, 1); g.fillRect(x + i, y + 11, 2, 1); }
  for (let j = 2; j < 10; j += 4) { g.fillRect(x, y + j, 1, 2); g.fillRect(x + 43, y + j, 1, 2); }
}

/** A deck being built: joists on the grass, the first planks laid, the rest stacked. */
function paintSite(g: CanvasRenderingContext2D, site: Site, ox: number, oy: number): void {
  const x = site.x - ox;
  const y = site.y - oy;
  const { w, h } = site;
  const plank = (px: number, py: number, len: number) => {
    g.fillStyle = LAND.deckEdge;
    g.fillRect(px - 1, py - 1, len + 2, 5);
    g.fillStyle = LAND.deck;
    g.fillRect(px, py, len, 3);
    g.fillStyle = LAND.deckLight;
    g.fillRect(px, py, len, 1);
  };
  if (site.small) {
    // An islet: a first plank, and the emitter of the sign over it.
    plank(x + 3, y + h - 9, w - 6);
    plank(x + 6, y + h - 5, w - 12);
  } else {
    // The frame and its joists.
    g.fillStyle = LAND.deckEdge;
    g.fillRect(x, y, w, 2); g.fillRect(x, y + h - 2, w, 2);
    g.fillRect(x, y, 2, h); g.fillRect(x + w - 2, y, 2, h);
    for (let j = 10; j < h - 4; j += 10) {
      g.fillStyle = LAND.deckEdge;
      g.fillRect(x + 2, y + j, w - 4, 2);
      g.fillStyle = LAND.deckDark;
      g.fillRect(x + 2, y + j, w - 4, 1);
    }
    // Planks laid from the back, each row a little shorter than the last.
    [w - 4, w - 4, w - 4, w - 14, w - 26, w - 40].forEach((len, i) => {
      g.fillStyle = LAND.deck;
      g.fillRect(x + 2, y + 2 + i * 4, len, 4);
      g.fillStyle = LAND.deckDark;
      g.fillRect(x + 2, y + 5 + i * 4, len, 1);
      g.fillRect(x + 2 + ((i * 11) % Math.max(6, len - 6)), y + 2 + i * 4, 1, 3);
      g.fillStyle = LAND.deckEdge;
      g.fillRect(x + 2 + len, y + 2 + i * 4, 1, 4);
    });
    // The rest of the planks, stacked, and a crate of nails.
    plank(x + w - 27, y + h - 15, 20);
    plank(x + w - 25, y + h - 11, 20);
    plank(x + w - 28, y + h - 7, 20);
    g.drawImage(art().crate, x + 5, y + h - 13);
    // Corner posts.
    g.fillStyle = LAND.deckEdge;
    for (const [cx, cy] of [[x, y], [x + w - 3, y], [x, y + h - 3], [x + w - 3, y + h - 3]] as const) g.fillRect(cx, cy - 3, 3, 6);
    g.fillStyle = LAND.deckLight;
    for (const [cx, cy] of [[x, y], [x + w - 3, y], [x, y + h - 3], [x + w - 3, y + h - 3]] as const) g.fillRect(cx, cy - 3, 3, 1);
  }
  // The emitter its "+" floats over.
  const pad = sitePad(site);
  const ex = pad.x - ox;
  const ey = pad.y - oy;
  g.fillStyle = '#10131b';
  g.fillRect(ex, ey, 9, 4);
  g.fillStyle = '#3a4257';
  g.fillRect(ex + 1, ey, 7, 2);
  g.fillStyle = '#6b7590';
  g.fillRect(ex + 3, ey, 3, 1);
}

/* ─────────────────────────────────────────────────────────── water ─────── */

function cellHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const RIPPLE_W = 36;
const RIPPLE_H = 18;

/** Fill the view (world pixels x..x+w, y..y+h) with moving water. */
export function drawWater(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, time: number): void {
  g.fillStyle = WATER.deep;
  g.fillRect(x, y, w, h);
  // Slow swells: wide bands a shade lighter.
  g.fillStyle = WATER.mid;
  const swell = Math.floor(time / 900);
  for (let by = Math.floor(y / 64) - 1; by <= Math.floor((y + h) / 64); by += 1) {
    const off = Math.floor(cellHash(by, 7) * 40) + ((swell + by) % 3) * 2;
    g.fillRect(x, by * 64 + off, w, 10);
  }
  const drift = time * 0.004;
  const x0 = Math.floor((x - drift) / RIPPLE_W) - 1;
  const x1 = Math.floor((x + w - drift) / RIPPLE_W) + 1;
  const y0 = Math.floor(y / RIPPLE_H) - 1;
  const y1 = Math.floor((y + h) / RIPPLE_H) + 1;
  for (let cy = y0; cy <= y1; cy += 1) {
    for (let cx = x0; cx <= x1; cx += 1) {
      const seed = cellHash(cx, cy);
      if (seed < 0.35) continue;
      const phase = Math.sin(time * 0.0012 + seed * 40);
      if (phase < 0.1) continue;
      const rx = Math.round(cx * RIPPLE_W + drift + cellHash(cx + 91, cy) * RIPPLE_W);
      const ry = Math.round(cy * RIPPLE_H + cellHash(cx, cy + 53) * RIPPLE_H);
      const len = 3 + Math.floor(seed * 9);
      g.fillStyle = WATER.ripple;
      g.fillRect(rx, ry, len, 1);
      if (phase > 0.8) {
        g.fillStyle = WATER.glint;
        g.fillRect(rx + 1, ry, Math.max(1, len - 4), 1);
      }
    }
  }
}

/** The surf at the foot of a cliff: two frames of broken line. */
export function drawFoam(g: CanvasRenderingContext2D, foam: Array<[number, number]>, time: number): void {
  const frame = Math.floor(time / 420);
  g.fillStyle = WATER.foam;
  for (let i = 0; i < foam.length; i += 1) {
    const [fx, fy] = foam[i];
    const k = (frame + i) % 4;
    if (k === 0) { g.fillRect(fx + 1, fy, 5, 1); g.fillRect(fx + 10, fy, 3, 1); }
    else if (k === 1) { g.fillRect(fx + 3, fy, 6, 1); g.fillRect(fx + 12, fy + 1, 3, 1); }
    else if (k === 2) { g.fillRect(fx, fy + 1, 4, 1); g.fillRect(fx + 8, fy, 5, 1); }
    else { g.fillRect(fx + 5, fy + 1, 6, 1); }
  }
}

/** A soft additive glow, cached per colour. */
const glows = new Map<string, HTMLCanvasElement>();
export function glow(colour: string): HTMLCanvasElement {
  let c = glows.get(colour);
  if (c) return c;
  c = makeCanvas(64, 64);
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, colour);
  grad.addColorStop(0.35, `${colour}99`);
  grad.addColorStop(1, `${colour}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glows.set(colour, c);
  return c;
}
