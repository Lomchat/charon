// The board's four small synthesised cues (Web Audio, no file). Off until the
// user turns them on: a page that beeps uninvited is a page that gets muted
// for good. The mini-game has its own sound: game/audio.ts.
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
