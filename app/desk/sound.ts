// Four small synthesised cues (Web Audio, no file). Off until the user turns
// them on: a page that beeps uninvited is a page that gets muted for good.
let ctx: AudioContext | null = null;
let on = false;

export function soundEnabled(): boolean {
  return on;
}

export function setSound(enabled: boolean): void {
  on = enabled;
  if (!enabled) return;
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    on = false;
  }
}

function note(freq: number, at: number, length: number, type: OscillatorType = 'square', level = 0.035): void {
  if (!on || !ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const t = ctx.currentTime + at;
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(level, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

export const sfx = {
  /** A robot wants you. */
  quest(): void { note(784, 0, 0.12); note(1047, 0.11, 0.2); },
  /** A turn finished. */
  done(): void { note(523, 0, 0.1); note(659, 0.09, 0.1); note(784, 0.18, 0.1); note(1047, 0.27, 0.28); },
  fail(): void { note(220, 0, 0.18, 'sawtooth'); note(165, 0.16, 0.32, 'sawtooth'); },
  /** The user did something: an order sent, a quest cleared. */
  act(): void { note(880, 0, 0.06, 'triangle', 0.06); note(1320, 0.05, 0.1, 'triangle', 0.05); },
};

/* ───────────────────────────────── the mini-game (game/arcade.ts) ───────── */

/** A burst of filtered noise: shots, blasts. */
function noise(at: number, length: number, level: number, cutoff: number): void {
  if (!on || !ctx) return;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * length));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  const t = ctx.currentTime + at;
  gain.gain.setValueAtTime(level, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
}

let lastShot = 0;

export const arcadeSfx = {
  shot(weapon: string): void {
    const now = performance.now();
    if (now - lastShot < 45) return;
    lastShot = now;
    if (weapon === 'shotgun') { noise(0, 0.12, 0.09, 1800); note(140, 0, 0.08, 'square', 0.04); }
    else if (weapon === 'rocket') { noise(0, 0.2, 0.06, 900); note(200, 0, 0.18, 'sawtooth', 0.04); }
    else if (weapon === 'laser') note(1500, 0, 0.07, 'sawtooth', 0.025);
    else if (weapon === 'flame') noise(0, 0.06, 0.025, 2600);
    else note(weapon === 'smg' ? 780 : 620, 0, 0.045, 'square', 0.03);
  },
  hit(): void { note(310, 0, 0.03, 'square', 0.02); },
  boom(big = false): void { noise(0, big ? 0.5 : 0.26, big ? 0.16 : 0.1, big ? 500 : 800); note(big ? 55 : 80, 0, big ? 0.4 : 0.22, 'sine', 0.12); },
  pickup(): void { note(660, 0, 0.06, 'triangle', 0.06); note(990, 0.06, 0.12, 'triangle', 0.06); },
  hurt(): void { note(190, 0, 0.22, 'sawtooth', 0.07); note(120, 0.1, 0.2, 'sawtooth', 0.06); },
  dash(): void { noise(0, 0.09, 0.03, 3200); },
  wave(): void { note(392, 0, 0.09); note(523, 0.09, 0.09); note(659, 0.18, 0.09); note(784, 0.27, 0.22); },
  clear(): void { note(784, 0, 0.08, 'triangle', 0.06); note(988, 0.08, 0.08, 'triangle', 0.06); note(1175, 0.16, 0.24, 'triangle', 0.06); },
  over(): void { note(392, 0, 0.18, 'sawtooth', 0.05); note(311, 0.18, 0.18, 'sawtooth', 0.05); note(233, 0.36, 0.5, 'sawtooth', 0.05); },
};
