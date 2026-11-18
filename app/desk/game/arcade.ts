// The mini-game: a keyboard arena shooter played on the island on stage.
//
// A pilot is dropped by helicopter; the island's robots turn on them, then
// more land by pod, wave after wave, stronger each time. It is a TOY: it
// plays with copies of the board's sprites and never reads or writes a
// session — nothing here can reach Charon. The engine (game.ts) swaps its own
// drawing for this one while a run lasts and gives the board back after.
//
// After the third wave the SAME fight is seen from behind the pilot, in 3D
// (game/tps, loaded on demand): this file still runs it, on the board's
// plane, in board pixels — only the eye moved, and the keys follow it (the
// mouse turns the pilot). A wave later two vehicles come to the island; the
// pilot who boards one leaves this fight for good, for the one tps/combat.ts
// runs. The run — score, combo, waves, record, sound — stays here throughout.
// Where the 3D phase cannot load, or without WebGL, everything stays in 2D.
//
//   move   WASD / ZQSD            dash  Shift
//   fire   arrows (8 ways), or Space to shoot at the nearest robot
//   bomb   E          pause  P          sound  M          leave  Esc
import {
  T, arcadeArt, art, drawRobot, makeCanvas,
  type PickupKind, type RobotArt, type RobotKind, type RobotPose,
} from './art';
import type { Island, World } from './layout';
import { glow } from './scenery';
import type { ArcadeHud, ArcadePhase } from '../arcadeStore';
import { ArcadeAudio, type AudioScene } from './audio';
import type { GroundPort, GroundScene, Tps, TpsRun } from './tps';

export type ArcadeHost = {
  island: Island;
  /** The board's whole layout, and the element its stage is drawn in: the flight phase raises one in the other. */
  world: World;
  stage: HTMLElement;
  /** The board's own view, for the 3D phase to start from: its centre (board pixels) and its zoom. */
  view: () => { x: number; y: number; zoom: number };
  /** Capture the mouse (it turns the view), or let it go. */
  capture: (on: boolean) => void;
  /** Where the run starts: on the island in 2D, or in 3D with the vehicles there (a checkpoint, a test). */
  from?: 'ground' | 'tps';
  /** The island's own robots: they open the first wave from where they stand. */
  robots: Array<{ kind: RobotKind; x: number; y: number }>;
  best: number;
  /** Rising text on the board (the engine's own floats). */
  float: (x: number, y: number, text: string, colour: string, size: 'small' | 'big') => void;
  shake: (ms: number, px: number) => void;
  /** A new record, to keep. */
  saveBest: (score: number) => void;
  quit: () => void;
};

type WeaponId = 'pistol' | 'smg' | 'shotgun' | 'laser' | 'rocket' | 'flame';

const WEAPONS: Record<WeaponId, { name: string; rate: number; ammo: number; colour: string }> = {
  pistol: { name: 'PISTOL', rate: 4.2, ammo: Infinity, colour: '#e8eef9' },
  smg: { name: 'SMG', rate: 13, ammo: 160, colour: '#ffe066' },
  shotgun: { name: 'SHOTGUN', rate: 1.7, ammo: 26, colour: '#ffb86b' },
  laser: { name: 'LASER', rate: 6.5, ammo: 70, colour: '#7cc4ff' },
  rocket: { name: 'ROCKETS', rate: 1.3, ammo: 14, colour: '#ff8fb3' },
  flame: { name: 'FLAMER', rate: 26, ammo: 320, colour: '#ff8a2a' },
};

type FoeType = 'grunt' | 'gunner' | 'dasher' | 'drone' | 'bomber' | 'tank' | 'boss';

/** `from`: the first wave it shows up in; `cost`: what it takes from a wave's budget. */
const FOES: Record<FoeType, {
  art: RobotKind | 'drone'; hp: number; speed: number; r: number; score: number; cost: number; from: number;
  scale: number; fly?: boolean; weight: number; tint?: string;
}> = {
  grunt: { art: 'claude', hp: 2, speed: 35, r: 6, score: 10, cost: 1, from: 1, scale: 1, weight: 5 },
  drone: { art: 'drone', hp: 1, speed: 62, r: 4, score: 5, cost: 0.5, from: 2, scale: 2, fly: true, weight: 4 },
  gunner: { art: 'codex', hp: 3, speed: 25, r: 6, score: 25, cost: 2, from: 2, scale: 1, weight: 3 },
  dasher: { art: 'cursor', hp: 2, speed: 28, r: 6, score: 30, cost: 2, from: 2, scale: 1, weight: 3 },
  bomber: { art: 'claude', hp: 2, speed: 54, r: 6, score: 20, cost: 2, from: 3, scale: 1, weight: 2, tint: '#ff3b3b' },
  tank: { art: 'codex', hp: 26, speed: 15, r: 12, score: 150, cost: 7, from: 5, scale: 2, weight: 1 },
  boss: { art: 'cursor', hp: 200, speed: 19, r: 18, score: 1500, cost: 0, from: 5, scale: 3, weight: 0 },
};

/** What each of the island's own robots fights as, by the sprite it wears. */
const FOE_OF_ROBOT: Record<RobotKind, FoeType> = { claude: 'grunt', codex: 'gunner', cursor: 'dasher' };

type Foe = {
  type: FoeType; x: number; y: number; hp: number; maxHp: number; speed: number;
  /** Seconds before it joins the fight (the island's robots wake one by one). */
  sleep: number;
  flash: number; seed: number; t: number; state: number; dx: number; dy: number; shotAt: number;
};

type Shot = {
  x: number; y: number; vx: number; vy: number; life: number; dmg: number; r: number;
  kind: 'bullet' | 'laser' | 'rocket' | 'flame' | 'foe';
  /** How many more robots it goes through. */
  pierce: number; colour: string; hit: Set<Foe> | null;
};

type Spark = { x: number; y: number; vx: number; vy: number; g: number; life: number; max: number; colour: string; size: number };
type Blast = { x: number; y: number; t: number; max: number; r: number; colour: string };
type Pod = { x: number; y: number; t: number; max: number; type: FoeType };
type Pickup = { x: number; y: number; kind: PickupKind; age: number; fall: number };
type Queued = { at: number; type: FoeType };

/** The wave after which the fight is seen in 3D; the vehicles come one wave later. */
const TPS_AFTER = 3;
const CHECKPOINT_KEY = 'desk.arcade.tps';

/** The vehicles have been reached once in this browser: a run may start from there again. */
export function readCheckpoint(): boolean {
  try { return localStorage.getItem(CHECKPOINT_KEY) === '1'; } catch { return false; }
}

/** A boss comes every fifth wave, the first one at wave 7 — a few waves into the vehicles. */
const bossWave = (n: number): boolean => n >= 7 && (n - 2) % 5 === 0;

const PLAYER_SPEED = 64;
const PLAYER_R = 5;
const MAX_FOES = 70;
const PICKUP_LIFE = 14;

export class Arcade {
  private host: ArcadeHost;
  private island: Island;
  private ox: number; private oy: number;
  private scratch = makeCanvas(16, 20);
  private sg = this.scratch.getContext('2d')!;

  private phase: ArcadePhase = 'intro';
  private phaseT = 0;
  private paused = false;
  private clock = 0;
  private wave = 0;
  private score = 0;
  private best: number;
  private record = false;
  private banner = '';
  private bannerAt = 0;

  private px: number; private py: number;
  private landX: number; private landY: number;
  private landed = false;
  private hp = 5; private maxHp = 5;
  private shield = 0;
  private invul = 0;
  private aimX = 0; private aimY = 1;
  private weapon: WeaponId = 'pistol';
  private ammo = Infinity;
  private cool = 0;
  private flashT = 0;
  private bombs = 1;
  private dashT = 0; private dashCool = 0; private dashX = 0; private dashY = 0;
  private stride = 0;
  private combo = 0; private comboT = 0; private doubleT = 0;

  private foes: Foe[] = [];
  private shots: Shot[] = [];
  private sparks: Spark[] = [];
  private blasts: Blast[] = [];
  private pods: Pod[] = [];
  private pickups: Pickup[] = [];
  private queue: Queued[] = [];
  /** How many robots the wave under way brings in all. */
  private waveSize = 0;
  private waveT = 0;
  private heli: { x: number; y: number; fromX: number; fromY: number; toX: number; toY: number; t: number; max: number; drop: PickupKind | null; dropped: boolean } | null = null;
  private keys = new Set<string>();
  // Its music and effects (game/audio.ts). Built here: a run starts on a key
  // or a click, the gesture a browser wants before any sound.
  private audio = new ArcadeAudio();

  // The 3D phase: its code once it has arrived, the phase itself once entered.
  private tpsModule: typeof import('./tps') | null = null;
  private tpsFailed = false;
  private tps: Tps | null = null;
  private tpsAt = 0;
  /** A run that starts in 3D waits for that code. */
  private tpsWanted = false;
  /** The pilot is in a vehicle: the fight on foot is over. */
  private aboard = false;
  private checkpoint = readCheckpoint();

  constructor(host: ArcadeHost) {
    this.host = host;
    void import('./tps').then((m) => { this.tpsModule = m; }, () => { this.tpsFailed = true; });
    this.island = host.island;
    this.ox = host.island.tx * T;
    this.oy = host.island.ty * T;
    this.best = host.best;
    const land = this.nearestLand(this.ox + (this.island.tw * T) / 2, this.oy + (this.island.th * T) / 2);
    this.landX = land.x; this.landY = land.y;
    this.px = land.x; this.py = land.y;
    this.startRun(host.from ?? 'ground');
  }

  /** The run is over for good: the sound goes with it. */
  dispose(): void {
    this.leaveTps();
    this.audio.dispose();
  }

  private leaveTps(): void {
    this.tps?.dispose();
    this.tps = null;
    this.aboard = false;
    this.tpsWanted = false;
    this.host.capture(false);
  }

  /** The fight is on the 3D stage, not on the board. */
  get staged(): boolean {
    return this.tps != null;
  }

  /** The 3D stage has just come up: the board is still fading under it. */
  get stageFresh(): boolean {
    return this.tps != null && this.clock - this.tpsAt < 0.7;
  }

  drawStage(): void {
    this.tps?.draw();
  }

  /** The 3D phase's state, for a test to play by; null in 2D. */
  probe(): ReturnType<Tps['probe']> | null {
    return this.tps ? this.tps.probe() : null;
  }

  /** The mouse: where it is on the stage, how far it went, whether it is captured. */
  pointer(type: 'move' | 'down' | 'up', x: number, y: number, button: number, dx = 0, dy = 0, locked = false): void {
    if (!this.tps || this.paused || this.phase === 'over') return;
    // A click on the stage captures the mouse: it then turns the view.
    if (type === 'down' && !locked) this.host.capture(true);
    this.tps.pointer(type, x, y, button, dx, dy, locked);
  }

  /** The mouse was captured, or let go (Esc). */
  locked(on: boolean): void {
    this.tps?.setLocked(on);
  }

  /** The window lost the keyboard: nothing is held any more. */
  release(): void {
    this.keys.clear();
    this.tps?.release();
  }

  /** How loud the game is right now — for a test, never for the game. */
  audioLevel(): { peak: number; rms: number } {
    return this.audio.loudness();
  }

  /* ─────────────────────────────────────────────────────────── a run ─── */

  private startRun(from: 'ground' | 'tps' = 'ground'): void {
    this.leaveTps();
    this.audio.runStart();
    this.phase = 'intro'; this.phaseT = 0; this.clock = 0; this.wave = 0; this.score = 0; this.record = false;
    this.hp = this.maxHp; this.shield = 0; this.invul = 0; this.weapon = 'pistol'; this.ammo = Infinity; this.bombs = 1;
    this.combo = 0; this.comboT = 0; this.doubleT = 0; this.cool = 0; this.landed = false;
    this.foes = []; this.shots = []; this.sparks = []; this.blasts = []; this.pods = []; this.pickups = []; this.queue = [];
    this.px = this.landX; this.py = this.landY; this.aimX = 0; this.aimY = 1;
    if (from === 'tps') {
      // Straight to where the vehicles wait: the first waves are behind.
      this.wave = TPS_AFTER + 1;
      this.heli = null;
      this.landed = true;
      // With what four waves would have left in its hands.
      this.weapon = 'smg'; this.ammo = WEAPONS.smg.ammo; this.bombs = 2;
      this.aimY = -1;
      this.phase = 'clear';
      this.tpsWanted = true;
      return;
    }
    // The island's robots stand where they were, unaware, until the pilot lands.
    for (const r of this.host.robots.slice(0, 26)) {
      const type = FOE_OF_ROBOT[r.kind];
      const at = this.nearestLand(r.x, r.y);
      this.foes.push(this.makeFoe(type, at.x, at.y, 1, 99));
    }
    this.flyHeli(this.landX - 260, this.landY - 170, this.landX, this.landY - 46, 1.5, null);
    this.say('GET READY');
  }

  /**
   * The fight goes to the 3D stage: the eye swings from the board's view to
   * behind the pilot (`swing`), or starts there. Where it cannot (no code, no
   * WebGL), nothing changes: the run stays on the board.
   */
  private enterTps(swing: boolean): boolean {
    if (this.tps || this.tpsFailed || !this.tpsModule) return false;
    try {
      // Facing up the board, as the 2D view shows it: the keys keep their sense.
      this.tps = new this.tpsModule.Tps(this.host.stage, this.host.world, this.island.vpsId, this.run(), this.port(), {
        from: swing ? this.host.view() : null, yaw: Math.PI,
      });
    } catch {
      this.tpsFailed = true;
      this.tps = null;
      return false;
    }
    this.tpsAt = this.clock;
    this.aimX = 0; this.aimY = -1;
    return true;
  }

  /** The vehicles come to the island. */
  private deliver(there: boolean): void {
    if (!this.tps) return;
    this.tps.deliver(there);
    if (!there) this.say('VEHICLES READY');
    if (!this.checkpoint) {
      this.checkpoint = true;
      try { localStorage.setItem(CHECKPOINT_KEY, '1'); } catch { /* private mode */ }
    }
  }

  /** What the 3D phase sees of the fight on foot, and the one thing it may do to it. */
  private port(): GroundPort {
    const pilot: GroundScene['pilot'] = { x: 0, y: 0, aimX: 0, aimY: 1, stride: 0, shown: false, blink: false, shield: 0, hp: 0, gun: '#e8eef9', flash: false };
    return {
      scene: () => {
        pilot.x = this.px; pilot.y = this.py; pilot.aimX = this.aimX; pilot.aimY = this.aimY; pilot.stride = this.stride;
        pilot.shown = this.landed && this.phase !== 'over' && !this.aboard;
        pilot.blink = this.invul > 0 && this.dashT <= 0;
        pilot.shield = this.shield; pilot.hp = this.hp; pilot.gun = WEAPONS[this.weapon].colour; pilot.flash = this.flashT > 0;
        return { clock: this.clock, pilot, foes: this.foes, shots: this.shots, pods: this.pods, pickups: this.pickups, heli: this.heli };
      },
      look: (type) => {
        const def = FOES[type as FoeType] ?? FOES.grunt;
        return { art: def.art, scale: def.scale, fly: !!def.fly, red: !!def.tint };
      },
      nearestLand: (x, y) => this.nearestLand(x, y),
      leave: () => {
        const fighting = this.phase === 'wave';
        const foes = this.foes.filter((f) => f.sleep <= 0).map((f) => ({ type: f.type as string, x: f.x, y: f.y }));
        // What the wave had not sent yet is still owed: the vehicle will meet it.
        const ahead = this.queue.length + this.pods.length;
        const share = this.waveSize > 0 ? Math.min(1, ahead / this.waveSize) : 0;
        const boss = this.queue.some((q) => q.type === 'boss') || this.pods.some((q) => q.type === 'boss');
        this.aboard = true;
        this.keys.clear();
        this.foes = []; this.pods = []; this.queue = []; this.shots = []; this.pickups = []; this.heli = null;
        this.combo = 0; this.comboT = 0;
        return { fighting, foes, share, boss };
      },
    };
  }

  /** What the 3D phase may ask of the run. */
  private run(): TpsRun {
    return {
      audio: this.audio,
      score: (base) => {
        const before = this.mult();
        this.combo += 1;
        // Kills are further apart in a vehicle: the combo waits longer.
        this.comboT = 7;
        if (this.mult() > before) this.audio.combo(this.mult());
        const gain = base * this.mult();
        this.score += gain;
        if (this.score > this.best) { this.best = this.score; this.record = true; }
        return gain;
      },
      hit: () => { this.combo = 0; },
      say: (text) => this.say(text),
      wave: () => this.wave,
      nextWave: () => {
        this.wave += 1;
        this.phase = 'wave'; this.phaseT = 0;
        const boss = bossWave(this.wave);
        this.say(boss ? `WAVE ${this.wave} — BOSS` : `WAVE ${this.wave}`);
        this.audio.waveStart(boss);
        return { n: this.wave, boss };
      },
      cleared: () => {
        this.phase = 'clear'; this.phaseT = 0;
        const bonus = 100 * this.wave;
        this.score += bonus;
        if (this.score > this.best) { this.best = this.score; this.record = true; }
        this.say(`WAVE ${this.wave} CLEARED  +${bonus}`);
        this.audio.waveClear();
      },
      over: () => this.end(),
    };
  }

  /** The run ends: the record is kept, the last word is said. */
  private end(): void {
    this.phase = 'over'; this.phaseT = 0;
    this.keys.clear();
    this.tps?.release();
    this.host.capture(false);
    this.audio.over(this.record);
    if (this.record) this.host.saveBest(this.best);
    this.say(this.record ? 'NEW RECORD' : 'GAME OVER');
  }

  /** The stage shakes: the board's, or the 3D one. */
  private shakeBy(ms: number, px: number): void {
    if (this.tps) this.tps.shake(px / 7);
    else this.host.shake(ms, px);
  }

  /** Rising text where something happened. */
  private floatAt(x: number, y: number, text: string, colour: string, size: 'small' | 'big'): void {
    if (this.tps) this.tps.float(x, y, text, colour);
    else this.host.float(x, y, text, colour, size);
  }

  private say(text: string): void {
    this.banner = text;
    this.bannerAt = performance.now();
  }

  private flyHeli(fromX: number, fromY: number, toX: number, toY: number, seconds: number, drop: PickupKind | null): void {
    this.heli = { x: fromX, y: fromY, fromX, fromY, toX, toY, t: 0, max: seconds, drop, dropped: false };
  }

  private nextWave(): void {
    this.wave += 1;
    this.phase = 'wave'; this.phaseT = 0; this.waveT = 0;
    const n = this.wave;
    const boss = bossWave(n);
    this.say(boss ? `WAVE ${n} — BOSS` : `WAVE ${n}`);
    this.audio.waveStart(boss);
    this.queue = [];
    if (n === 1) {
      // The island's own robots wake one after the other; a small island gets company.
      this.foes.forEach((f, i) => { f.sleep = 0.2 + i * 0.14; });
      for (let i = this.foes.length; i < 8; i += 1) this.queue.push({ at: 1 + i * 0.4, type: 'grunt' });
      this.waveSize = this.foes.length + this.queue.length;
      return;
    }
    // Seen from behind the pilot a crowd hides more than it shows: fewer come at once.
    let budget = (6 + n * 3.4) * (boss ? 0.55 : 1) * (this.tps ? 0.55 : 1);
    const pool = (Object.keys(FOES) as FoeType[]).filter((t) => FOES[t].weight > 0 && FOES[t].from <= n);
    const picked: FoeType[] = [];
    while (budget > 0.4 && picked.length < 60) {
      const fits = pool.filter((t) => FOES[t].cost <= budget + 0.5);
      if (!fits.length) break;
      let roll = Math.random() * fits.reduce((sum, t) => sum + FOES[t].weight, 0);
      let type = fits[0];
      for (const t of fits) { roll -= FOES[t].weight; if (roll <= 0) { type = t; break; } }
      picked.push(type);
      budget -= FOES[type].cost;
    }
    const gap = Math.max(0.5, 1.2 - n * 0.06);
    picked.forEach((type, i) => this.queue.push({ at: 0.6 + Math.floor(i / 4) * gap + (i % 4) * 0.12, type }));
    if (boss) this.queue.push({ at: 1.2, type: 'boss' });
    this.waveSize = this.queue.length;
  }

  private makeFoe(type: FoeType, x: number, y: number, wave: number, sleep = 0): Foe {
    const def = FOES[type];
    const hp = Math.ceil(def.hp * (1 + 0.13 * (wave - 1)) * (type === 'boss' ? 1 + (wave / 5 - 1) * 0.7 : 1));
    return {
      type, x, y, hp, maxHp: hp, speed: def.speed * (1 + Math.min(0.6, 0.035 * (wave - 1))), sleep,
      flash: 0, seed: Math.random() * 1000, t: 0, state: 0, dx: 0, dy: 0, shotAt: 0.6 + Math.random(),
    };
  }

  /* ───────────────────────────────────────────────────────── the keys ─── */

  /** A key went down or up. True: the game used it (the page must not). */
  key(e: KeyboardEvent, down: boolean): boolean {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // On the 3D stage some keys are read by their place on the keyboard (tps/input.ts): they hear everything.
    const staged = this.tps ? this.tps.key(e, down) : false;
    if (down && e.repeat) return staged || GAME_KEYS.has(k);
    if (!down) {
      this.keys.delete(k);
      return staged || GAME_KEYS.has(k);
    }
    if (k === 'Escape') { this.host.quit(); return true; }
    if (k === 'm') { this.audio.cycleMode(); return true; }
    if (this.phase === 'over') {
      if (k === 'Enter' || k === ' ') this.startRun();
      // Once the vehicles have been reached, a run may start from there.
      else if (k === 'c' && this.checkpoint) this.startRun('tps');
      return true;
    }
    if (k === 'p') {
      this.paused = !this.paused;
      this.tps?.release();
      if (this.paused) this.host.capture(false);
      return true;
    }
    if (this.paused) { this.paused = false; return true; }
    // In a vehicle the fight on foot hears nothing.
    if (this.aboard) return staged;
    this.keys.add(k);
    if (k === 'Shift') this.dash();
    else if (k === 'e' || k === 'Enter') this.bomb();
    return staged || GAME_KEYS.has(k);
  }

  private held(...keys: string[]): boolean {
    for (const k of keys) if (this.keys.has(k)) return true;
    return false;
  }

  /* ───────────────────────────────────────────────────────────── step ─── */

  step(dt: number): void {
    // The sound follows the scene every frame, a paused one included.
    this.audio.update(this.paused ? 0 : dt, this.audioScene());
    if (this.paused) return;
    this.clock += dt;
    this.phaseT += dt;
    if (this.tpsWanted) {
      // A run that starts in 3D: as soon as that code is there (or cannot be).
      if (this.tpsFailed) { this.tpsWanted = false; this.wave = 0; this.landed = false; this.startRun(); return; }
      if (!this.tpsModule) { this.phaseT = 0; return; }
      this.tpsWanted = false;
      if (!this.enterTps(false)) { this.startRun(); return; }
      this.deliver(true);
      this.phaseT = 0;
    }
    if (this.aboard) {
      // The fight is the vehicle's; the run keeps its combo's clock.
      if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; }
      this.tps?.step(dt);
      return;
    }
    this.stepGround(dt);
    this.tps?.step(dt);
  }

  /** The fight on foot: the same in 2D and seen in 3D. */
  private stepGround(dt: number): void {
    this.stepHeli(dt);
    this.stepEffects(dt);
    if (this.phase === 'over') return;

    if (this.phase === 'intro') {
      // The pilot slides down the rope once the helicopter hovers.
      if (!this.landed && this.heli && this.heli.t >= this.heli.max + 0.55) {
        this.landed = true;
        this.audio.land();
        this.burst(this.landX, this.landY, '#cfd6e6', 10, 30);
        this.flyHeli(this.heli.x, this.heli.y, this.landX + 300, this.landY - 200, 1.3, null);
        this.nextWave();
      }
      return;
    }

    this.stepPlayer(dt);
    this.stepFoes(dt);
    this.stepShots(dt);
    this.stepPickups(dt);

    if (this.phase === 'wave') {
      this.waveT += dt;
      // Reinforcements land by pod, a few at a time.
      while (this.queue.length && this.queue[0].at <= this.waveT && this.foes.length + this.pods.length < MAX_FOES) {
        const next = this.queue.shift()!;
        const at = this.spawnPoint(next.type);
        const fall = next.type === 'boss' ? 1.6 : 0.85;
        this.pods.push({ x: at.x, y: at.y, t: 0, max: fall, type: next.type });
        this.audio.podFall(at.x, at.y, fall, next.type === 'boss');
      }
      if (!this.queue.length && !this.pods.length && !this.foes.length) {
        this.phase = 'clear'; this.phaseT = 0;
        const bonus = 100 * this.wave;
        this.score += bonus;
        this.say(`WAVE ${this.wave} CLEARED  +${bonus}`);
        this.audio.waveClear();
        // The helicopter comes back with a present.
        const kinds: PickupKind[] = ['smg', 'shotgun', 'laser', 'rocket', 'flame'];
        const drop = this.hp <= 2 && Math.random() < 0.6 ? 'med' : kinds[Math.floor(Math.random() * kinds.length)];
        this.flyHeli(this.px - 280, this.py - 150, this.px + 280, this.py - 150, 2.6, drop);
        // The third wave down, the eye comes down behind the pilot; a wave later, the vehicles come.
        if (this.wave === TPS_AFTER) this.enterTps(true);
        else if (this.wave === TPS_AFTER + 1) this.deliver(false);
      }
    } else if (this.phase === 'clear' && this.phaseT > (this.wave === TPS_AFTER && this.tps ? 3.4 : 2.4)) this.nextWave();
  }

  private stepHeli(dt: number): void {
    const h = this.heli;
    if (!h) return;
    h.t += dt;
    const k = Math.min(1, h.t / h.max);
    const e = k * k * (3 - 2 * k);
    h.x = h.fromX + (h.toX - h.fromX) * e;
    h.y = h.fromY + (h.toY - h.fromY) * e + Math.sin(this.clock * 5) * 1.2;
    if (h.drop && !h.dropped && k >= 0.5) {
      h.dropped = true;
      const at = this.nearestLand(h.x, h.y + 150);
      this.pickups.push({ x: at.x, y: at.y, kind: h.drop, age: 0, fall: 1.3 });
    }
    // Gone once it has left the island (the intro hover keeps it until the drop).
    if (k >= 1 && !(this.phase === 'intro' && !this.landed)) this.heli = null;
  }

  private stepPlayer(dt: number): void {
    this.invul = Math.max(0, this.invul - dt);
    this.cool = Math.max(0, this.cool - dt);
    this.flashT = Math.max(0, this.flashT - dt);
    this.dashCool = Math.max(0, this.dashCool - dt);
    this.doubleT = Math.max(0, this.doubleT - dt);
    if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; }

    // Seen from behind (the 3D stage), the keys follow the eye: forward is where the pilot faces.
    const yaw = this.tps?.afoot ? this.tps.heading() : null;
    let mx = (this.held('d') ? 1 : 0) - (this.held('a', 'q') ? 1 : 0);
    let my = (this.held('s') ? 1 : 0) - (this.held('w', 'z') ? 1 : 0);
    if (yaw != null) {
      const ahead = -my;
      const side = mx;
      mx = Math.sin(yaw) * ahead - Math.cos(yaw) * side;
      my = Math.cos(yaw) * ahead + Math.sin(yaw) * side;
    }
    const len = Math.hypot(mx, my);
    if (len) { mx /= len; my /= len; }
    let speed = PLAYER_SPEED;
    if (this.dashT > 0) {
      this.dashT -= dt;
      mx = this.dashX; my = this.dashY; speed = 215;
      if (this.tps) this.tps.burst(this.px, this.py - 7, '#9fd4ff', 1, 4);
      else if (Math.random() < 0.7) this.sparks.push({ x: this.px, y: this.py - 7, vx: 0, vy: 0, g: 0, life: 0, max: 220, colour: '#9fd4ff', size: 2 });
    }
    if (mx || my) {
      this.stride += dt;
      this.move(mx * speed * dt, my * speed * dt);
      if (this.dashT <= 0) { this.dashX = mx; this.dashY = my; }
    } else this.stride = 0;

    // Aim: the arrows say where; Space picks the nearest robot. From behind the
    // pilot the mouse aims (it turns the pilot) and its button fires; the arrows turn the view.
    const ax = yaw != null ? 0 : (this.held('ArrowRight') ? 1 : 0) - (this.held('ArrowLeft') ? 1 : 0);
    const ay = yaw != null ? 0 : (this.held('ArrowDown') ? 1 : 0) - (this.held('ArrowUp') ? 1 : 0);
    let firing = false;
    if (yaw != null && !this.held(' ')) {
      this.aimX = Math.sin(yaw); this.aimY = Math.cos(yaw);
      firing = this.tps!.trigger;
    } else if (ax || ay) {
      const l = Math.hypot(ax, ay);
      this.aimX = ax / l; this.aimY = ay / l;
      firing = true;
    } else if (this.held(' ')) {
      let near: Foe | null = null;
      let best = Infinity;
      for (const f of this.foes) {
        if (f.sleep > 0) continue;
        const d = (f.x - this.px) ** 2 + (f.y - this.py) ** 2;
        if (d < best) { best = d; near = f; }
      }
      if (near) {
        const dx = near.x - this.px;
        const dy = (near.y - 8 * FOES[near.type].scale) - (this.py - 8);
        const l = Math.hypot(dx, dy) || 1;
        this.aimX = dx / l; this.aimY = dy / l;
      }
      firing = true;
    } else if ((mx || my) && yaw == null) { this.aimX = mx; this.aimY = my; }
    if (firing && this.cool <= 0) this.fire();
  }

  private move(dx: number, dy: number): void {
    if (this.walkable(this.px + dx, this.py)) this.px += dx;
    if (this.walkable(this.px, this.py + dy)) this.py += dy;
  }

  private dash(): void {
    if (this.phase === 'intro' || this.dashCool > 0 || this.dashT > 0) return;
    if (!this.dashX && !this.dashY) { this.dashX = this.aimX; this.dashY = this.aimY; }
    this.dashT = 0.17; this.dashCool = 0.85;
    this.invul = Math.max(this.invul, 0.28);
    this.audio.dash();
  }

  private bomb(): void {
    if (this.phase !== 'wave' && this.phase !== 'clear') return;
    if (this.bombs <= 0) return;
    this.bombs -= 1;
    this.shakeBy(380, 5);
    this.audio.megaBoom();
    this.blasts.push({ x: this.px, y: this.py - 8, t: 0, max: 520, r: 190, colour: '#fff3c9' });
    this.tps?.blast(this.px, this.py - 8, 90, '#fff3c9', true);
    this.shots = this.shots.filter((s) => s.kind !== 'foe');
    for (const f of [...this.foes]) if (f.sleep <= 0) this.hurtFoe(f, f.type === 'boss' ? 25 : 12);
  }

  private fire(): void {
    const w = WEAPONS[this.weapon];
    this.cool = 1 / w.rate;
    this.flashT = 0.05;
    const x = this.px + this.aimX * 8;
    const y = this.py - 8 + this.aimY * 6;
    const shot = (angle: number, speed: number, over: Partial<Shot>) => {
      const a = Math.atan2(this.aimY, this.aimX) + angle;
      this.shots.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: 0.9, dmg: 1, r: 2, kind: 'bullet', pierce: 0,
        colour: w.colour, hit: null, ...over,
      });
    };
    switch (this.weapon) {
      case 'smg': shot((Math.random() - 0.5) * 0.14, 250, {}); break;
      case 'shotgun': for (let i = 0; i < 7; i += 1) shot((i - 3) * 0.085 + (Math.random() - 0.5) * 0.05, 230 + Math.random() * 30, { life: 0.42 }); break;
      case 'laser': shot(0, 420, { kind: 'laser', dmg: 2, pierce: 99, hit: new Set(), life: 0.6 }); break;
      case 'rocket': shot(0, 150, { kind: 'rocket', dmg: 6, r: 3, life: 1.4 }); break;
      case 'flame': shot((Math.random() - 0.5) * 0.5, 120 + Math.random() * 40, { kind: 'flame', dmg: 0.45, r: 4, pierce: 3, hit: new Set(), life: 0.38 }); break;
      default: shot(0, 240, {}); break;
    }
    this.audio.shot(this.weapon);
    if (this.weapon === 'shotgun' || this.weapon === 'rocket') this.shakeBy(90, 2);
    if (this.ammo !== Infinity) {
      this.ammo -= 1;
      if (this.ammo <= 0) { this.weapon = 'pistol'; this.ammo = Infinity; this.audio.empty(); }
    }
  }

  private stepFoes(dt: number): void {
    const px = this.px;
    const py = this.py;
    for (const f of this.foes) {
      if (f.hp <= 0) continue;
      f.flash = Math.max(0, f.flash - dt);
      if (f.sleep > 0) {
        if (this.phase !== 'wave') continue;
        f.sleep -= dt;
        if (f.sleep <= 0) { this.floatAt(f.x, f.y - 26, '!', '#ff5d5d', 'small'); this.audio.alert(f.x, f.y); }
        continue;
      }
      f.t += dt;
      const def = FOES[f.type];
      const dx = px - f.x;
      const dy = py - f.y;
      const dist = Math.hypot(dx, dy) || 1;
      let vx = (dx / dist) * f.speed;
      let vy = (dy / dist) * f.speed;

      if (f.type === 'gunner') {
        // Keeps its distance and shoots.
        if (dist < 62) { vx = -vx; vy = -vy; }
        else if (dist < 105) { const s = f.seed % 2 < 1 ? 1 : -1; [vx, vy] = [-vy * 0.6 * s, vx * 0.6 * s]; }
        f.shotAt -= dt;
        if (f.shotAt <= 0 && dist < 190) {
          f.shotAt = Math.max(0.7, 1.5 - this.wave * 0.05);
          this.foeShot(f.x, f.y - 9, dx / dist, (dy + 4) / dist, 90);
          this.audio.foeShot(f.x, f.y);
        }
      } else if (f.type === 'dasher') {
        // Winds up (it flashes), then charges in a straight line.
        if (f.state === 0 && dist < 120 && f.t > 0.9) { f.state = 1; f.t = 0; f.dx = dx / dist; f.dy = dy / dist; this.audio.charge(f.x, f.y); }
        if (f.state === 1) { vx = 0; vy = 0; if (f.t > 0.36) { f.state = 2; f.t = 0; this.audio.rush(f.x, f.y); } }
        else if (f.state === 2) { vx = f.dx * 178; vy = f.dy * 178; if (f.t > 0.55) { f.state = 0; f.t = 0; } }
      } else if (f.type === 'drone') {
        const wob = Math.sin(this.clock * 5 + f.seed) * 34;
        vx += (-dy / dist) * wob;
        vy += (dx / dist) * wob;
      } else if (f.type === 'boss') {
        f.shotAt -= dt;
        if (f.shotAt <= 0) {
          f.state = (f.state + 1) % 3;
          f.shotAt = Math.max(1.0, 1.9 - this.wave * 0.03);
          if (f.state === 0) for (let i = 0; i < 20; i += 1) { const a = (i / 20) * Math.PI * 2 + this.clock; this.foeShot(f.x, f.y - 26, Math.cos(a), Math.sin(a), 72); }
          else if (f.state === 1) for (let i = -2; i <= 2; i += 1) { const a = Math.atan2(dy, dx) + i * 0.2; this.foeShot(f.x, f.y - 26, Math.cos(a), Math.sin(a), 108); }
          else for (let i = 0; i < 4; i += 1) this.pods.push({ x: f.x + (Math.random() - 0.5) * 70, y: f.y + (Math.random() - 0.5) * 50, t: 0, max: 0.6, type: 'drone' });
          if (f.state === 2) this.audio.podFall(f.x, f.y, 0.6, false);
          else this.audio.volley(f.x, f.y);
        }
      }

      // Robots do not stand on one another.
      for (const o of this.foes) {
        if (o === f || o.sleep > 0) continue;
        const sx = f.x - o.x;
        const sy = f.y - o.y;
        const d2 = sx * sx + sy * sy;
        const min = def.r + FOES[o.type].r + 2;
        if (d2 > 0.01 && d2 < min * min) { const d = Math.sqrt(d2); vx += (sx / d) * 26; vy += (sy / d) * 26; }
      }

      const nx = f.x + vx * dt;
      const ny = f.y + vy * dt;
      if (def.fly) { f.x = nx; f.y = ny; }
      else {
        if (this.walkable(nx, f.y)) f.x = nx;
        if (this.walkable(f.x, ny)) f.y = ny;
      }

      // Touching the pilot hurts (a bomber goes off).
      const reach = def.r + PLAYER_R;
      if (Math.abs(f.x - px) < reach && Math.abs((f.y - 8 * def.scale) - (py - 8)) < reach + 3) {
        if (f.type === 'bomber') this.hurtFoe(f, 99);
        else this.hurtPlayer(f.type === 'tank' || f.type === 'boss' ? 2 : 1);
      }
    }
  }

  private foeShot(x: number, y: number, dx: number, dy: number, speed: number): void {
    this.shots.push({ x, y, vx: dx * speed, vy: dy * speed, life: 4, dmg: 1, r: 2, kind: 'foe', pierce: 0, colour: '#ff5d5d', hit: null });
  }

  private stepShots(dt: number): void {
    const keep: Shot[] = [];
    for (const s of this.shots) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      let gone = s.life <= 0;
      if (s.kind === 'rocket' && Math.random() < 0.6) this.sparks.push({ x: s.x, y: s.y, vx: 0, vy: 0, g: 0, life: 0, max: 260, colour: '#9aa1b1', size: 1 });
      if (s.kind === 'foe') {
        if (!gone && this.invul <= 0 && Math.abs(s.x - this.px) < PLAYER_R + 1 && Math.abs(s.y - (this.py - 8)) < 8) {
          this.hurtPlayer(1);
          gone = true;
        }
      } else if (!gone) {
        for (const f of this.foes) {
          if (f.sleep > 0 || f.hp <= 0 || s.hit?.has(f)) continue;
          const def = FOES[f.type];
          const cy = f.y - 8 * def.scale;
          if (Math.abs(s.x - f.x) > def.r + s.r + 2 || Math.abs(s.y - cy) > def.r * 1.4 + s.r + 2) continue;
          if (s.kind === 'rocket') { gone = true; break; }
          this.hurtFoe(f, s.dmg, s.vx, s.vy);
          if (s.hit) s.hit.add(f);
          if (s.pierce <= 0) { gone = true; break; }
          s.pierce -= 1;
        }
      }
      if (gone && s.kind === 'rocket') this.explode(s.x, s.y, 30, 6, true);
      if (!gone) keep.push(s);
    }
    this.shots = keep;
  }

  private stepPickups(dt: number): void {
    this.pickups = this.pickups.filter((p) => {
      if (p.fall > 0) {
        p.fall -= dt;
        if (p.fall <= 0) this.audio.crate(p.x, p.y);
        return true;
      }
      p.age += dt;
      if (Math.abs(p.x - this.px) < 10 && Math.abs(p.y - this.py) < 10) { this.take(p.kind); return false; }
      return p.age < PICKUP_LIFE;
    });
  }

  private take(kind: PickupKind): void {
    this.audio.pickup(kind);
    let word: string;
    if (kind === 'med') { this.hp = Math.min(this.maxHp, this.hp + 2); word = '+2 HP'; }
    else if (kind === 'bomb') { this.bombs = Math.min(5, this.bombs + 1); word = '+1 BOMB'; }
    else if (kind === 'shield') { this.shield = 3; word = 'SHIELD'; }
    else if (kind === 'x2') { this.doubleT = 12; word = 'SCORE ×2'; }
    else { this.weapon = kind; this.ammo = WEAPONS[kind].ammo; this.cool = 0; word = WEAPONS[kind].name; }
    this.floatAt(this.px, this.py - 26, word, '#ffe066', 'big');
  }

  private stepEffects(dt: number): void {
    const ms = dt * 1000;
    this.sparks = this.sparks.filter((p) => {
      p.life += ms; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      return p.life < p.max;
    });
    this.blasts = this.blasts.filter((b) => { b.t += ms; return b.t < b.max; });
    this.pods = this.pods.filter((pod) => {
      pod.t += dt;
      if (pod.t < pod.max) return true;
      if (this.phase !== 'over') {
        this.foes.push(this.makeFoe(pod.type, pod.x, pod.y, Math.max(1, this.wave)));
        this.burst(pod.x, pod.y - 4, '#cfd6e6', pod.type === 'boss' ? 26 : 8, pod.type === 'boss' ? 60 : 30);
        if (pod.type === 'boss') this.shakeBy(420, 5);
        this.audio.podLand(pod.x, pod.y, pod.type === 'boss');
      }
      return false;
    });
  }

  /* ─────────────────────────────────────────────────────── hits, score ─── */

  private hurtFoe(f: Foe, dmg: number, kx = 0, ky = 0): void {
    if (f.hp <= 0) return;
    f.hp -= dmg;
    f.flash = 0.08;
    const k = Math.hypot(kx, ky);
    if (k && f.type !== 'boss' && f.type !== 'tank') {
      const nx = f.x + (kx / k) * 2.5;
      const ny = f.y + (ky / k) * 2.5;
      if (FOES[f.type].fly || this.walkable(nx, ny)) { f.x = nx; f.y = ny; }
    }
    if (f.hp > 0) { this.audio.hit(f.x, f.y, f.type === 'tank' || f.type === 'boss'); return; }
    const def = FOES[f.type];
    this.foes = this.foes.filter((o) => o !== f);
    const before = this.mult();
    this.combo += 1;
    this.comboT = 2.6;
    if (this.mult() > before) this.audio.combo(this.mult());
    const gain = def.score * this.mult();
    this.score += gain;
    this.floatAt(f.x, f.y - 14 * def.scale, `+${gain}`, this.mult() > 1 ? '#ffe066' : '#e8eef9', 'small');
    // A bomber goes off (a real blast, with its own sound); the others fall apart.
    if (f.type === 'bomber') this.explode(f.x, f.y - 8, 26, 4, true);
    else {
      this.audio.kill(f.x, f.y, f.type);
      this.explode(f.x, f.y - 8 * def.scale, 8 * def.scale, 0, def.scale > 1, false);
    }
    // Sometimes it leaves something behind.
    const chance = f.type === 'boss' ? 1 : f.type === 'tank' ? 0.5 : f.type === 'drone' ? 0.03 : 0.08;
    const drops = f.type === 'boss' ? 3 : 1;
    for (let i = 0; i < drops; i += 1) {
      if (Math.random() > chance) continue;
      const at = this.nearestLand(f.x + (i - (drops - 1) / 2) * 16, f.y);
      this.pickups.push({ x: at.x, y: at.y, kind: this.rollPickup(), age: 0, fall: 0 });
    }
    if (this.score > this.best) { this.best = this.score; this.record = true; }
  }

  private rollPickup(): PickupKind {
    const roll = Math.random();
    if (this.hp <= 2 && roll < 0.35) return 'med';
    if (roll < 0.5) return (['smg', 'shotgun', 'laser', 'rocket', 'flame'] as const)[Math.floor(Math.random() * 5)];
    if (roll < 0.7) return 'med';
    if (roll < 0.8) return 'shield';
    if (roll < 0.9) return 'bomb';
    return 'x2';
  }

  private mult(): number {
    return Math.min(8, 1 + Math.floor(this.combo / 5)) * (this.doubleT > 0 ? 2 : 1);
  }

  /** A blast: sparks, a ring, and (with `dmg`) everything in `radius` is hit — the pilot too.
   *  `heard`: it makes its own explosion sound (a kill has one already). */
  private explode(x: number, y: number, radius: number, dmg: number, loud: boolean, heard = true): void {
    this.blasts.push({ x, y, t: 0, max: loud ? 340 : 220, r: radius, colour: dmg ? '#ffb86b' : '#e8eef9' });
    this.tps?.blast(x, y, radius, dmg ? '#ffb86b' : '#e8eef9', loud);
    this.burst(x, y, dmg ? '#ffb86b' : '#cfd6e6', loud ? 16 : 7, loud ? 70 : 40);
    if (loud) this.shakeBy(160, 3);
    if (heard) this.audio.boom(x, y);
    if (!dmg) return;
    for (const f of [...this.foes]) {
      if (f.sleep > 0) continue;
      const d = Math.hypot(f.x - x, (f.y - 8 * FOES[f.type].scale) - y);
      if (d < radius + FOES[f.type].r) this.hurtFoe(f, dmg);
    }
    if (Math.hypot(this.px - x, (this.py - 8) - y) < radius * 0.7) this.hurtPlayer(1);
  }

  private hurtPlayer(dmg: number): void {
    if (this.invul > 0 || this.phase === 'over' || this.phase === 'intro') return;
    this.invul = 0.85;
    this.shakeBy(220, 4);
    if (this.shield > 0) {
      this.shield -= 1;
      this.burst(this.px, this.py - 8, '#35d0c7', 10, 50);
      this.audio.shieldHit();
      return;
    }
    this.hp -= dmg;
    this.combo = 0;
    this.audio.hurt();
    this.burst(this.px, this.py - 8, '#ff5d5d', 12, 55);
    if (this.hp > 0) return;
    this.hp = 0;
    this.explode(this.px, this.py - 8, 22, 0, true);
    this.end();
  }

  private burst(x: number, y: number, colour: string, count: number, speed: number): void {
    if (this.tps) { this.tps.burst(x, y, colour, count, speed); return; }
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 12, g: 70, life: 0, max: 300 + Math.random() * 320, colour, size: Math.random() < 0.3 ? 2 : 1 });
    }
  }

  /* ───────────────────────────────────────────────────────── the land ─── */

  private walkable(x: number, y: number): boolean {
    const tx = Math.floor((x - this.ox) / T);
    const ty = Math.floor((y - this.oy) / T);
    const { tw, th, ground } = this.island;
    return tx >= 0 && ty >= 0 && tx < tw && ty < th && ground[ty * tw + tx] === 1;
  }

  /** The closest spot of land to a point (the point itself when it is land). */
  private nearestLand(x: number, y: number): { x: number; y: number } {
    if (this.walkable(x, y)) return { x, y };
    const { tw, th, ground } = this.island;
    let best = { x: this.ox + (tw * T) / 2, y: this.oy + (th * T) / 2 };
    let bestD = Infinity;
    for (let ty = 0; ty < th; ty += 1) {
      for (let tx = 0; tx < tw; tx += 1) {
        if (ground[ty * tw + tx] !== 1) continue;
        const cx = this.ox + tx * T + T / 2;
        const cy = this.oy + ty * T + T / 2;
        const d = (cx - x) ** 2 + (cy - y) ** 2;
        if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
      }
    }
    return best;
  }

  /** Where a pod comes down: on land, away from the pilot when the island allows. */
  private spawnPoint(type: FoeType): { x: number; y: number } {
    const { tw, th, ground } = this.island;
    let pick = { x: this.landX, y: this.landY };
    let far = -1;
    for (let i = 0; i < 14; i += 1) {
      const tx = Math.floor(Math.random() * tw);
      const ty = Math.floor(Math.random() * th);
      if (ground[ty * tw + tx] !== 1) continue;
      const x = this.ox + tx * T + T / 2;
      const y = this.oy + ty * T + T / 2;
      const d = Math.hypot(x - this.px, y - this.py);
      if (d > 90 && type !== 'boss') return { x, y };
      if (d > far) { far = d; pick = { x, y }; }
    }
    return pick;
  }

  /* ─────────────────────────────────────────────────────────── for the engine ─── */

  /** What the camera follows. */
  focus(): { x: number; y: number } {
    return { x: this.px, y: this.py - 10 };
  }

  /** What the sound engine follows: where the ears are, how tense it is. */
  private audioScene(): AudioScene {
    if (this.aboard && this.tps) {
      // The ears are at the eye, behind the vehicle: the fight gives positions relative to them.
      const t = this.tps.state();
      return {
        x: 0, y: 0, phase: this.phase, paused: this.paused, wave: this.wave,
        boss: t.boss != null, foes: t.foes, hp: t.hull < 0.25 ? 1 : 5, heli: null, walking: false,
        engine: t.down ? null : { kind: t.craft ?? 'plane', pace: t.pace, boost: t.boosting },
      };
    }
    const isBoss = (o: { type: FoeType }) => o.type === 'boss';
    return {
      x: this.px, y: this.py, phase: this.phase, paused: this.paused, wave: this.wave,
      boss: this.foes.some(isBoss) || this.pods.some(isBoss) || this.queue.some(isBoss),
      foes: this.foes.length, hp: this.hp, heli: this.heli ? { x: this.heli.x, y: this.heli.y + (this.tps ? 150 : 0) } : null,
      walking: this.landed && this.stride > 0 && this.dashT <= 0,
      // Seen from behind the pilot, left and right are its own.
      yaw: this.tps ? this.tps.heading() : undefined,
    };
  }

  hud(): ArcadeHud {
    const base = {
      on: true, phase: this.phase, paused: this.paused, score: this.score, best: this.best, record: this.record,
      wave: this.wave, mult: this.mult(), banner: this.banner, bannerAt: this.bannerAt, audio: this.audio.getMode(),
      checkpoint: this.checkpoint, maxHp: this.maxHp, bombs: this.bombs,
    } as const;
    if (this.aboard && this.tps) {
      const t = this.tps.state();
      return {
        ...base, mode: 'craft', hp: 0, shield: 0, weapon: '', ammo: null, foes: t.foes, boss: t.boss,
        hull: t.hull, missiles: t.missiles,
      };
    }
    const boss = this.foes.find((f) => f.type === 'boss');
    return {
      ...base, mode: 'ground', hull: 0, missiles: 0, hp: this.hp, shield: this.shield, weapon: WEAPONS[this.weapon].name,
      ammo: this.ammo === Infinity ? null : this.ammo, foes: this.foes.length + this.pods.length + this.queue.length,
      boss: boss ? Math.max(0, boss.hp / boss.maxHp) : null,
    };
  }

  /** Flat on the ground, under everything that stands. */
  drawUnder(g: CanvasRenderingContext2D): void {
    const t = this.clock;
    // Where a pod is about to land.
    for (const pod of this.pods) {
      const k = pod.t / pod.max;
      const r = Math.round((pod.type === 'boss' ? 16 : 7) * (0.4 + 0.6 * k));
      g.fillStyle = 'rgba(8, 10, 16, 0.45)';
      g.fillRect(Math.round(pod.x) - r, Math.round(pod.y) - Math.round(r / 2), r * 2, r);
      if (Math.floor(t * 10) % 2) {
        g.fillStyle = '#ff5d5d';
        g.fillRect(Math.round(pod.x) - r - 2, Math.round(pod.y), 3, 1);
        g.fillRect(Math.round(pod.x) + r, Math.round(pod.y), 3, 1);
      }
    }
    const boxes = arcadeArt().pickup;
    for (const p of this.pickups) {
      if (p.fall > 0) continue;
      if (p.age > PICKUP_LIFE - 3 && Math.floor(t * 8) % 2) continue;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.3 + 0.1 * Math.sin(t * 6 + p.x);
      g.drawImage(glow('#ffe066'), p.x - 14, p.y - 18, 28, 28);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = 'rgba(8, 10, 16, 0.4)';
      g.fillRect(Math.round(p.x) - 5, Math.round(p.y), 10, 2);
      g.drawImage(boxes[p.kind], Math.round(p.x) - 5, Math.round(p.y) - 12 - Math.round(Math.abs(Math.sin(t * 3 + p.x)) * 2));
    }
    g.fillStyle = 'rgba(8, 10, 16, 0.4)';
    for (const f of this.foes) {
      const s = FOES[f.type].scale;
      if (FOES[f.type].fly) g.fillRect(Math.round(f.x) - 3, Math.round(f.y) + 8, 6, 2);
      else g.fillRect(Math.round(f.x) - 6 * s, Math.round(f.y) - 1, 12 * s, 2);
    }
    if (this.landed && this.phase !== 'over') g.fillRect(Math.round(this.px) - 5, Math.round(this.py) - 1, 10, 2);
    if (this.heli) g.fillRect(Math.round(this.heli.x) - 26, Math.round(this.heli.y) + 44, 52, 4);
  }

  /** Everything that stands, for the engine to sort with the scenery. */
  items(push: (y: number, draw: () => void) => void, g: CanvasRenderingContext2D): void {
    for (const f of this.foes) push(f.y, () => this.drawFoe(g, f));
    if (this.landed && this.phase !== 'over') push(this.py, () => this.drawPilot(g, this.px, this.py));
  }

  private drawFoe(g: CanvasRenderingContext2D, f: Foe): void {
    const def = FOES[f.type];
    const t = this.clock + f.seed;
    if (def.art === 'drone') {
      const sprite = art().drone;
      const x = Math.round(f.x) - sprite.width;
      const y = Math.round(f.y) - 14 + Math.round(Math.sin(t * 9) * 1.5);
      g.drawImage(sprite, x, y, sprite.width * 2, sprite.height * 2);
      g.fillStyle = f.flash > 0 ? '#ffffff' : Math.floor(t * 8) % 2 ? '#ff5d5d' : '#7a1f1f';
      g.fillRect(x + 4, y + 4, 2, 2);
      return;
    }
    const awake = f.sleep <= 0;
    const walking = awake && !(f.type === 'dasher' && f.state === 1);
    const step = Math.floor(t * (f.type === 'tank' || f.type === 'boss' ? 4 : 8)) % 2;
    const windup = f.type === 'dasher' && f.state === 1;
    const pose: RobotPose = {
      bob: walking ? step : 0,
      legs: walking ? (step ? 'walkA' : 'walkB') : 'stand',
      armL: f.type === 'bomber' || windup ? 'up' : 'down', armR: f.type === 'bomber' || f.type === 'boss' ? 'up' : 'down',
      armLdy: 0, armRdy: 0,
      eye: awake ? (windup && Math.floor(t * 16) % 2 ? '#ffffff' : '#ff4d4d') : '#cfe0fb',
      lamp: awake ? (Math.floor(t * 6) % 2 ? '#ff4d4d' : '#3a1010') : '#55607a',
      chest: awake ? '#ff4d4d' : '#ffd98a', scan: 0.5 + 0.5 * Math.sin(t * 8), alpha: 1,
    };
    const sg = this.sg;
    sg.clearRect(0, 0, 16, 20);
    drawRobot(sg, art().robots[def.art] as RobotArt, 8, 20, pose);
    if (f.flash > 0 || def.tint) {
      sg.globalCompositeOperation = 'source-atop';
      sg.globalAlpha = f.flash > 0 ? 0.85 : 0.42;
      sg.fillStyle = f.flash > 0 ? '#ffffff' : def.tint!;
      sg.fillRect(0, 0, 16, 20);
      sg.globalAlpha = 1;
      sg.globalCompositeOperation = 'source-over';
    }
    const s = def.scale;
    g.drawImage(this.scratch, Math.round(f.x) - 8 * s, Math.round(f.y) - 20 * s, 16 * s, 20 * s);
    // The big ones wear their health.
    if (s > 1 && f.hp < f.maxHp) {
      const w = 12 * s;
      const x = Math.round(f.x) - w / 2;
      const y = Math.round(f.y) - 20 * s - 4;
      g.fillStyle = '#10131b';
      g.fillRect(x - 1, y - 1, w + 2, 4);
      g.fillStyle = '#ff5d5d';
      g.fillRect(x, y, Math.max(0, Math.round((w * f.hp) / f.maxHp)), 2);
    }
  }

  private drawPilot(g: CanvasRenderingContext2D, x: number, y: number): void {
    if (this.invul > 0 && this.dashT <= 0 && Math.floor(this.clock * 14) % 2) return;
    const sprites = arcadeArt().hero;
    const frame = this.stride > 0 ? (Math.floor(this.stride * 9) % 2 ? sprites.walkA : sprites.walkB) : sprites.stand;
    const left = Math.round(x) - 7;
    const top = Math.round(y) - frame.height + 1;
    g.drawImage(frame, left, top);
    // The gun, toward where it aims; a flash at its mouth when it fires.
    const gx = Math.round(x + this.aimX * 6);
    const gy = Math.round(y - 7 + this.aimY * 5);
    g.fillStyle = '#10131b';
    g.fillRect(gx - 2, gy - 2, 5, 4);
    g.fillStyle = WEAPONS[this.weapon].colour;
    g.fillRect(gx - 1, gy - 1, 3, 2);
    if (this.flashT > 0) {
      g.fillStyle = '#fff3c9';
      g.fillRect(Math.round(x + this.aimX * 10) - 1, Math.round(y - 7 + this.aimY * 9) - 1, 3, 3);
    }
    if (this.shield > 0) {
      g.strokeStyle = '#35d0c7';
      g.globalAlpha = 0.55 + 0.25 * Math.sin(this.clock * 8);
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(Math.round(x) + 0.5, Math.round(y) - 7.5, 10, 12, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  /** Above everything: shots, blasts, what falls from the sky, the helicopter. */
  drawOver(g: CanvasRenderingContext2D): void {
    const t = this.clock;
    for (const s of this.shots) {
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      if (s.kind === 'laser') {
        const l = Math.hypot(s.vx, s.vy) || 1;
        g.strokeStyle = s.colour;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(s.x, s.y);
        g.lineTo(s.x - (s.vx / l) * 12, s.y - (s.vy / l) * 12);
        g.stroke();
        g.fillStyle = '#ffffff';
        g.fillRect(x, y, 1, 1);
      } else if (s.kind === 'flame') {
        const k = Math.max(0, s.life / 0.38);
        g.fillStyle = k > 0.6 ? '#ffe08a' : k > 0.3 ? '#ff8a2a' : '#a3472f';
        const size = k > 0.5 ? 3 : 2;
        g.fillRect(x - 1, y - 1, size, size);
      } else if (s.kind === 'rocket') {
        g.fillStyle = '#10131b';
        g.fillRect(x - 2, y - 2, 5, 5);
        g.fillStyle = s.colour;
        g.fillRect(x - 1, y - 1, 3, 3);
      } else if (s.kind === 'foe') {
        g.fillStyle = '#5a1414';
        g.fillRect(x - 2, y - 2, 4, 4);
        g.fillStyle = Math.floor(t * 12) % 2 ? '#ff5d5d' : '#ffb86b';
        g.fillRect(x - 1, y - 1, 2, 2);
      } else {
        g.fillStyle = s.colour;
        g.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    for (const b of this.blasts) {
      const k = b.t / b.max;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = (1 - k) * 0.55;
      const r = b.r * (0.5 + 0.7 * k);
      g.drawImage(glow(b.colour), b.x - r, b.y - r, r * 2, r * 2);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = (1 - k) * 0.9;
      g.strokeStyle = b.colour;
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, 2 + b.r * k, (2 + b.r * k) * 0.7, 0, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }
    for (const p of this.sparks) {
      const k = p.life / p.max;
      g.globalAlpha = k > 0.6 ? (1 - k) / 0.4 : 1;
      g.fillStyle = p.colour;
      g.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    g.globalAlpha = 1;
    // A present on its way down.
    const sprites = arcadeArt();
    for (const p of this.pickups) {
      if (p.fall <= 0) continue;
      const drop = p.fall * 90;
      const x = Math.round(p.x);
      const y = Math.round(p.y - drop);
      g.drawImage(sprites.chute, x - 7, y - 20);
      g.drawImage(sprites.pickup[p.kind], x - 5, y - 12);
    }
    const h = this.heli;
    if (h) {
      // Twice the sprite: a machine that dwarfs the robots.
      const x = Math.round(h.x) - 30;
      const y = Math.round(h.y) - 10;
      // The pilot rides the rope down during the drop.
      if (this.phase === 'intro' && !this.landed) {
        const k = Math.max(0, Math.min(1, (h.t - h.max) / 0.55));
        const ry = y + 26 + (this.landY - (y + 26)) * k;
        g.fillStyle = '#cfd6e6';
        g.fillRect(Math.round(this.landX), y + 20, 1, Math.max(0, Math.round(ry - 14 - (y + 20))));
        this.drawPilot(g, this.landX, ry);
      }
      g.drawImage(sprites.heli, x, y, sprites.heli.width * 2, sprites.heli.height * 2);
      // The blades: one long, one short, in turn.
      const blade = Math.floor(t * 30) % 2;
      g.fillStyle = blade ? '#cfd6e6' : '#7f879a';
      const len = blade ? 92 : 40;
      g.fillRect(x + 30 - len / 2, y - 2, len, 2);
      g.fillRect(x + 66, y + (blade ? 2 : 6), 2, blade ? 10 : 4);
    }
  }
}

/** Keys the game keeps for itself (the page must not scroll or tab away). */
const GAME_KEYS = new Set([
  'w', 'a', 's', 'd', 'z', 'q', 'e', 'p', 'm', ' ', 'Shift', 'Enter', 'Escape', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
