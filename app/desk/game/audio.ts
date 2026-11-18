// The mini-game's sound (game/arcade.ts): its music and its effects.
//
// Everything is SYNTHESISED with Web Audio — no file, nothing fetched, nothing
// borrowed: the tune is this file's own. Three things make it more than beeps:
//
//   - effects are LAYERED (a crack + a body + a tail, never one oscillator),
//     vary a little each time, and are placed in the stereo field by where
//     they happen relative to the pilot;
//   - the music is a step sequencer whose layers follow the fight — the drop,
//     a wave, the heat of a crowded one, a boss, the lull between two, the end;
//   - one bus chain glues it: a small room reverb, a limiter, and the music
//     ducking under the big blasts.
//
// It belongs to a run: built by the key or click that starts one (the gesture
// a browser wants before any sound), closed when the run ends.

export type AudioMode = 'all' | 'sfx' | 'off';

const MODE_KEY = 'desk.arcade.audio';

/** Music and effects unless the player chose otherwise: PLAY is a deliberate act. */
export function readAudioMode(): AudioMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'sfx' || v === 'off' ? v : 'all';
  } catch { return 'all'; }
}

function keepAudioMode(mode: AudioMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
}

export function nextAudioMode(mode: AudioMode): AudioMode {
  return mode === 'all' ? 'sfx' : mode === 'sfx' ? 'off' : 'all';
}

/** Seconds after a turn begins that its last plate seats (tps/morph.ts § MORPH_TIME, a hair early). */
const MORPH_LOCK = 1.08;

/** What the game looks like right now: where the ears are, and how tense it is. */
export type AudioScene = {
  x: number; y: number;
  phase: 'intro' | 'wave' | 'clear' | 'over';
  paused: boolean;
  wave: number;
  /** A boss stands, or is on its way down. */
  boss: boolean;
  foes: number;
  hp: number;
  heli: { x: number; y: number } | null;
  walking: boolean;
  /** In a vehicle: which, its pace (1 = cruise) and its afterburner; null on foot. */
  engine?: { kind: 'plane' | 'boat' | 'tank'; pace: number; boost: boolean } | null;
  /** Seen from behind the pilot: which way it faces (its forward on the board is (sin, cos)) — left and right are its own. */
  yaw?: number;
};

type Wave = OscillatorType | PeriodicWave;
type ToneOpts = {
  wave?: Wave; f: number; to?: number; at?: number; when?: number; dur: number; gain: number; attack?: number;
  /** Share of `dur` the pitch slide takes. */
  sweep?: number; pan?: number; dest?: AudioNode; wet?: number;
  /** Cents of vibrato, coming in after a short delay. */
  vibrato?: number;
};
type NoiseOpts = {
  at?: number; when?: number; dur: number; gain: number; attack?: number; type?: BiquadFilterType;
  f: number; to?: number; q?: number; pan?: number; dest?: AudioNode; wet?: number; brown?: boolean;
};

const midi = (m: number): number => 440 * 2 ** ((m - 69) / 12);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

/* ───────────────────────────────────────────────────────── the tune ─── */
// A minor. Per bar: the bass root, and the chord's three tones (the arpeggio
// climbs them, the pad holds them).
type Chord = [root: number, tones: [number, number, number]];
const AM: Chord = [45, [57, 60, 64]];
const F: Chord = [41, [57, 60, 65]];
const C: Chord = [48, [60, 64, 67]];
const G: Chord = [43, [59, 62, 67]];
const DM: Chord = [38, [57, 62, 65]];
const E: Chord = [40, [56, 59, 64]];
const BB: Chord = [46, [58, 62, 65]];

type Section = 'intro' | 'main' | 'boss' | 'over';
const CHORDS: Record<Section, Chord[]> = {
  intro: [AM, AM, AM, AM, AM, AM, AM, AM],
  main: [AM, F, C, G, AM, F, DM, E],
  boss: [AM, AM, BB, BB, AM, AM, G, E],
  over: [AM, F, C, E, AM, F, C, E],
};

/** Semitones above the root, a sixteenth each; null = a rest. */
const BASS: Record<'main' | 'boss', Array<number | null>> = {
  main: [0, null, 0, 12, 0, null, 0, 12, 0, null, 0, 12, 0, null, 7, 12],
  boss: [0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 7, 10, 12],
};

/** Which chord tone the arpeggio plays on each sixteenth (3 = the root, an octave up). */
const ARP = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3];

/** The melody: [bar, sixteenth, note, length in sixteenths]. */
type Note = [number, number, number, number];
const LEAD: Record<'main' | 'boss', Note[]> = {
  main: [
    [0, 0, 76, 3], [0, 4, 81, 2], [0, 6, 79, 2], [0, 8, 76, 4], [0, 12, 72, 2], [0, 14, 74, 2],
    [1, 0, 72, 6], [1, 6, 69, 2], [1, 8, 72, 2], [1, 10, 77, 4], [1, 14, 76, 2],
    [2, 0, 79, 3], [2, 4, 76, 2], [2, 6, 79, 2], [2, 8, 84, 4], [2, 12, 83, 2], [2, 14, 79, 2],
    [3, 0, 83, 4], [3, 4, 81, 2], [3, 6, 79, 2], [3, 8, 74, 6],
    [4, 0, 76, 3], [4, 4, 81, 2], [4, 6, 83, 2], [4, 8, 84, 4], [4, 12, 83, 2], [4, 14, 81, 2],
    [5, 0, 81, 4], [5, 4, 77, 2], [5, 6, 81, 2], [5, 8, 84, 6], [5, 14, 81, 2],
    [6, 0, 77, 2], [6, 2, 81, 2], [6, 4, 86, 4], [6, 8, 84, 2], [6, 10, 81, 2], [6, 12, 77, 2], [6, 14, 74, 2],
    [7, 0, 76, 4], [7, 4, 80, 4], [7, 8, 83, 4], [7, 12, 88, 4],
  ],
  boss: [
    [0, 0, 81, 6], [0, 6, 82, 2], [0, 8, 81, 4], [0, 12, 76, 4],
    [1, 0, 84, 6], [1, 6, 82, 2], [1, 8, 81, 8],
    [2, 0, 86, 6], [2, 6, 82, 2], [2, 8, 77, 8],
    [3, 0, 82, 4], [3, 4, 86, 4], [3, 8, 89, 4], [3, 12, 86, 4],
    [4, 0, 88, 6], [4, 6, 89, 2], [4, 8, 88, 4], [4, 12, 84, 4],
    [5, 0, 81, 2], [5, 2, 84, 2], [5, 4, 88, 4], [5, 8, 86, 2], [5, 10, 84, 2], [5, 12, 81, 4],
    [6, 0, 83, 4], [6, 4, 79, 4], [6, 8, 74, 8],
    [7, 0, 76, 2], [7, 2, 80, 2], [7, 4, 83, 2], [7, 6, 88, 2], [7, 8, 92, 8],
  ],
};
const leadAt = (notes: Note[]): Map<number, [number, number]> => new Map(notes.map(([bar, step, note, len]) => [bar * 16 + step, [note, len]]));
const LEAD_AT = { main: leadAt(LEAD.main), boss: leadAt(LEAD.boss) };

const MUSIC_LEVEL = 0.44;
const SFX_LEVEL = 0.56;
/** Effects that may be dropped when too much sounds at once. */
const BUSY = 44;

export class ArcadeAudio {
  private ctx: AudioContext | null = null;
  private mode: AudioMode;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private musicTone!: BiquadFilterNode;
  private duckGain!: GainNode;
  private echo!: GainNode;
  private room!: GainNode;
  private crunch!: GainNode;
  private meter!: AnalyserNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private pulse25!: PeriodicWave;
  private pulse12!: PeriodicWave;
  private voices = 0;
  private gates = new Map<string, number>();

  // The loops: what never stops while its thing is there.
  private rotor: { gain: GainNode; pan: StereoPannerNode } | null = null;
  private engine: { gain: GainNode; drone: OscillatorNode; tone: BiquadFilterNode; wind: GainNode; roar: GainNode } | null = null;
  /** Semitones the tune is raised by (the flight phase plays it higher). */
  private lift = 0;
  private flame: { gain: GainNode } | null = null;
  private flameHold = 0;
  private beatIn = 0;
  private stepIn = 0;

  // The sequencer.
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextAt = 0;
  private step = 0;
  private section: Section = 'intro';
  private level = 0;
  private bpm = 132;
  private scene: AudioScene = { x: 0, y: 0, phase: 'intro', paused: false, wave: 0, boss: false, foes: 0, hp: 5, heli: null, walking: false };
  private echoDelay: DelayNode | null = null;
  private wasPaused = false;

  constructor(mode: AudioMode = readAudioMode()) {
    this.mode = mode;
    try {
      this.build(new AudioContext());
    } catch {
      this.ctx = null;   // no audio here: every call below is a no-op
    }
  }

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    // master → limiter → out; a tap for the meter after the limiter.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.knee.value = 8; limiter.ratio.value = 10;
    limiter.attack.value = 0.003; limiter.release.value = 0.18;
    this.master = ctx.createGain();
    this.master.gain.value = this.mode === 'off' ? 0 : 0.9;
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    this.master.connect(limiter);
    limiter.connect(ctx.destination);
    limiter.connect(this.meter);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = SFX_LEVEL;
    this.sfx.connect(this.master);

    // Music: its own tone control (muffled when paused, opening during the
    // drop), then the gain the blasts push down.
    this.music = ctx.createGain();
    this.music.gain.value = this.mode === 'all' ? MUSIC_LEVEL : 0;
    this.musicTone = ctx.createBiquadFilter();
    this.musicTone.type = 'lowpass';
    this.musicTone.frequency.value = 900;
    this.duckGain = ctx.createGain();
    this.music.connect(this.musicTone);
    this.musicTone.connect(this.duckGain);
    this.duckGain.connect(this.master);

    // A dotted-eighth echo for the melody and the arpeggio.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = (60 / this.bpm / 4) * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.22;
    this.echo = ctx.createGain();
    this.echo.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(echoOut);
    echoOut.connect(this.music);
    this.echoDelay = delay;

    // Noise, made once.
    const len = Math.floor(ctx.sampleRate * 2);
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i += 1) {
      const v = Math.random() * 2 - 1;
      w[i] = v;
      last = (last + 0.02 * v) / 1.02;
      b[i] = last * 3.5;
    }

    // A small room: decaying noise as an impulse response.
    const tail = Math.floor(ctx.sampleRate * 1.1);
    const impulse = ctx.createBuffer(2, tail, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch += 1) {
      const d = impulse.getChannelData(ch);
      for (let i = 0; i < tail; i += 1) d[i] = (Math.random() * 2 - 1) * (1 - i / tail) ** 2.6;
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse;
    const roomOut = ctx.createGain();
    roomOut.gain.value = 0.5;
    this.room = ctx.createGain();
    this.room.connect(reverb);
    reverb.connect(roomOut);
    roomOut.connect(this.master);

    // Blasts go through a soft clip: grit, not volume.
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i += 1) curve[i] = Math.tanh(((i / 1023) * 2 - 1) * 2.6);
    shaper.curve = curve;
    this.crunch = ctx.createGain();
    this.crunch.connect(shaper);
    shaper.connect(this.sfx);

    this.pulse25 = pulseWave(ctx, 0.25);
    this.pulse12 = pulseWave(ctx, 0.125);

    void ctx.resume();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.nextAt = ctx.currentTime + 0.08;
    this.timer = setInterval(this.tick, 25);
  }

  /** A hidden tab throttles timers: the tune would stutter. It waits instead. */
  private onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.visibilityState === 'hidden') void ctx.suspend();
    else {
      void ctx.resume();
      this.nextAt = Math.max(this.nextAt, ctx.currentTime + 0.06);
    }
  };

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (ctx) void ctx.close().catch(() => undefined);
  }

  getMode(): AudioMode { return this.mode; }

  /** The M key: music and effects → effects only → silence. */
  cycleMode(): AudioMode {
    this.mode = nextAudioMode(this.mode);
    keepAudioMode(this.mode);
    const ctx = this.ctx;
    if (ctx) {
      const t = ctx.currentTime;
      this.master.gain.setTargetAtTime(this.mode === 'off' ? 0 : 0.9, t, 0.03);
      this.music.gain.setTargetAtTime(this.mode === 'all' ? MUSIC_LEVEL * (this.wasPaused ? 0.45 : 1) : 0, t, 0.06);
      this.nextAt = Math.max(this.nextAt, t + 0.05);
      if (this.mode !== 'off') this.tone({ wave: this.pulse25, f: 880, dur: 0.07, gain: 0.1 });
    }
    return this.mode;
  }

  /** How loud the output is right now (after the limiter): for a test, never for the game. */
  loudness(): { peak: number; rms: number } {
    if (!this.ctx) return { peak: 0, rms: 0 };
    const data = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(data);
    let peak = 0;
    let sum = 0;
    for (const v of data) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
    return { peak, rms: Math.sqrt(sum / data.length) };
  }

  private get live(): boolean { return this.ctx != null && this.mode !== 'off'; }

  /** At most one of `key` per `ms`. */
  private gate(key: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.gates.get(key) ?? -1e9) < ms) return false;
    this.gates.set(key, now);
    return true;
  }

  /** Where a sound sits for the pilot's ears: left or right, and how near. */
  private at(x: number, y: number): { pan: number; vol: number } {
    const ex = x - this.scene.x;
    const ey = y - this.scene.y;
    const yaw = this.scene.yaw;
    // To the right of the ears: of the board, or of the pilot it is seen from behind.
    const dx = yaw == null ? ex : -Math.cos(yaw) * ex + Math.sin(yaw) * ey;
    const d = Math.hypot(ex, ey);
    return { pan: Math.max(-0.85, Math.min(0.85, dx / 150)), vol: Math.max(0.3, 1 / (1 + (d / 170) ** 2)) };
  }

  /* ─────────────────────────────────────────────────────── the voices ─── */

  private out(node: AudioNode, pan: number | undefined, dest: AudioNode | undefined, wet: number | undefined): void {
    const ctx = this.ctx!;
    let from = node;
    if (pan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(panner);
      from = panner;
    }
    from.connect(dest ?? this.sfx);
    if (wet) {
      const send = ctx.createGain();
      send.gain.value = wet;
      from.connect(send);
      send.connect(this.room);
    }
  }

  private env(gain: AudioParam, t: number, peak: number, attack: number, dur: number): void {
    gain.setValueAtTime(0.0001, t);
    gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.max(0.002, attack));
    gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, dur));
  }

  private tone(o: ToneOpts): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = o.when ?? ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    if (typeof o.wave === 'object') osc.setPeriodicWave(o.wave);
    else osc.type = o.wave ?? 'square';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.to != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + o.dur * (o.sweep ?? 1));
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.6;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(o.vibrato, t + Math.min(0.16, o.dur * 0.5));
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t);
      lfo.stop(t + o.dur + 0.03);
    }
    const g = ctx.createGain();
    this.env(g.gain, t, o.gain, o.attack ?? 0.004, o.dur);
    osc.connect(g);
    this.out(g, o.pan, o.dest, o.wet);
    // Effects only: the tune is scheduled ahead and must not crowd them out.
    if (o.when == null) {
      this.voices += 1;
      osc.onended = () => { this.voices -= 1; };
    }
    osc.start(t);
    osc.stop(t + o.dur + 0.03);
  }

  private noise(o: NoiseOpts): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = o.when ?? ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = o.brown ? this.brown : this.white;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? 'lowpass';
    filter.frequency.setValueAtTime(o.f, t);
    if (o.to != null) filter.frequency.exponentialRampToValueAtTime(Math.max(30, o.to), t + o.dur);
    filter.Q.value = o.q ?? 0.7;
    const g = ctx.createGain();
    this.env(g.gain, t, o.gain, o.attack ?? 0.003, o.dur);
    src.connect(filter);
    filter.connect(g);
    this.out(g, o.pan, o.dest, o.wet);
    if (o.when == null) {
      this.voices += 1;
      src.onended = () => { this.voices -= 1; };
    }
    src.start(t, Math.random() * 1.8);
    src.stop(t + o.dur + 0.03);
  }

  /** The music steps aside for `hold` seconds: a blast is heard, not buried. */
  private duck(depth: number, hold: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(1 - depth, t, 0.012);
    g.setTargetAtTime(1, t + hold, 0.22);
  }

  /* ──────────────────────────────────────────────────────── per frame ─── */

  /** Once per frame, paused or not: the loops and the tune follow the scene. */
  update(dt: number, scene: AudioScene): void {
    this.scene = scene;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (scene.paused !== this.wasPaused) {
      this.wasPaused = scene.paused;
      this.tone({ wave: this.pulse25, f: scene.paused ? 660 : 880, to: scene.paused ? 440 : 1320, dur: 0.09, gain: 0.08 });
      // Behind a wall, and further away.
      if (this.mode === 'all') this.music.gain.setTargetAtTime(MUSIC_LEVEL * (scene.paused ? 0.45 : 1), t, 0.08);
    }
    // Paused: the tune goes on behind a wall. The drop: it opens as the pilot nears.
    const open = scene.paused ? 380 : this.section === 'intro' ? 1500 : this.section === 'over' ? 2600 : 15000;
    this.musicTone.frequency.setTargetAtTime(open, t, scene.paused ? 0.05 : 0.5);

    // The helicopter: there while it flies, nearer and farther, left and right.
    if (scene.heli && this.live) {
      const rotor = this.rotor ?? (this.rotor = this.startRotor(ctx));
      const where = this.at(scene.heli.x, scene.heli.y);
      rotor.gain.gain.setTargetAtTime(scene.paused ? 0 : 0.5 * where.vol, t, 0.12);
      rotor.pan.pan.setTargetAtTime(where.pan, t, 0.1);
    } else if (this.rotor) this.rotor.gain.gain.setTargetAtTime(0, t, 0.25);

    // A vehicle: its engine follows its pace, the wind too; the afterburner roars.
    // The boat's is lower and rounder; the plane's is chopped by its blades.
    const e = scene.engine;
    if (e && this.live) {
      const engine = this.engine ?? (this.engine = this.startEngine(ctx));
      const pace = Math.max(0.1, Math.min(3, e.pace));
      // What sails or drives: lower and rounder; a tank lower still.
      const boat = e.kind !== 'plane';
      const low = e.kind === 'tank' ? 0.78 : 1;
      const quiet = scene.paused || scene.phase === 'over';
      engine.gain.gain.setTargetAtTime(quiet ? 0 : 1, t, 0.15);
      engine.drone.frequency.setTargetAtTime(boat ? (34 + 22 * pace) * low : 52 + 30 * Math.min(2, pace) + (e.boost ? 14 : 0), t, 0.12);
      engine.tone.frequency.setTargetAtTime(boat ? 180 + 120 * pace : 300 + 260 * Math.min(2, pace), t, 0.15);
      engine.wind.gain.setTargetAtTime(boat ? 0.02 + 0.04 * pace : 0.03 + 0.1 * Math.max(0, Math.min(2.2, pace) - 0.4) ** 1.5, t, 0.2);
      engine.roar.gain.setTargetAtTime(e.boost ? 0.22 : 0, t, e.boost ? 0.06 : 0.25);
    } else if (this.engine) this.engine.gain.gain.setTargetAtTime(0, t, 0.2);

    // The flamer roars while its trigger is held.
    this.flameHold -= dt;
    if (this.flameHold > 0 && this.live && !scene.paused) {
      const flame = this.flame ?? (this.flame = this.startFlame(ctx));
      flame.gain.gain.setTargetAtTime(0.3, t, 0.03);
    } else if (this.flame) this.flame.gain.gain.setTargetAtTime(0, t, 0.06);

    if (scene.paused || !this.live || (scene.phase !== 'wave' && scene.phase !== 'clear')) return;
    // One heart left: you hear it.
    if (scene.hp === 1) {
      this.beatIn -= dt;
      if (this.beatIn <= 0) {
        this.beatIn = 0.82;
        this.tone({ wave: 'sine', f: 78, to: 44, dur: 0.14, gain: 0.5 });
        this.tone({ wave: 'sine', f: 66, to: 40, dur: 0.16, gain: 0.38, at: 0.2 });
      }
    } else this.beatIn = 0;
    // Boots on the planks.
    if (scene.walking) {
      this.stepIn -= dt;
      if (this.stepIn <= 0) {
        this.stepIn = 0.26;
        this.noise({ dur: 0.045, gain: 0.07, type: 'bandpass', f: rnd(420, 620), q: 1.6 });
      }
    } else this.stepIn = 0.08;
  }

  /** A propeller plane: a drone chopped by its blades, the wind, and an afterburner on top. */
  private startEngine(ctx: AudioContext): NonNullable<ArcadeAudio['engine']> {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const drone = ctx.createOscillator();
    drone.type = 'sawtooth';
    drone.frequency.value = 80;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 500;
    tone.Q.value = 1.2;
    const body = ctx.createGain();
    body.gain.value = 0.085;
    const chop = ctx.createGain();
    chop.gain.value = 0.7;
    const blades = ctx.createOscillator();
    blades.type = 'sine';
    blades.frequency.value = 23;
    const depth = ctx.createGain();
    depth.gain.value = 0.3;
    blades.connect(depth);
    depth.connect(chop.gain);
    drone.connect(tone);
    tone.connect(chop);
    chop.connect(body);
    body.connect(gain);
    const air = ctx.createBufferSource();
    air.buffer = this.white;
    air.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.5;
    const wind = ctx.createGain();
    wind.gain.value = 0.04;
    air.connect(band);
    band.connect(wind);
    wind.connect(gain);
    const fire = ctx.createBufferSource();
    fire.buffer = this.brown;
    fire.loop = true;
    const roar = ctx.createGain();
    roar.gain.value = 0;
    fire.connect(roar);
    roar.connect(gain);
    gain.connect(this.sfx);
    drone.start(); blades.start(); air.start(); fire.start();
    return { gain, drone, tone, wind, roar };
  }

  private startRotor(ctx: AudioContext): { gain: GainNode; pan: StereoPannerNode } {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    // The blades chop a low roar a dozen times a second…
    const air = ctx.createBufferSource();
    air.buffer = this.brown;
    air.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 520;
    const chop = ctx.createGain();
    chop.gain.value = 0.55;
    const blades = ctx.createOscillator();
    blades.type = 'sawtooth';
    blades.frequency.value = 13;
    const depth = ctx.createGain();
    depth.gain.value = 0.45;
    blades.connect(depth);
    depth.connect(chop.gain);
    air.connect(low);
    low.connect(chop);
    chop.connect(gain);
    // …over the turbine's whine.
    const turbine = ctx.createOscillator();
    turbine.type = 'sawtooth';
    turbine.frequency.value = 96;
    const whine = ctx.createBiquadFilter();
    whine.type = 'lowpass';
    whine.frequency.value = 620;
    const quiet = ctx.createGain();
    quiet.gain.value = 0.16;
    turbine.connect(whine);
    whine.connect(quiet);
    quiet.connect(gain);
    gain.connect(pan);
    pan.connect(this.sfx);
    air.start();
    blades.start();
    turbine.start();
    return { gain, pan };
  }

  private startFlame(ctx: AudioContext): { gain: GainNode } {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 780;
    band.Q.value = 0.6;
    // It flutters.
    const flutter = ctx.createOscillator();
    flutter.frequency.value = 11;
    const depth = ctx.createGain();
    depth.gain.value = 260;
    flutter.connect(depth);
    depth.connect(band.frequency);
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.brown;
    rumble.loop = true;
    const under = ctx.createGain();
    under.gain.value = 0.9;
    src.connect(band);
    band.connect(gain);
    rumble.connect(under);
    under.connect(gain);
    gain.connect(this.sfx);
    src.start();
    rumble.start();
    flutter.start();
    return { gain };
  }

  /* ─────────────────────────────────────────────────── what just happened ─── */

  /** A new run: the tune starts over, from the drop. */
  runStart(): void {
    this.section = 'intro';
    this.level = 0;
    this.step = 0;
    this.flameHold = 0;
    this.beatIn = 0;
  }

  shot(weapon: string): void {
    if (!this.live) return;
    const v = rnd(0.94, 1.06);   // no two shots alike
    switch (weapon) {
      case 'smg':
        if (!this.gate('shot', 40)) return;
        this.noise({ dur: 0.07, gain: 0.3, type: 'bandpass', f: 2600 * v, to: 900, q: 0.8, wet: 0.08 });
        this.tone({ wave: 'triangle', f: 330 * v, to: 90, dur: 0.06, gain: 0.34 });
        if (Math.random() < 0.3) this.casing();
        break;
      case 'shotgun':
        this.noise({ dur: 0.34, gain: 0.55, f: 3200, to: 260, wet: 0.22, dest: this.crunch });
        this.tone({ wave: 'sine', f: 130, to: 38, dur: 0.24, gain: 0.6 });
        this.noise({ dur: 0.02, gain: 0.4, type: 'highpass', f: 5000 });
        // The pump: back, and forth.
        this.noise({ at: 0.24, dur: 0.045, gain: 0.16, type: 'bandpass', f: 1500, q: 3 });
        this.noise({ at: 0.36, dur: 0.05, gain: 0.18, type: 'bandpass', f: 2100, q: 3 });
        this.duck(0.25, 0.08);
        break;
      case 'laser':
        this.tone({ wave: 'sawtooth', f: 2300 * v, to: 280, dur: 0.16, gain: 0.17, sweep: 0.8 });
        this.tone({ wave: 'square', f: 1150 * v, to: 140, dur: 0.16, gain: 0.09, sweep: 0.8 });
        this.noise({ dur: 0.05, gain: 0.08, type: 'highpass', f: 6000 });
        break;
      case 'rocket':
        this.noise({ dur: 0.5, gain: 0.34, type: 'bandpass', f: 320, to: 2200, q: 1.2, wet: 0.15 });
        this.noise({ dur: 0.3, gain: 0.4, f: 500, to: 120, brown: true });
        this.tone({ wave: 'sawtooth', f: 90, to: 240, dur: 0.4, gain: 0.13 });
        break;
      case 'flame':
        this.flameHold = 0.13;
        break;
      default:
        if (!this.gate('shot', 40)) return;
        this.noise({ dur: 0.11, gain: 0.38, type: 'bandpass', f: 1900 * v, to: 600, q: 0.7, wet: 0.14 });
        this.tone({ wave: 'triangle', f: 240 * v, to: 62, dur: 0.1, gain: 0.46 });
        this.noise({ dur: 0.012, gain: 0.3, type: 'highpass', f: 4500 });
        if (Math.random() < 0.5) this.casing();
    }
  }

  /** A spent case on the planks, a moment after the shot. */
  private casing(): void {
    if (this.voices > BUSY) return;
    const at = rnd(0.2, 0.34);
    const f = rnd(4200, 5600);
    this.tone({ wave: 'sine', f, dur: 0.05, gain: 0.03, at, pan: rnd(-0.3, 0.3) });
    this.tone({ wave: 'sine', f: f * 1.07, dur: 0.04, gain: 0.018, at: at + 0.07 });
  }

  /** The special weapon is empty: back to the pistol. */
  empty(): void {
    if (!this.live) return;
    this.noise({ dur: 0.02, gain: 0.2, type: 'highpass', f: 3000 });
    this.tone({ wave: 'square', f: 300, to: 170, dur: 0.11, gain: 0.08, at: 0.03 });
  }

  /** A bullet on a robot that is still standing: metal. */
  hit(x: number, y: number, heavy: boolean): void {
    if (!this.live || this.voices > BUSY || !this.gate('hit', 32)) return;
    const { pan, vol } = this.at(x, y);
    const f = rnd(1700, 2600);
    this.tone({ wave: 'sine', f, dur: 0.05, gain: 0.08 * vol, pan });
    this.tone({ wave: 'sine', f: f * 1.48, dur: 0.035, gain: 0.045 * vol, pan });
    this.noise({ dur: 0.02, gain: 0.07 * vol, type: 'highpass', f: 4000, pan });
    if (heavy) this.tone({ wave: 'triangle', f: 320, to: 190, dur: 0.13, gain: 0.12 * vol, pan });
  }

  /** A robot goes down. */
  kill(x: number, y: number, type: string): void {
    if (!this.live) return;
    const { pan, vol } = this.at(x, y);
    if (type === 'boss') {
      this.megaBoom();
      this.tone({ wave: this.pulse25, f: 880, to: 55, dur: 1.3, gain: 0.14, at: 0.1, wet: 0.3 });
      return;
    }
    if (type === 'tank') {
      this.noise({ dur: 0.7, gain: 0.55 * vol, f: 2400, to: 120, dest: this.crunch, wet: 0.3, pan });
      this.tone({ wave: 'sine', f: 100, to: 28, dur: 0.6, gain: 0.65 * vol, pan });
      this.tone({ wave: 'sawtooth', f: 180, to: 55, dur: 0.5, gain: 0.1 * vol, pan });
      this.debris(6, pan, vol);
      this.duck(0.4, 0.12);
      return;
    }
    if (!this.gate('kill', 35)) return;
    const v = rnd(0.9, 1.1);
    if (type === 'drone') {
      this.noise({ dur: 0.16, gain: 0.26 * vol, type: 'bandpass', f: 2600, to: 700, q: 0.9, pan });
      this.tone({ wave: 'square', f: 1250 * v, to: 190, dur: 0.16, gain: 0.07 * vol, pan });
      return;
    }
    this.noise({ dur: 0.28, gain: 0.36 * vol, f: 3500, to: 300, dest: this.crunch, wet: 0.12, pan });
    this.tone({ wave: 'sine', f: 150 * v, to: 45, dur: 0.2, gain: 0.42 * vol, pan });
    // It powers down.
    this.tone({ wave: this.pulse25, f: 700 * v, to: 110, dur: 0.22, gain: 0.06 * vol, pan });
    this.debris(2, pan, vol);
  }

  private debris(count: number, pan: number, vol: number): void {
    if (this.voices > BUSY) return;
    for (let i = 0; i < count; i += 1) {
      this.tone({ wave: 'sine', f: rnd(2400, 5200), dur: 0.035, gain: 0.03 * vol, at: rnd(0.05, 0.4), pan: pan + rnd(-0.2, 0.2) });
    }
  }

  /** A real explosion: a rocket, a bomber, the pilot. */
  boom(x: number, y: number): void {
    if (!this.live) return;
    const { pan, vol } = this.at(x, y);
    this.noise({ dur: 0.012, gain: 0.5 * vol, type: 'highpass', f: 3000, pan });
    this.noise({ dur: 0.6, gain: 0.6 * vol, f: 4200, to: 140, dest: this.crunch, wet: 0.32, pan });
    this.tone({ wave: 'sine', f: 110, to: 30, dur: 0.46, gain: 0.7 * vol, pan });
    // What falls back.
    for (let i = 0; i < 4; i += 1) this.noise({ at: rnd(0.12, 0.5), dur: 0.05, gain: 0.07 * vol, type: 'bandpass', f: rnd(900, 2600), q: 2, pan });
    this.duck(0.38, 0.1);
  }

  /** The bomb, a boss landing, a boss falling: everything shakes. */
  megaBoom(): void {
    if (!this.live) return;
    this.noise({ dur: 0.015, gain: 0.7, type: 'highpass', f: 2500 });
    this.noise({ dur: 1.35, gain: 0.8, f: 6000, to: 90, dest: this.crunch, wet: 0.5 });
    this.tone({ wave: 'sine', f: 150, to: 24, dur: 1.05, gain: 0.95 });
    // The shockwave passing.
    this.noise({ at: 0.05, dur: 0.5, gain: 0.3, type: 'bandpass', f: 220, to: 3200, q: 1.1 });
    this.noise({ dur: 1.6, gain: 0.3, f: 260, to: 60, brown: true });
    this.duck(0.75, 0.4);
  }

  /** A robot fires. */
  foeShot(x: number, y: number): void {
    if (!this.live || this.voices > BUSY || !this.gate('foeShot', 55)) return;
    const { pan, vol } = this.at(x, y);
    this.tone({ wave: 'square', f: rnd(840, 920), to: 430, dur: 0.09, gain: 0.07 * vol, pan });
    this.noise({ dur: 0.03, gain: 0.05 * vol, type: 'highpass', f: 5000, pan });
  }

  /** The boss lets a whole ring go. */
  volley(x: number, y: number): void {
    if (!this.live) return;
    const { pan, vol } = this.at(x, y);
    this.tone({ wave: 'sawtooth', f: 260, to: 980, dur: 0.26, gain: 0.16 * vol, pan, wet: 0.2 });
    this.noise({ dur: 0.22, gain: 0.2 * vol, type: 'bandpass', f: 700, to: 3000, q: 1.3, pan });
  }

  /** A dasher winds up… */
  charge(x: number, y: number): void {
    if (!this.live || !this.gate('charge', 80)) return;
    const { pan, vol } = this.at(x, y);
    this.tone({ wave: 'sawtooth', f: 220, to: 1150, dur: 0.36, gain: 0.08 * vol, pan });
  }

  /** …and goes. */
  rush(x: number, y: number): void {
    if (!this.live || !this.gate('rush', 80)) return;
    const { pan, vol } = this.at(x, y);
    this.noise({ dur: 0.24, gain: 0.2 * vol, type: 'bandpass', f: 600, to: 2600, q: 1.4, pan });
  }

  /** A robot notices the pilot. */
  alert(x: number, y: number): void {
    if (!this.live || this.voices > BUSY || !this.gate('alert', 90)) return;
    const { pan, vol } = this.at(x, y);
    this.tone({ wave: this.pulse12, f: 1180, dur: 0.05, gain: 0.06 * vol, pan });
    this.tone({ wave: this.pulse12, f: 1570, dur: 0.07, gain: 0.06 * vol, pan, at: 0.06 });
  }

  /** A pod on its way down, for `seconds`. */
  podFall(x: number, y: number, seconds: number, boss: boolean): void {
    if (!this.live) return;
    const { pan, vol } = this.at(x, y);
    if (boss) {
      this.tone({ wave: 'sine', f: 1500, to: 180, dur: seconds, gain: 0.1, attack: 0.2 });
      this.noise({ dur: seconds, gain: 0.4, f: 160, to: 700, brown: true, attack: seconds * 0.8 });
      return;
    }
    if (this.voices > BUSY || !this.gate('pod', 120)) return;
    this.tone({ wave: 'sine', f: rnd(2000, 2400), to: 520, dur: seconds, gain: 0.04 * vol, attack: 0.08, pan });
  }

  podLand(x: number, y: number, boss: boolean): void {
    if (!this.live) return;
    if (boss) { this.megaBoom(); return; }
    if (!this.gate('land', 60)) return;
    const { pan, vol } = this.at(x, y);
    this.tone({ wave: 'sine', f: 120, to: 50, dur: 0.13, gain: 0.3 * vol, pan });
    this.noise({ dur: 0.1, gain: 0.16 * vol, f: 900, pan });
  }

  /** The pilot's boots hit the deck. */
  land(): void {
    if (!this.live) return;
    this.noise({ dur: 0.1, gain: 0.34, f: 650 });
    this.tone({ wave: 'sine', f: 110, to: 52, dur: 0.13, gain: 0.36 });
  }

  /** A crate comes down on its parachute. */
  crate(x: number, y: number): void {
    if (!this.live) return;
    const { pan, vol } = this.at(x, y);
    this.tone({ wave: 'triangle', f: 180, to: 88, dur: 0.11, gain: 0.3 * vol, pan });
    this.noise({ dur: 0.08, gain: 0.22 * vol, f: 720, pan });
  }

  pickup(kind: string): void {
    if (!this.live) return;
    if (kind === 'med') {
      [72, 76, 79, 84].forEach((m, i) => this.tone({ wave: 'triangle', f: midi(m), dur: i === 3 ? 0.28 : 0.09, gain: 0.16, at: i * 0.065, wet: 0.2 }));
    } else if (kind === 'shield') {
      this.tone({ wave: 'sine', f: 400, to: 1600, dur: 0.36, gain: 0.14, wet: 0.3 });
      this.tone({ wave: 'sine', f: 800, to: 3200, dur: 0.36, gain: 0.06, wet: 0.3 });
      this.noise({ dur: 0.3, gain: 0.05, type: 'highpass', f: 6500 });
    } else if (kind === 'bomb') {
      this.tone({ wave: 'square', f: 180, dur: 0.08, gain: 0.16 });
      this.tone({ wave: 'square', f: 240, dur: 0.12, gain: 0.16, at: 0.09 });
    } else if (kind === 'x2') {
      this.tone({ wave: this.pulse25, f: midi(83), dur: 0.07, gain: 0.13 });
      this.tone({ wave: this.pulse25, f: midi(88), dur: 0.32, gain: 0.13, at: 0.07, wet: 0.25 });
    } else {
      // A weapon: racked, ready.
      this.noise({ dur: 0.05, gain: 0.28, type: 'bandpass', f: 1200, q: 4 });
      this.noise({ dur: 0.06, gain: 0.32, type: 'bandpass', f: 2000, q: 4, at: 0.1 });
      this.tone({ wave: this.pulse25, f: 440, to: 880, dur: 0.11, gain: 0.09, at: 0.17 });
    }
  }

  hurt(): void {
    if (!this.live) return;
    this.noise({ dur: 0.17, gain: 0.55, f: 520 });
    this.tone({ wave: 'sawtooth', f: 320, to: 70, dur: 0.3, gain: 0.34, dest: this.crunch });
    this.duck(0.5, 0.16);
  }

  shieldHit(): void {
    if (!this.live) return;
    this.tone({ wave: 'sine', f: 1300, dur: 0.24, gain: 0.18, wet: 0.3 });
    this.tone({ wave: 'sine', f: 1960, dur: 0.18, gain: 0.11, wet: 0.3 });
    this.noise({ dur: 0.06, gain: 0.09, type: 'highpass', f: 5000 });
  }

  dash(): void {
    if (!this.live) return;
    this.noise({ dur: 0.17, gain: 0.22, type: 'bandpass', f: 700, to: 3600, q: 1.4 });
    this.tone({ wave: 'sine', f: 500, to: 1400, dur: 0.12, gain: 0.04 });
  }

  /** The multiplier climbs: so does the blip. */
  combo(mult: number): void {
    if (!this.live) return;
    const f = midi(72 + Math.min(8, mult) * 2);
    this.tone({ wave: this.pulse25, f, dur: 0.07, gain: 0.1 });
    this.tone({ wave: this.pulse25, f: f * 1.5, dur: 0.14, gain: 0.1, at: 0.065 });
  }

  waveStart(boss: boolean): void {
    if (!this.live) return;
    if (boss) {
      // A klaxon: something big is coming.
      for (let i = 0; i < 3; i += 1) {
        this.tone({ wave: 'sawtooth', f: 466, dur: 0.24, gain: 0.16, at: i * 0.5, dest: this.crunch, wet: 0.2 });
        this.tone({ wave: 'sawtooth', f: 370, dur: 0.24, gain: 0.16, at: i * 0.5 + 0.25, dest: this.crunch, wet: 0.2 });
      }
      return;
    }
    [69, 72, 76, 81].forEach((m, i) => this.tone({ wave: this.pulse25, f: midi(m), dur: i === 3 ? 0.3 : 0.09, gain: 0.13, at: i * 0.09, wet: 0.2 }));
    this.noise({ dur: 0.3, gain: 0.08, type: 'highpass', f: 7000, at: 0.27 });
  }

  waveClear(): void {
    if (!this.live) return;
    [72, 76, 79, 84, 88].forEach((m, i) => this.tone({ wave: this.pulse25, f: midi(m), dur: i === 4 ? 0.5 : 0.1, gain: 0.13, at: i * 0.085, wet: 0.3, vibrato: i === 4 ? 9 : 0 }));
    this.tone({ wave: 'triangle', f: midi(48), dur: 0.7, gain: 0.2, at: 0.34 });
    this.noise({ dur: 0.6, gain: 0.1, type: 'highpass', f: 6500, at: 0.34 });
  }

  /** The run is over: the fight's tune stops, its last word depends on the score. */
  over(record: boolean): void {
    if (!this.live) return;
    this.tone({ wave: 'sine', f: 90, to: 28, dur: 0.9, gain: 0.5 });
    const notes = record ? [69, 73, 76, 81, 85, 88] : [69, 67, 65, 64, 57];
    notes.forEach((m, i) => {
      const last = i === notes.length - 1;
      this.tone({
        wave: record ? this.pulse25 : 'sawtooth', f: midi(m), dur: last ? 0.9 : record ? 0.11 : 0.24, gain: record ? 0.14 : 0.11,
        at: 0.25 + i * (record ? 0.1 : 0.22), wet: 0.35, vibrato: last ? 10 : 0,
      });
    });
  }

  /* ──────────────────────────────────────────── the vehicles (game/tps) ─── */

  /** One round of the plane's cannon. */
  cannon(): void {
    if (!this.live || !this.gate('cannon', 52)) return;
    const v = rnd(0.94, 1.06);
    this.noise({ dur: 0.07, gain: 0.3, type: 'bandpass', f: 2100 * v, to: 700, q: 0.8, wet: 0.1 });
    this.tone({ wave: 'triangle', f: 210 * v, to: 64, dur: 0.075, gain: 0.42 });
    this.noise({ dur: 0.01, gain: 0.22, type: 'highpass', f: 5000 });
  }

  /** The tank's gun: one heavy round. */
  shell(): void {
    if (!this.live || !this.gate('shell', 120)) return;
    const v = rnd(0.95, 1.05);
    this.noise({ dur: 0.34, gain: 0.5, f: 2400 * v, to: 160, wet: 0.2 });
    this.tone({ wave: 'sine', f: 150 * v, to: 38, dur: 0.3, gain: 0.6 });
    this.tone({ wave: 'sawtooth', f: 320 * v, to: 70, dur: 0.12, gain: 0.22, dest: this.crunch });
    this.noise({ dur: 0.012, gain: 0.3, type: 'highpass', f: 4500 });
    this.duck(0.25, 0.08);
  }

  /**
   * The machine turns into another shape: servos wind up, plates clack home
   * one after the other, and it settles on a chord that is the new shape's.
   */
  morph(to: 'plane' | 'boat' | 'tank'): void {
    if (!this.live) return;
    // The servos: two whines a fifth apart, rising.
    this.tone({ wave: 'sawtooth', f: 140, to: 620, dur: 0.95, gain: 0.09, wet: 0.2 });
    this.tone({ wave: this.pulse25, f: 210, to: 930, dur: 0.95, gain: 0.05, wet: 0.2 });
    this.noise({ dur: 1.0, gain: 0.16, type: 'bandpass', f: 500, to: 3600, q: 2.2, wet: 0.15 });
    // The plates, seating: nose to tail.
    for (let i = 0; i < 7; i += 1) {
      const at = 0.16 + i * 0.125 + rnd(-0.02, 0.02);
      const pan = rnd(-0.5, 0.5);
      this.noise({ at, dur: 0.05, gain: 0.26, type: 'bandpass', f: rnd(1700, 3200), q: 3.5, pan, dest: this.crunch });
      this.tone({ at, wave: 'square', f: rnd(260, 420), to: 120, dur: 0.05, gain: 0.12, pan });
    }
    // Locked: a thump, and the shape's own chord (the air is brighter than the ground).
    const root = to === 'plane' ? 392 : to === 'boat' ? 294 : 220;
    const at = MORPH_LOCK;
    this.tone({ at, wave: 'sine', f: 130, to: 44, dur: 0.3, gain: 0.5 });
    this.noise({ at, dur: 0.16, gain: 0.28, f: 2800, to: 400, dest: this.crunch });
    for (const [k, gain] of [[1, 0.12], [1.5, 0.09], [2, 0.07]] as const) {
      this.tone({ at: at + 0.01, wave: this.pulse25, f: root * k, dur: 0.5, gain, wet: 0.3, vibrato: 6 });
    }
    this.duck(0.3, 0.3);
  }

  /** The guns are too hot to fire. */
  jam(): void {
    if (!this.live) return;
    this.tone({ wave: 'square', f: 520, to: 180, dur: 0.22, gain: 0.1 });
    this.noise({ dur: 0.5, gain: 0.12, type: 'highpass', f: 4200, to: 9000 });
  }

  /** A missile leaves the rack. */
  missile(): void {
    if (!this.live) return;
    this.noise({ dur: 0.75, gain: 0.4, type: 'bandpass', f: 380, to: 2800, q: 1.1, wet: 0.2 });
    this.noise({ dur: 0.3, gain: 0.34, f: 600, to: 150, brown: true });
    this.tone({ wave: 'sawtooth', f: 110, to: 320, dur: 0.5, gain: 0.12 });
    this.duck(0.2, 0.08);
  }

  /** A robot's missile is on its way. */
  foeMissile(x: number, y: number): void {
    if (!this.live) return;
    const { pan, vol } = this.at(x, y);
    this.noise({ dur: 0.6, gain: 0.26 * vol, type: 'bandpass', f: 300, to: 1800, q: 1.2, pan });
    this.tone({ wave: 'square', f: 880, dur: 0.07, gain: 0.1 });
    this.tone({ wave: 'square', f: 880, dur: 0.07, gain: 0.1, at: 0.12 });
  }

  /** The lock closes on its target: the blips come faster and higher. */
  lockTick(k: number): void {
    if (!this.live) return;
    this.tone({ wave: this.pulse12, f: 880 + 520 * k, dur: 0.035, gain: 0.06 });
  }

  locked(): void {
    if (!this.live) return;
    this.tone({ wave: this.pulse25, f: 1568, dur: 0.3, gain: 0.1 });
    this.tone({ wave: this.pulse25, f: 2093, dur: 0.3, gain: 0.07, at: 0.03 });
  }

  /** The cockpit shouts: stall, the ground. */
  alarm(): void {
    if (!this.live) return;
    this.tone({ wave: 'square', f: 640, dur: 0.11, gain: 0.09 });
    this.tone({ wave: 'square', f: 480, dur: 0.11, gain: 0.09, at: 0.13 });
  }

  /** A barrel roll: the air tears past. */
  roll(): void {
    if (!this.live) return;
    this.noise({ dur: 0.34, gain: 0.26, type: 'bandpass', f: 500, to: 3200, q: 1.2 });
    this.noise({ dur: 0.34, gain: 0.22, type: 'bandpass', f: 3000, to: 600, q: 1.2, at: 0.28 });
  }

  /** The plane meets the sea, or something harder. */
  crash(sea: boolean): void {
    if (!this.live) return;
    if (sea) {
      this.noise({ dur: 0.7, gain: 0.5, f: 2600, to: 300, wet: 0.2 });
      this.tone({ wave: 'sine', f: 120, to: 40, dur: 0.3, gain: 0.5 });
    } else {
      this.noise({ dur: 0.4, gain: 0.5, f: 3600, to: 200, dest: this.crunch, wet: 0.2 });
      this.tone({ wave: 'sawtooth', f: 260, to: 60, dur: 0.3, gain: 0.3, dest: this.crunch });
      this.debris(5, 0, 1);
    }
    this.duck(0.5, 0.15);
  }

  /* ──────────────────────────────────────────────────────── the tune ─── */

  /** Which part of the tune the scene calls for, and how full. */
  private plan(): void {
    const s = this.scene;
    let section: Section = 'main';
    let level = 2;
    if (s.phase === 'over') { section = 'over'; level = 0; }
    else if (s.phase === 'intro') { section = 'intro'; level = 0; }
    else if (s.boss) { section = 'boss'; level = 3; }
    else if (s.phase === 'clear' || s.wave <= 1) level = 1;
    else if (s.wave >= 6 || s.foes >= 16) level = 3;
    if (section !== this.section) this.step = 0;
    this.section = section;
    this.level = level;
    // In a vehicle the tune is played a tone higher, and a little faster.
    this.lift = s.engine && section !== 'over' ? 2 : 0;
    this.bpm = 132 + Math.min(12, Math.max(0, s.wave - 1)) * 1.5 + (section === 'boss' ? 8 : section === 'over' ? -44 : 0) + (this.lift ? 6 : 0);
    if (this.echoDelay && this.ctx) this.echoDelay.delayTime.setTargetAtTime((60 / this.bpm / 4) * 3, this.ctx.currentTime, 0.05);
  }

  private tick = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (this.mode !== 'all') { this.nextAt = ctx.currentTime + 0.06; return; }
    // A long stall (a breakpoint, a frozen tab): pick the beat up from now.
    if (this.nextAt < ctx.currentTime - 0.3) this.nextAt = ctx.currentTime + 0.05;
    while (this.nextAt < ctx.currentTime + 0.14) {
      if (this.step % 16 === 0) this.plan();
      this.playStep(this.step, this.nextAt);
      this.nextAt += 60 / this.bpm / 4;
      this.step = (this.step + 1) % 128;
    }
  };

  private playStep(step: number, when: number): void {
    const bar = Math.floor(step / 16) % 8;
    const s = step % 16;
    const sec = this.section;
    const lv = this.level;
    const six = 60 / this.bpm / 4;
    const lift = this.lift;
    const [root0, tones0] = CHORDS[sec][bar];
    const root = root0 + lift;
    const tones: [number, number, number] = [tones0[0] + lift, tones0[1] + lift, tones0[2] + lift];
    const m = this.music;

    if (sec === 'over') {
      // After the fight: the chords, slowly, and nothing else.
      if (s === 0) this.pad(tones, when, six * 16);
      if (s % 4 === 0) this.tone({ wave: this.pulse12, f: midi(tones[(s / 4) % 3] + 12), when, dur: six * 3.5, gain: 0.16, dest: this.echo, pan: -0.2 });
      if (s === 0 || s === 8) this.tone({ wave: 'triangle', f: midi(root), when, dur: six * 7, gain: 0.3, dest: m });
      return;
    }

    /* drums */
    if (sec === 'intro') {
      // The drop: a pulse and a tick, nothing settled yet.
      if (s === 0 || s === 10) this.kick(when, 0.6);
      if (s % 4 === 2) this.hat(when, 0.1, false);
    } else {
      if (s % 4 === 0 || (lv >= 2 && s === 10 && bar % 2 === 1)) this.kick(when, 0.75);
      if (lv >= 2 && (s === 4 || s === 12)) this.snare(when, 0.45);
      // The last bar of the heat rolls into the next.
      if (lv >= 3 && bar === 7 && s >= 12) this.snare(when, 0.3 + (s - 12) * 0.07);
      if (lv >= 3) {
        if (s % 4 === 2) this.hat(when, 0.16, true);
        else this.hat(when, s % 2 ? 0.07 : 0.12, false);
      } else if (s % 2 === 0) this.hat(when, s % 4 === 2 ? 0.15 : 0.08, false);
    }

    /* bass */
    if (sec === 'intro') {
      if (s === 0) this.tone({ wave: 'sawtooth', f: midi(root - 12), when, dur: six * 16, gain: 0.16, attack: 0.4, dest: m });
    } else {
      const off = BASS[sec][s];
      if (off != null) this.bass(midi(root + off), when, six * (BASS[sec][(s + 1) % 16] == null ? 1.8 : 0.9));
    }

    /* arpeggio */
    const every = sec === 'intro' || lv <= 1 ? 2 : 1;
    if (s % every === 0) {
      const idx = ARP[s];
      const note = (idx === 3 ? tones[0] + 12 : tones[idx]) + 12 + (lv >= 3 && s % 4 === 3 ? 12 : 0);
      this.tone({ wave: this.pulse12, f: midi(note), when, dur: six * 0.85, gain: sec === 'intro' ? 0.11 : 0.14, dest: this.echo, pan: -0.25 });
      this.tone({ wave: this.pulse12, f: midi(note), when, dur: six * 0.85, gain: sec === 'intro' ? 0.09 : 0.13, dest: m, pan: -0.25 });
    }

    /* pad: the calm passages are held together by it */
    if (lv <= 1 && s === 0) this.pad(tones, when, six * 16);

    /* melody */
    if (sec !== 'intro' && (lv >= 2 || sec === 'boss')) {
      const hit = LEAD_AT[sec].get(bar * 16 + s);
      if (hit) {
        const note = hit[0] + lift;
        const len = hit[1];
        const dur = six * len * 0.92;
        this.tone({ wave: this.pulse25, f: midi(note), when, dur, gain: 0.25, attack: 0.008, dest: m, vibrato: len >= 4 ? 8 : 0 });
        this.tone({ wave: this.pulse25, f: midi(note), when, dur, gain: 0.12, dest: this.echo });
        // The heat doubles it an octave down.
        if (lv >= 3) this.tone({ wave: 'sawtooth', f: midi(note - 12), when, dur, gain: 0.07, dest: m, pan: 0.25 });
      }
    }
  }

  private kick(when: number, gain: number): void {
    this.tone({ wave: 'sine', f: 150, to: 42, when, dur: 0.17, gain, sweep: 0.6, dest: this.music });
    this.noise({ when, dur: 0.012, gain: gain * 0.25, type: 'highpass', f: 3000, dest: this.music });
  }

  private snare(when: number, gain: number): void {
    this.noise({ when, dur: 0.15, gain, type: 'bandpass', f: 1900, q: 0.7, dest: this.music });
    this.tone({ wave: 'triangle', f: 195, to: 140, when, dur: 0.08, gain: gain * 0.6, dest: this.music });
  }

  private hat(when: number, gain: number, open: boolean): void {
    this.noise({ when, dur: open ? 0.18 : 0.035, gain, type: 'highpass', f: 7200, dest: this.music, pan: 0.2 });
  }

  /** A saw under a filter that closes: the note has a pluck to it. */
  private bass(f: number, when: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, when);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 5;
    filter.frequency.setValueAtTime(1100, when);
    filter.frequency.exponentialRampToValueAtTime(220, when + dur);
    const g = ctx.createGain();
    this.env(g.gain, when, 0.45, 0.004, dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(this.music);
    osc.start(when);
    osc.stop(when + dur + 0.03);
  }

  private pad(tones: [number, number, number], when: number, dur: number): void {
    tones.forEach((note, i) => {
      this.tone({ wave: 'triangle', f: midi(note), when, dur, gain: 0.12, attack: 0.25, dest: this.music, pan: (i - 1) * 0.4 });
      this.tone({ wave: 'sine', f: midi(note) * 1.004, when, dur, gain: 0.07, attack: 0.3, dest: this.music, pan: (1 - i) * 0.4 });
    });
  }
}

/** A pulse wave of the given duty: the narrow, nasal squares of old sound chips. */
function pulseWave(ctx: AudioContext, duty: number): PeriodicWave {
  const n = 32;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k += 1) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}
