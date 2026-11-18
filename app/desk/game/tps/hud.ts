// The 3D phase's instruments, drawn over the stage every frame: the sight,
// what marks the robots and the vehicles, the lock, the warnings, the radar
// and a vehicle's dials. One 2D canvas, in the board's face (pixel font, flat
// colours, hard edges). It draws what it is given: it knows nothing of the
// game's rules.
import { FORM_GLYPH, type Form } from '../forms';

const INK = '#e8eef9';
const DIM = '#9aa8c0';
const EDGE = '#05080f';
const PANEL = 'rgba(13, 20, 34, 0.78)';
const LINE = '#2a3650';
const GOLD = '#ffe066';
const RED = '#ff5d5d';
const TEAL = '#35d0c7';
const FONT = "'Press Start 2P', 'JetBrains Mono', monospace";

const GLYPHS = FORM_GLYPH;

/** A thing to point at: a robot, a supply drop, a vehicle to board. */
export type Mark = {
  /** Where it is on the stage, in CSS pixels; `shown` = in front of the eye and inside the frame. */
  x: number; y: number; shown: boolean;
  /** Half its size on the stage. */
  r: number;
  dist: number;
  /** `plane`, `boat`: a vehicle to board; `tank`: the mainland, where the machine becomes one. */
  kind: 'foe' | 'big' | 'supply' | Form;
  /** 0..1, for the ones that wear their health. */
  hp: number | null;
};

export type HudFrame = {
  time: number;
  /** The player is in control (not during a scripted start, not once down). */
  live: boolean;
  /** Robots in the frame wear corners (in a vehicle: they are far); on foot only the big ones do. */
  brackets: boolean;
  /** Where the guns point; `hot` = a robot is in their line. */
  sight: { x: number; y: number } | null;
  hot: boolean;
  /** The pointer's ring, when the pointer flies the plane. */
  ring: { x: number; y: number } | null;
  marks: Mark[];
  /** The missile lock: on what, how far along (1 = locked). */
  lock: { x: number; y: number; r: number; k: number } | null;
  /** Missiles coming for the plane: where the nearest is (stage pixels, may be off it). */
  threat: { x: number; y: number; shown: boolean } | null;
  warn: string | null;
  /** A vehicle's dials; null on foot. `alt`: null for what does not fly. */
  dials: {
    speed: number; alt: number | null; power: number | null; fast: boolean; boost: number; boostDry: boolean;
    heat: number; jammed: boolean; missiles: number; maxMissiles: number;
  } | null;
  /** 0..1: how fresh the last hit is, and where it came from on the stage (an angle), if known. */
  hurt: number;
  hurtFrom: number | null;
  radar: {
    yaw: number;
    range: number;
    /** Relative to the plane, world units: x to its east, z to its south. */
    blips: Array<{ x: number; z: number; kind: 'foe' | 'big' | 'supply' | 'missile' | 'ride' }>;
    isles: Array<{ x: number; z: number; hw: number; hd: number }>;
    /** How far the edge of the fight is, and which way home is. */
    homeX: number; homeZ: number;
  };
  /** Words rising from where something happened. */
  floats: Array<{ x: number; y: number; text: string; colour: string; k: number }>;
  /** The two keys of the barrel roll, as this keyboard names them. */
  rollKeys: [string, string];
};

export class Hud {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  /** One HUD pixel, in CSS pixels: the instruments grow with the screen. */
  private unit = 1;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dk-sky-hud';
    this.g = this.canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number): void {
    this.unit = Math.max(1, Math.round(h / 620));
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.w = w / this.unit;
    this.h = h / this.unit;
    const scale = dpr * this.unit;
    this.g.setTransform(scale, 0, 0, scale, 0, 0);
    this.g.imageSmoothingEnabled = false;
  }

  private text(text: string, x: number, y: number, colour: string, size = 8, align: CanvasTextAlign = 'left'): void {
    const g = this.g;
    g.font = `${size}px ${FONT}`;
    g.textAlign = align;
    g.textBaseline = 'top';
    g.fillStyle = EDGE;
    g.fillText(text, Math.round(x) + 1, Math.round(y) + 1);
    g.fillStyle = colour;
    g.fillText(text, Math.round(x), Math.round(y));
  }

  /** Four corners around a point. */
  private corners(x: number, y: number, r: number, colour: string, arm: number, thick = 2): void {
    const g = this.g;
    const l = Math.round(x - r);
    const t = Math.round(y - r);
    const s = Math.round(r * 2);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const cx = l + dx * s;
      const cy = t + dy * s;
      g.fillStyle = EDGE;
      g.fillRect(cx + (dx ? -arm : 0) - 1, cy + (dy ? -thick : 0) - 1, arm + 2, thick + 2);
      g.fillRect(cx + (dx ? -thick : 0) - 1, cy + (dy ? -arm : 0) - 1, thick + 2, arm + 2);
    }
    g.fillStyle = colour;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const cx = l + dx * s;
      const cy = t + dy * s;
      g.fillRect(cx + (dx ? -arm : 0), cy + (dy ? -thick : 0), arm, thick);
      g.fillRect(cx + (dx ? -thick : 0), cy + (dy ? -arm : 0), thick, arm);
    }
  }

  private bar(x: number, y: number, w: number, h: number, k: number, colour: string, label: string, note = ''): void {
    const g = this.g;
    this.text(label, x, y, DIM, 7);
    if (note) this.text(note, x + w, y, colour, 7, 'right');
    g.fillStyle = EDGE;
    g.fillRect(x, y + 11, w, h);
    g.fillStyle = LINE;
    g.fillRect(x + 1, y + 12, w - 2, h - 2);
    g.fillStyle = colour;
    g.fillRect(x + 1, y + 12, Math.round((w - 2) * Math.max(0, Math.min(1, k))), h - 2);
  }

  /** A filled arrowhead at (x, y), pointing along `a`. */
  private head(x: number, y: number, a: number, colour: string, size: number): void {
    const g = this.g;
    g.save();
    g.translate(Math.round(x), Math.round(y));
    g.rotate(a);
    for (const [c, grow] of [[EDGE, 2], [colour, 0]] as const) {
      g.fillStyle = c;
      g.beginPath();
      g.moveTo(size + grow, 0);
      g.lineTo(-size * 0.7 - grow, -size * 0.75 - grow);
      g.lineTo(-size * 0.7 - grow, size * 0.75 + grow);
      g.closePath();
      g.fill();
    }
    g.restore();
  }

  /**
   * An arrow on the rim of the stage, toward something out of the frame.
   * Returns where it is and which way it points.
   */
  private arrow(x: number, y: number, colour: string, size: number, inset = 0): { x: number; y: number; a: number } {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const a = Math.atan2(y - cy, x - cx);
    const rx = cx - 34 - inset;
    const ry = cy - 78 - inset;
    // On an ellipse inside the frame.
    const k = 1 / Math.hypot(Math.cos(a) / rx, Math.sin(a) / ry);
    const at = { x: cx + Math.cos(a) * k, y: cy + Math.sin(a) * k, a };
    this.head(at.x, at.y, a, colour, size);
    return at;
  }

  /** A vehicle's badge: a gold diamond wearing its shape. */
  private badge(kind: Form, x: number, y: number, d = 11): void {
    const g = this.g;
    g.save();
    g.translate(Math.round(x), Math.round(y));
    g.rotate(Math.PI / 4);
    g.strokeStyle = EDGE; g.lineWidth = 4; g.strokeRect(-d, -d, d * 2, d * 2);
    g.fillStyle = PANEL; g.fillRect(-d, -d, d * 2, d * 2);
    g.strokeStyle = GOLD; g.lineWidth = 2; g.strokeRect(-d, -d, d * 2, d * 2);
    g.restore();
    this.glyph(GLYPHS[kind], x, y, GOLD);
  }

  draw(f: HudFrame): void {
    const g = this.g;
    const u = this.unit;
    const W = this.w;
    const H = this.h;
    g.clearRect(0, 0, W, H);
    const blink = Math.floor(f.time * 6) % 2 === 0;
    const at = (v: number) => v / u;

    // A hit: the frame goes red from the side it came from (or all round).
    if (f.hurt > 0.02) {
      const edge = 90;
      const alpha = Math.min(0.6, f.hurt * 0.6);
      const sides: Array<[number, number, number, number, number, number, number, number, number]> = [
        [0, 0, edge, H, 0, 0, edge, 0, Math.PI],
        [W - edge, 0, edge, H, W, 0, W - edge, 0, 0],
        [0, 0, W, edge, 0, 0, 0, edge, -Math.PI / 2],
        [0, H - edge, W, edge, 0, H, 0, H - edge, Math.PI / 2],
      ];
      for (const [x, y, w, h, x0, y0, x1, y1, facing] of sides) {
        let k = 1;
        if (f.hurtFrom != null) {
          const d = Math.abs(Math.atan2(Math.sin(f.hurtFrom - facing), Math.cos(f.hurtFrom - facing)));
          k = Math.max(0.15, 1 - d / 1.6);
        }
        const grad = g.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, `rgba(255, 60, 60, ${alpha * k})`);
        grad.addColorStop(1, 'rgba(255, 60, 60, 0)');
        g.fillStyle = grad;
        g.fillRect(x, y, w, h);
      }
    }

    /* ── what is out there ── */

    for (const m of f.marks) {
      const enemy = m.kind === 'foe' || m.kind === 'big';
      const x = at(m.x);
      const y = at(m.y);
      const ride = m.kind === 'plane' || m.kind === 'boat' || m.kind === 'tank' ? m.kind : null;
      if (!m.shown) {
        if (ride) {
          // A vehicle out of the frame: a big arrow that beats, its badge behind it.
          const beat = Math.abs(Math.sin(f.time * 5));
          const p = this.arrow(x, y, GOLD, 17 + beat * 3, 4 - beat * 6);
          const bx = p.x - Math.cos(p.a) * 36;
          const by = p.y - Math.sin(p.a) * 36;
          this.badge(ride, bx, by);
          // How far, beside the badge (never under the arrow).
          this.text(String(Math.round(m.dist / 10) * 10), bx - Math.sin(p.a) * 26, by + Math.cos(p.a) * 22 - 4, GOLD, 7, 'center');
        } else this.arrow(x, y, enemy ? RED : GOLD, m.kind === 'big' ? 12 : 8);
        continue;
      }
      if (ride) {
        // In the frame: an arrow that bounces down onto where to board, its badge over it.
        const bob = Math.abs(Math.sin(f.time * 5)) * 7;
        this.head(x, y - 16 - bob, Math.PI / 2, GOLD, 11);
        this.badge(ride, x, y - 48 - bob);
        this.text(String(Math.round(m.dist / 10) * 10), x + 21, y - 52 - bob, GOLD, 7, 'left');
        continue;
      }
      const r = Math.max(m.kind === 'big' ? 16 : 7, at(m.r) + 3);
      if (!enemy) {
        // Supplies to fly through: a gold diamond round them, and how far.
        const d = r * 0.75;
        g.save();
        g.translate(Math.round(x), Math.round(y));
        g.rotate(Math.PI / 4);
        g.strokeStyle = EDGE; g.lineWidth = 4; g.strokeRect(-d, -d, d * 2, d * 2);
        g.strokeStyle = GOLD; g.lineWidth = 2; g.strokeRect(-d, -d, d * 2, d * 2);
        g.restore();
        this.text(String(Math.round(m.dist / 10) * 10), x, y + d * 1.4 + 6, GOLD, 7, 'center');
        continue;
      }
      if (!f.brackets && m.kind !== 'big') continue;
      this.corners(x, y, r, RED, Math.max(3, Math.min(8, Math.round(r * 0.5))));
      if (m.hp != null && m.hp < 1) {
        const w = Math.max(18, Math.round(r * 2));
        g.fillStyle = EDGE;
        g.fillRect(Math.round(x - w / 2) - 1, Math.round(y - r) - 8, w + 2, 5);
        g.fillStyle = RED;
        g.fillRect(Math.round(x - w / 2), Math.round(y - r) - 7, Math.round(w * m.hp), 3);
      }
    }

    /* ── the lock ── */

    if (f.lock) {
      const x = at(f.lock.x);
      const y = at(f.lock.y);
      const locked = f.lock.k >= 1;
      // A diamond that closes on the target, then holds.
      const r = Math.max(9, at(f.lock.r) + 5) * (locked ? 1 : 2.6 - 1.6 * f.lock.k);
      const colour = locked ? (blink ? GOLD : '#fff3c9') : INK;
      g.save();
      g.translate(Math.round(x), Math.round(y));
      g.rotate(Math.PI / 4 + (locked ? 0 : f.time * 3));
      g.strokeStyle = EDGE; g.lineWidth = 4; g.strokeRect(-r, -r, r * 2, r * 2);
      g.strokeStyle = colour; g.lineWidth = 2; g.strokeRect(-r, -r, r * 2, r * 2);
      g.restore();
      if (locked) this.text('LOCK', x, y - r * 1.5 - 12, GOLD, 8, 'center');
    }

    /* ── the sight ── */

    if (f.live && f.ring) {
      const x = Math.round(at(f.ring.x));
      const y = Math.round(at(f.ring.y));
      g.strokeStyle = EDGE; g.lineWidth = 4;
      g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = INK; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
    }
    if (f.live && f.sight) {
      const x = Math.round(at(f.sight.x));
      const y = Math.round(at(f.sight.y));
      const colour = f.dials?.jammed ? DIM : f.hot ? RED : GOLD;
      for (const [c, grow] of [[EDGE, 1], [colour, 0]] as const) {
        g.fillStyle = c;
        g.fillRect(x - 1 - grow, y - 1 - grow, 2 + grow * 2, 2 + grow * 2);
        g.fillRect(x - 11 - grow, y - 1 - grow, 6 + grow * 2, 2 + grow * 2);
        g.fillRect(x + 5 - grow, y - 1 - grow, 6 + grow * 2, 2 + grow * 2);
        g.fillRect(x - 1 - grow, y - 11 - grow, 2 + grow * 2, 6 + grow * 2);
        g.fillRect(x - 1 - grow, y + 5 - grow, 2 + grow * 2, 6 + grow * 2);
      }
    }

    /* ── warnings ── */

    if (f.threat) {
      if (blink) this.text('MISSILE', W / 2, H / 2 - 118, RED, 12, 'center');
      this.keycap(W / 2 - 17, H / 2 - 102, f.rollKeys[0]);
      this.keycap(W / 2 + 3, H / 2 - 102, f.rollKeys[1]);
      if (f.threat.shown) this.corners(at(f.threat.x), at(f.threat.y), 7, blink ? RED : GOLD, 4);
      else this.arrow(at(f.threat.x), at(f.threat.y), blink ? RED : GOLD, 8);
    }
    if (f.warn && blink) this.text(f.warn, W / 2, H / 2 + 84, f.warn === 'OVERHEAT' ? GOLD : RED, 10, 'center');

    for (const fl of f.floats) {
      g.globalAlpha = fl.k > 0.7 ? (1 - fl.k) / 0.3 : 1;
      this.text(fl.text, at(fl.x), at(fl.y) - fl.k * 26, fl.colour, 8, 'center');
    }
    g.globalAlpha = 1;

    /* ── instruments ── */

    const d = f.dials;
    if (d) {
      // Speed and height, either side of the sight, as on a real one.
      if (f.live) {
        const cy = Math.round(H / 2) - 6;
        this.text('SPD', W / 2 - 176, cy - 12, DIM, 6, 'right');
        this.text(String(Math.round(d.speed)).padStart(3, '0'), W / 2 - 176, cy, d.fast ? GOLD : INK, 10, 'right');
        if (d.alt != null) {
          this.text('ALT', W / 2 + 176, cy - 12, DIM, 6);
          this.text(String(Math.max(0, Math.round(d.alt))).padStart(4, '0'), W / 2 + 176, cy, d.alt < 120 ? RED : INK, 10);
        }
      }
      // Bottom left: the throttle (what has one), the afterburner, the guns' heat, the missiles.
      const px = 14;
      const tall = d.power != null ? 108 : 84;
      const py = H - 12 - tall;
      g.fillStyle = PANEL;
      g.fillRect(px, py, 150, tall);
      g.strokeStyle = LINE; g.lineWidth = 2;
      g.strokeRect(px + 1, py + 1, 148, tall - 2);
      if (d.power != null) {
        this.bar(px + 10, py + 9, 130, 8, d.power, INK, 'POWER');
        g.translate(0, 24);
      }
      this.bar(px + 10, py + 9, 130, 8, d.boost, d.boostDry ? DIM : TEAL, 'BOOST', d.boostDry ? 'REFILL' : '');
      this.bar(px + 10, py + 33, 130, 8, d.heat, d.jammed ? RED : d.heat > 0.7 ? GOLD : INK, 'GUNS', d.jammed ? 'HOT' : '');
      this.text('MISSILES', px + 10, py + 59, DIM, 7);
      for (let i = 0; i < d.maxMissiles; i += 1) {
        g.fillStyle = EDGE;
        g.fillRect(px + 10 + i * 12, py + 70, 9, 7);
        g.fillStyle = i < d.missiles ? GOLD : LINE;
        g.fillRect(px + 11 + i * 12, py + 71, 7, 5);
      }
      if (d.power != null) g.translate(0, -24);
    }

    // Top left: the radar, the plane's nose up.
    const size = 104;
    const rx = 14;
    const ry = 128;
    g.fillStyle = PANEL;
    g.fillRect(rx, ry, size, size);
    g.save();
    g.beginPath();
    g.rect(rx + 2, ry + 2, size - 4, size - 4);
    g.clip();
    const cx = rx + size / 2;
    const cy2 = ry + size / 2;
    const k = (size / 2 - 4) / f.radar.range;
    // The world, turned so that the nose is up: east is the plane's `-right` at yaw 0.
    const cosy = Math.cos(f.radar.yaw);
    const siny = Math.sin(f.radar.yaw);
    const place = (x: number, z: number): [number, number] => {
      const side = x * -cosy + z * siny;      // to the right of the nose
      const ahead = x * siny + z * cosy;      // ahead of it
      return [cx + side * k, cy2 - ahead * k];
    };
    g.fillStyle = 'rgba(79, 138, 95, 0.55)';
    for (const isle of f.radar.isles) {
      const [ix, iy] = place(isle.x, isle.z);
      g.save();
      g.translate(ix, iy);
      // A step east on the map goes along (-cos, -sin) on the dial.
      g.rotate(Math.atan2(-siny, -cosy));
      g.fillRect(-isle.hw * k, -isle.hd * k, isle.hw * 2 * k, isle.hd * 2 * k);
      g.restore();
    }
    g.fillStyle = 'rgba(232, 238, 249, 0.14)';
    g.fillRect(cx - 0.5, ry, 1, size);
    g.fillRect(rx, cy2 - 0.5, size, 1);
    for (const b of f.radar.blips) {
      let [bx, by] = place(b.x, b.z);
      // Out of range: on the rim.
      const d = Math.max(Math.abs(bx - cx), Math.abs(by - cy2)) / (size / 2 - 5);
      if (d > 1) { bx = cx + (bx - cx) / d; by = cy2 + (by - cy2) / d; }
      const s = b.kind === 'big' ? 5 : 3;
      if (b.kind === 'missile' && !blink) continue;
      g.fillStyle = b.kind === 'supply' || b.kind === 'ride' ? GOLD : b.kind === 'missile' ? '#ffffff' : RED;
      g.fillRect(Math.round(bx - s / 2), Math.round(by - s / 2), s, s);
    }
    // The plane.
    g.fillStyle = INK;
    g.beginPath();
    g.moveTo(cx, cy2 - 5); g.lineTo(cx + 4, cy2 + 4); g.lineTo(cx, cy2 + 2); g.lineTo(cx - 4, cy2 + 4);
    g.closePath();
    g.fill();
    g.restore();
    g.strokeStyle = LINE; g.lineWidth = 2;
    g.strokeRect(rx + 1, ry + 1, size - 2, size - 2);
    // Which way home is, on the frame.
    const [hx, hy] = place(f.radar.homeX, f.radar.homeZ);
    const far = Math.hypot(hx - cx, hy - cy2);
    if (far > size / 2 - 6) {
      const a = Math.atan2(hy - cy2, hx - cx);
      const e = (size / 2 - 1) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      g.fillStyle = TEAL;
      g.fillRect(Math.round(cx + Math.cos(a) * e) - 2, Math.round(cy2 + Math.sin(a) * e) - 2, 5, 5);
    }
  }

  /** A small shape, its middle on a point. */
  private glyph(rows: string[], x: number, y: number, colour: string): void {
    const g = this.g;
    const left = Math.round(x - rows[0].length / 2);
    const top = Math.round(y - rows.length / 2);
    g.fillStyle = colour;
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i += 1) if (row[i] === '#') g.fillRect(left + i, top + j, 1, 1);
    });
  }

  private capWidth(label: string): number {
    return Math.max(14, label.length * 7 + 7);
  }

  /** A key, as a key; returns its width. */
  private keycap(x: number, y: number, label: string): number {
    const g = this.g;
    const w = this.capWidth(label);
    g.fillStyle = EDGE;
    g.fillRect(x - 1, y - 1, w + 2, 17);
    g.fillStyle = LINE;
    g.fillRect(x, y, w, 15);
    g.fillStyle = '#131c2e';
    g.fillRect(x + 1, y + 1, w - 2, 11);
    this.text(label, x + w / 2, y + 3, INK, 7, 'center');
    return w;
  }
}
