// The parts of the board that never move: an island's ground, cliffs and decks
// are painted ONCE per shape into a canvas of their own, then blitted. The
// water is the only scenery redrawn every frame.
import { LAND, T, WATER, art, makeCanvas } from './art';
import type { Island } from './layout';
import { seeded } from './model';

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
    // A woven mat under each station.
    for (const station of plot.stations) {
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
