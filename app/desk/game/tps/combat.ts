// The fight around the machine, whatever its shape — seaplane, gunboat, tank:
// its guns and its missiles, the robots that come for it and what they throw,
// the waves, the supplies, and what the instruments show. A shape itself (how
// it moves, where it points, where the eye sits) is a `Craft`; this file turns
// one into the other (`shift`, morph.ts) — by where the machine goes (a plane
// that lands, a boat on the beach, a tank in the sea) or on T (into the air).
import { Color, Group, Vector3 } from 'three';
import type { Form } from '../forms';
import { Boat } from './boat';
import type { Craft, CraftEnv, CraftState } from './craft';
import { AIRBORNE, FIRST_RIDE_WAVE, FLIGHT_OF, FOES, makeFoe, POOLS, stepFoe, type Foe, type FoeCtx, type FoeKind } from './foes';
import type { Streak } from './fx';
import type { HudFrame, Mark } from './hud';
import type { Input } from './input';
import { skyModels } from './models';
import type { Machine } from './machine';
import { Morph, MORPH_TIME } from './morph';
import { Plane } from './plane';
import type { TpsRun } from './run';
import type { Rig, Stage, StagePoint } from './stage';
import { Tank } from './tank';
import { instance } from './voxels';

type Shot = { pos: Vector3; prev: Vector3; dir: Vector3; speed: number; life: number; damage: number; splash: number; length: number; width: number };
type Missile = {
  mesh: Group; pos: Vector3; dir: Vector3; speed: number; life: number; smokeIn: number;
  /** A robot, the player, or nothing (it flies straight). */
  target: Foe | 'player' | null;
  mine: boolean;
};
type Supply = { mesh: Group; pos: Vector3; life: number; t: number };
type Queued = { at: number; kind: FoeKind; lead: Vector3; slot: number; of: number };

const MAX_HULL = 180;
/** How hard anything hits the machine, against what it is written to do (the game was too hard at 1). */
const HARM = 0.72;
/** What a hit costs each shape: a tank is armour, a hull is thick, a plane is neither. */
const ARMOUR: Record<Form, number> = { plane: 1, boat: 0.85, tank: 0.7 };
const MAX_MISSILES = 6;
const GUN_RANGE = 660;
const LOCK_RANGE = 760;
const SHOT_GOLD = new Color('#ffe066');
const SHOT_RED = new Color('#ff5d5d');
const SHOT_HOT = new Color('#ffb86b');
/** A robot of another element (the sea's for a tank, the land's for a boat…) left this far behind takes to the air. */
const LEFT_BEHIND = 520;
/** What walks: whose sprite, how big. */
const WALKERS: Partial<Record<FoeKind, { art: 'claude' | 'codex' | 'cursor' | 'red'; scale: number }>> = {
  walker: { art: 'claude', scale: 0.5 }, trooper: { art: 'codex', scale: 0.5 }, mech: { art: 'red', scale: 1.25 },
};

const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();

export type CombatState = {
  hull: number;
  missiles: number;
  /** Robots out there, and those still to come this wave. */
  foes: number;
  /** 0..1 while a dreadnought flies; null otherwise. */
  boss: number | null;
  /** For the sound: the vehicle's pace (1 = cruise) and its afterburner. */
  pace: number;
  boosting: boolean;
  down: boolean;
};

export class Combat {
  private time = 0;
  private hull = MAX_HULL;
  private down = false;
  private safe = 0;
  private hurt = 0;
  private hurtFrom: number | null = null;
  private heat = 0;
  private jammed = false;
  private gunIn = 0;
  private gunSide = 1;
  private missiles = 4;
  private missileIn = 0;
  private lockOn: Foe | null = null;
  private lockT = 0;
  private lockBeep = 0;
  private hot: Foe | null = null;
  private warn: string | null = null;
  private liveT = 0;

  private foes: Foe[] = [];
  private shots: Shot[] = [];
  private foeShots: Shot[] = [];
  private streaks: Streak[] = [];
  private missilesOut: Missile[] = [];
  private supply: Supply | null = null;
  /** What the instruments last pointed at: for a test to play by (`marks`). */
  marks: Mark[] = [];
  private queue: Queued[] = [];
  private waveT = 0;
  private waveOn: boolean;
  private waitIn = 6;
  private waveN: number;
  private ctx: FoeCtx;
  private env: CraftEnv;
  /** The machine is turning into another shape. */
  private morph: Morph | null = null;
  /** Seconds before where it goes may turn it again (never a plane that lands: that cannot wait). */
  private turnWait = 0;
  /** Where the fight is: it follows the machine, slowly. */
  private centre = new Vector3();

  /**
   * `wave`: one was under way when the pilot boarded. It goes on around the
   * vehicle: what stood on the island comes after it (`adopt`), and the
   * `share` the wave had not sent yet comes as robots a vehicle fights — all
   * of it within what a wave of that number is worth to a vehicle (a crowd
   * that was fair on foot would shoot a vehicle down as it leaves).
   */
  /** `onShift`: the machine begins to turn into another shape, for so many seconds (the eye glides over). */
  constructor(
    private stage: Stage, private run: TpsRun, public craft: Craft, private input: Input,
    wave: { share: number; boss: boolean } | null, adopt: Array<{ kind: FoeKind; at: Vector3 }>,
    private onShift: (seconds: number) => void,
  ) {
    this.waveN = run.wave();
    this.waveOn = wave != null;
    // What was pressed on foot is not an order to the machine.
    input.flush();
    this.centre.copy(craft.pos).setY(0);
    this.ctx = {
      target: craft, velocity: craft.vel, afloat: craft.kind !== 'plane', wave: this.waveN, locked: null, foes: 0,
      centre: this.centre, landAt: stage.world.mainland.heightAt,
      groundAt: stage.world.groundAt, towers: stage.world.towers,
      fire: (from, dir, speed, damage) => this.foeFire(from, dir, speed, damage),
      launch: (from, dir) => this.launch(from, dir, 'player', false),
      spawn: (kind, at) => this.addFoe(kind, at, v3.copy(craft.pos).sub(at)),
    };
    this.env = {
      stage, input, audio: run.audio,
      damage: (amount, from, hard) => this.damage(amount, from, hard),
      warn: (text) => { this.warn ??= text; },
    };
    if (!wave) return;
    const whole = this.budget(this.waveN, wave.boss);
    let left = whole;
    for (const a of adopt) {
      // Nothing a vehicle would not meet yet at this wave.
      const kind = a.kind === 'boss' || FOES[a.kind].from <= this.waveN ? a.kind : FOES[a.kind].sea ? 'skimmer' : 'drone';
      if (kind !== 'boss' && FOES[kind].cost > left + 0.5) continue;
      left -= FOES[kind].cost;
      this.addFoe(kind, a.at, v3.copy(craft.pos).sub(a.at));
    }
    this.compose(this.waveN, wave.boss, Math.min(Math.max(0, left), whole * wave.share));
  }

  dispose(): void {
    this.craft.dispose(this.stage);
    for (const f of this.foes) this.stage.scene.remove(f.mesh);
    for (const m of this.missilesOut) this.stage.scene.remove(m.mesh);
    if (this.supply) this.stage.scene.remove(this.supply.mesh);
  }

  state(): CombatState {
    const boss = this.foes.find((f) => f.kind === 'boss');
    const g = this.craft.gauges(this.stage);
    return {
      hull: Math.max(0, this.hull) / MAX_HULL, missiles: this.missiles, foes: this.foes.length + this.queue.length,
      boss: boss ? Math.max(0, boss.hp / boss.maxHp) : null, pace: g.pace, boosting: g.boosting, down: this.down,
    };
  }

  /** Where a sound comes from, for the ears at the eye: right of them, ahead of them. */
  private ear(at: Vector3): [number, number] {
    const cam = this.stage.camera;
    v1.copy(at).sub(cam.position);
    const e = cam.matrixWorld.elements;
    return [(v1.x * e[0] + v1.y * e[1] + v1.z * e[2]) * 0.4, -(v1.x * e[8] + v1.y * e[9] + v1.z * e[10]) * 0.4];
  }

  /* ───────────────────────────────────────────────────────── step ─── */

  step(dt: number): void {
    let craft = this.craft;
    this.time += dt;
    this.safe = Math.max(0, this.safe - dt);
    this.hurt = Math.max(0, this.hurt - dt * 1.4);
    this.warn = null;
    this.turnWait = Math.max(0, this.turnWait - dt);
    if (this.morph) this.stepMorph(dt);
    else {
      craft.step(dt, this.env);
      const asked = this.input.takeMorph();
      const turn = craft.takeTurn();
      if (craft.live && !this.down) {
        if (turn && (craft.kind === 'plane' || this.turnWait <= 0)) this.shift(turn);
        else if (asked && craft.kind !== 'plane') this.shift('plane');
      }
    }
    craft = this.craft;
    this.centre.x += (craft.pos.x - this.centre.x) * (1 - Math.exp(-0.3 * dt));
    this.centre.z += (craft.pos.z - this.centre.z) * (1 - Math.exp(-0.3 * dt));
    const fighting = craft.live && !this.down;
    if (fighting) { this.liveT += dt; this.stepWeapons(dt); }
    this.stepFoes(dt);
    this.stepShots(dt);
    this.stepMissiles(dt);
    this.stepSupply(dt);
    if (fighting) this.stepDirector(dt);
    // Hurt, it smokes.
    if (fighting && this.hull < MAX_HULL * 0.4 && Math.random() < (this.hull < MAX_HULL * 0.2 ? 0.7 : 0.35)) {
      v1.copy(craft.pos).addScaledVector(craft.fwd, 3);
      this.stage.fx.puff(v1, this.hull < MAX_HULL * 0.2 ? '#1c2230' : '#343c50', 2.6, 1.1, 0, 6, 0);
    }
  }

  rig(dt: number, out: Rig): void {
    this.craft.rig(dt, this.stage, out);
  }

  /* ───────────────────────────────────────────── from shape to shape ─── */

  private build(form: Form, state: CraftState, machine: Machine): Craft {
    const dock = { x: state.pos.x, z: state.pos.z, yaw: state.yaw };
    return form === 'plane' ? new Plane(this.stage, machine, dock, state.pos) : form === 'boat' ? new Boat(this.stage, machine, dock, state.pos) : new Tank(this.stage, machine);
  }

  /**
   * The machine turns into another shape. The next one exists at once —
   * unseen, held where the turning machine is — and is the one everything
   * follows (the eye, the robots); it becomes the pilot's when the turn ends.
   */
  private shift(to: Form): void {
    const old = this.craft;
    if (old.kind === to) return;
    const state = old.state();
    // The SAME machine, handed from one shape to the next: its parts do the turning.
    this.morph = new Morph(old.machine, old.kind, to, state);
    old.dispose(this.stage, true);
    const next = this.build(to, state, old.machine);
    next.hold(this.morph.state, this.stage);
    this.craft = next;
    this.ctx.target = next;
    this.ctx.velocity = next.vel;
    this.ctx.afloat = to !== 'plane';
    this.lockOn = null; this.lockT = 0; this.hot = null;
    this.heat = 0; this.jammed = false;
    this.run.audio.morph(to);
    this.onShift(MORPH_TIME);
  }

  private stepMorph(dt: number): void {
    const morph = this.morph;
    if (!morph) return;
    const done = morph.step(dt, this.stage);
    this.craft.hold(morph.state, this.stage);
    morph.place(this.craft.rootPos, this.craft.rootQuat);
    if (!done) return;
    this.morph = null;
    this.craft.release(this.stage);
    this.turnWait = 0.8;
    // Locked: nothing touches it for the instant it takes to see what it is.
    this.safe = 0.5;
    this.stage.shake(0.25);
    this.liveT = Math.min(this.liveT, 2);
  }

  /** The vehicle takes `amount`; from where, if it came from somewhere. `hard` = whatever it is doing. */
  private damage(amount: number, from: Vector3 | null, hard = false): void {
    if (this.down || !this.craft.live) return;
    if (this.safe > 0 || (!hard && this.craft.dodging)) return;
    this.hull -= amount * HARM * ARMOUR[this.craft.kind];
    this.safe = hard ? 1.3 : 0.14;
    this.hurt = 1;
    this.stage.shake(hard ? 0.9 : 0.45);
    if (from) {
      v1.copy(from).applyMatrix4(this.stage.camera.matrixWorldInverse);
      this.hurtFrom = Math.atan2(-v1.y, v1.x);
    } else this.hurtFrom = null;
    this.run.hit();
    this.run.audio.hurt();
    this.stage.fx.burst(this.craft.pos, '#ff5d5d', 8, 46, { size: 1.1, life: 0.5 });
    if (this.hull > 0) return;
    this.hull = 0;
    this.down = true;
    this.craft.wreck(this.stage);
    this.stage.shake(1);
    this.run.audio.megaBoom();
    this.run.over();
  }

  private stepWeapons(dt: number): void {
    const craft = this.craft;
    const audio = this.run.audio;

    // Who is in front of the guns, and who the missile is looking at.
    let hot: Foe | null = null;
    let hotAngle = 0.07;
    let look: Foe | null = null;
    let lookAngle = 0.24;
    for (const foe of this.foes) {
      v1.copy(foe.pos).sub(craft.pos);
      const dist = v1.length();
      const angle = Math.acos(Math.max(-1, Math.min(1, v1.dot(craft.aim) / (dist || 1))));
      const wide = Math.atan2(FOES[foe.kind].radius, dist);
      if (dist < GUN_RANGE && angle - wide < hotAngle) { hot = foe; hotAngle = angle - wide; }
      // The one already being locked keeps a wider cone: it does not jump to its neighbour.
      const cone = angle - wide - (foe === this.lockOn ? 0.1 : 0);
      if (dist < LOCK_RANGE && cone < lookAngle) { look = foe; lookAngle = cone; }
    }
    this.hot = hot;

    if (look !== this.lockOn) { this.lockOn = look; this.lockT = 0; this.lockBeep = 0; }
    if (this.lockOn) {
      const before = this.lockT;
      this.lockT = Math.min(1, this.lockT + dt / 0.75);
      if (before < 1 && this.lockT >= 1) audio.locked();
      else if (this.lockT < 1) {
        this.lockBeep -= dt;
        if (this.lockBeep <= 0) { this.lockBeep = 0.2 - 0.12 * this.lockT; audio.lockTick(this.lockT); }
      }
    }
    this.ctx.locked = this.lockOn;

    // The cannon: two guns in turn, toward where they point — or, a robot in
    // their line, toward where it will be.
    this.gunIn -= dt;
    const gun = craft.gun;
    const firing = this.input.firing && !this.jammed;
    if (firing && this.gunIn <= 0) {
      this.gunIn = 1 / gun.rate;
      this.gunSide = -this.gunSide;
      const speed = gun.speed + craft.vel.length();
      craft.muzzle(this.gunSide, v2);
      if (hot) {
        const t = v1.copy(hot.pos).sub(v2).length() / speed;
        v1.copy(hot.pos).addScaledVector(hot.vel, t).sub(v2).normalize();
      } else v1.copy(craft.pos).addScaledVector(craft.aim, 340).sub(v2).normalize();
      v1.x += (Math.random() - 0.5) * 0.012; v1.y += (Math.random() - 0.5) * 0.012; v1.z += (Math.random() - 0.5) * 0.012;
      this.shots.push({
        pos: v2.clone(), prev: v2.clone(), dir: v1.clone().normalize(), speed, life: GUN_RANGE / speed,
        damage: gun.damage, splash: gun.splash, length: gun.length, width: gun.width,
      });
      this.stage.fx.flash(v2, '#fff3c9', 7, 0.05);
      this.heat = Math.min(1, this.heat + gun.heat);
      if (this.heat >= 1) { this.jammed = true; audio.jam(); }
      if (gun.splash) audio.shell(); else audio.cannon();
      craft.fired?.(this.stage);
    }
    if (!firing || this.gunIn > 0.2) this.heat = Math.max(0, this.heat - dt * 0.5);
    if (this.jammed && this.heat < 0.45) this.jammed = false;
    if (this.jammed) this.warn ??= 'OVERHEAT';

    // Missiles: one back in the rack every few seconds.
    if (this.missiles < MAX_MISSILES) {
      this.missileIn += dt;
      if (this.missileIn >= 7) { this.missileIn = 0; this.missiles += 1; }
    }
    if (this.input.takeMissile()) {
      if (this.missiles > 0) {
        this.missiles -= 1;
        this.launch(craft.muzzle(0, v2), craft.aim, this.lockT >= 1 ? this.lockOn : null, true);
        audio.missile();
      } else audio.empty();
    }
  }

  private launch(from: Vector3, dir: Vector3, target: Foe | 'player' | null, mine: boolean): void {
    const mesh = instance(mine ? skyModels().missile : skyModels().foeMissile);
    this.stage.scene.add(mesh);
    this.missilesOut.push({
      mesh, pos: from.clone(), dir: dir.clone().normalize(), speed: mine ? this.craft.vel.length() + 60 : 105, life: mine ? 5 : 7,
      smokeIn: 0, target, mine,
    });
    if (!mine) { const [x, y] = this.ear(from); this.run.audio.foeMissile(x, y); }
  }

  private foeFire(from: Vector3, dir: Vector3, speed: number, damage: number): void {
    if (this.foeShots.length > 220) return;
    this.foeShots.push({ pos: from.clone(), prev: from.clone(), dir: dir.clone(), speed, life: 3.4, damage, splash: 0, length: 0, width: 0 });
    const [x, y] = this.ear(from);
    this.run.audio.foeShot(x, y);
  }

  private addFoe(kind: FoeKind, at: Vector3, heading: Vector3): Foe {
    const models = skyModels();
    const walks = WALKERS[kind];
    let mesh: Group;
    if (walks) {
      // The board's robot, on its feet: its walk's two frames, at its size (the outer group swells when hit).
      const body = new Group();
      body.add(instance(models.walker[walks.art].walkA), instance(models.walker[walks.art].walkB));
      body.scale.setScalar(walks.scale);
      mesh = new Group();
      mesh.add(body);
    } else mesh = instance(models[kind as Exclude<FoeKind, 'walker' | 'trooper' | 'mech'>]);
    this.stage.scene.add(mesh);
    const foe = makeFoe(kind, mesh, at, heading, this.waveN);
    mesh.position.copy(foe.pos);
    this.foes.push(foe);
    return foe;
  }

  /** What the machine's shape can meet: a robot of another element comes as its airborne kin. */
  private fit(kind: FoeKind): FoeKind {
    const def = FOES[kind];
    const form = this.craft.kind;
    return (def.sea && form !== 'boat') || (def.land && form !== 'tank') ? AIRBORNE[kind] : kind;
  }

  /** A robot left behind by a machine gone where it cannot follow: it takes to the air after it. */
  private lift(foe: Foe): void {
    const kind = AIRBORNE[foe.kind];
    foe.dead = true;
    this.stage.scene.remove(foe.mesh);
    if (this.lockOn === foe) { this.lockOn = null; this.lockT = 0; }
    this.stage.fx.burst(foe.pos, '#ffb86b', 8, 30, { size: 1.4, life: 0.6, lift: 20 });
    v1.copy(foe.pos);
    v1.y = Math.max(v1.y, this.stage.world.groundAt(v1.x, v1.z)) + 8;
    const next = this.addFoe(kind, v1, v2.copy(this.craft.pos).sub(v1).setY(0.4));
    next.hp = Math.max(1, Math.round(next.maxHp * (foe.hp / foe.maxHp)));
  }

  private stepFoes(dt: number): void {
    const craft = this.craft;
    this.ctx.wave = this.waveN;
    this.ctx.foes = this.foes.length;
    const fx = this.stage.fx;
    const form = craft.kind;
    for (const foe of this.foes) {
      const def = FOES[foe.kind];
      if (foe.dead) continue;
      if (((def.sea && form !== 'boat') || (def.land && form !== 'tank')) && foe.pos.distanceTo(craft.pos) > LEFT_BEHIND) { this.lift(foe); continue; }
      stepFoe(foe, this.ctx, dt);
      // A hit shows: it swells for an instant.
      foe.mesh.scale.setScalar(foe.flash > 0 ? 1.14 : 1);
      // Engines leave a trail; what rides the water leaves a wake.
      if ((foe.kind === 'ace' || foe.kind === 'bomber' || foe.kind === 'boss') && Math.random() < 0.5) {
        v1.copy(foe.pos).addScaledVector(foe.dir, foe.kind === 'boss' ? -44 : -10);
        fx.puff(v1, '#ffb86b', foe.kind === 'boss' ? 5 : 1.6, 0.35, 0, 0, 0, false);
      } else if (def.sea && foe.kind !== 'mine' && Math.random() < 0.6) {
        v1.copy(foe.pos).addScaledVector(foe.dir, -def.radius);
        v1.y = 0.4;
        fx.burst(v1, '#cfe0fb', 1, 8, { size: 1.2, life: 0.7, gravity: 30, lift: 8, drag: 1.2, spread: 2 });
      }
      // It rams the player: a small one dies of it, a big one does not notice.
      if (craft.live && !this.down && foe.pos.distanceTo(craft.pos) < def.radius + craft.radius) {
        this.damage(def.ram, foe.pos, !!def.heavy || foe.kind === 'mine');
        if (def.heavy) {
          // Thrown off its hull.
          v1.copy(craft.pos).sub(foe.pos).normalize();
          craft.pos.copy(foe.pos).addScaledVector(v1, def.radius + craft.radius + 4);
        } else this.kill(foe, false);
      }
    }
    if (this.foes.some((x) => x.dead)) this.foes = this.foes.filter((x) => !x.dead);
  }

  private hitFoe(foe: Foe, damage: number, at: Vector3): void {
    if (foe.dead) return;
    foe.hp -= damage;
    foe.flash = 0.07;
    this.stage.fx.burst(at, '#fff3c9', 3, 40, { size: 0.9, life: 0.25, gravity: 20 });
    const [x, y] = this.ear(at);
    if (foe.hp > 0) { this.run.audio.hit(x, y, !!FOES[foe.kind].heavy); return; }
    this.kill(foe, true);
  }

  private kill(foe: Foe, scored: boolean): void {
    if (foe.dead) return;
    foe.dead = true;
    this.stage.scene.remove(foe.mesh);
    const def = FOES[foe.kind];
    this.stage.fx.explosion(def.land ? v1.copy(foe.pos).setY(foe.pos.y + def.radius * 0.8) : foe.pos, def.blast);
    if (def.sea) this.stage.fx.splash(foe.pos, def.blast);
    const [x, y] = this.ear(foe.pos);
    this.run.audio.kill(x, y, foe.kind === 'boss' ? 'boss' : def.heavy ? 'tank' : foe.kind === 'drone' ? 'drone' : 'grunt');
    if (def.blast > 2) this.stage.shake(0.5);
    if (this.lockOn === foe) { this.lockOn = null; this.lockT = 0; }
    if (!scored) return;
    const gained = this.run.score(def.score);
    this.stage.float(foe.pos, `+${gained}`, '#ffe066');
    // The big ones leave supplies behind.
    if (def.heavy && !this.supply) this.dropSupply(foe.pos);
  }

  /** A shell bursts: everything within its reach is hit (but `spared`, which it has just hit itself). */
  private burstAt(at: Vector3, reach: number, damage: number, spared: Foe | null): void {
    const where = at.clone();
    this.stage.fx.explosion(where, 0.9);
    const [x, y] = this.ear(where);
    this.run.audio.boom(x, y);
    for (const foe of this.foes) {
      if (foe.dead || foe === spared) continue;
      if (foe.pos.distanceTo(where) < reach + FOES[foe.kind].radius) this.hitFoe(foe, damage, foe.pos);
    }
  }

  /** Does the segment a shot just flew pass within `radius` of a point? */
  private crosses(s: Shot, centre: Vector3, radius: number): boolean {
    v1.copy(s.pos).sub(s.prev);
    const length = v1.lengthSq();
    const k = length > 0 ? Math.max(0, Math.min(1, v2.copy(centre).sub(s.prev).dot(v1) / length)) : 0;
    return v2.copy(s.prev).addScaledVector(v1, k).distanceToSquared(centre) < radius * radius;
  }

  private stepShots(dt: number): void {
    const craft = this.craft;
    const world = this.stage.world;
    const fx = this.stage.fx;
    const streaks = this.streaks;
    streaks.length = 0;
    this.shots = this.shots.filter((s) => {
      s.life -= dt;
      s.prev.copy(s.pos);
      s.pos.addScaledVector(s.dir, s.speed * dt);
      if (s.life <= 0) return false;
      for (const foe of this.foes) {
        if (foe.dead) continue;
        const def = FOES[foe.kind];
        // What walks is hit anywhere up its body; a shell needs only to pass close.
        const centre = def.land ? v3.copy(foe.pos).setY(foe.pos.y + def.radius * 0.9) : foe.pos;
        if (!this.crosses(s, centre, def.radius + (s.splash ? 3.2 : 1.4))) continue;
        this.hitFoe(foe, s.damage, s.pos);
        if (s.splash) this.burstAt(s.pos, s.splash, s.damage * 0.6, foe);
        return false;
      }
      if (s.pos.y < world.groundAt(s.pos.x, s.pos.z)) {
        if (s.splash) this.burstAt(s.pos, s.splash, s.damage * 0.6, null);
        else if (s.pos.y < 1) { v1.copy(s.pos); v1.y = 0.4; fx.burst(v1, '#cfe0fb', 2, 18, { size: 1, life: 0.4, lift: 16 }); }
        return false;
      }
      streaks.push({ pos: s.pos, dir: s.dir, length: s.length, width: s.width, colour: SHOT_GOLD });
      return true;
    });
    const open = craft.live && !this.down && !craft.dodging;
    this.foeShots = this.foeShots.filter((s) => {
      s.life -= dt;
      s.prev.copy(s.pos);
      s.pos.addScaledVector(s.dir, s.speed * dt);
      if (s.life <= 0 || s.pos.y < world.groundAt(s.pos.x, s.pos.z)) return false;
      if (open && this.crosses(s, craft.pos, craft.radius)) {
        this.damage(s.damage, s.prev);
        return false;
      }
      // An orb, a brighter core: seen coming.
      streaks.push({ pos: s.pos, dir: s.dir, length: 3.2, width: 3.2, colour: SHOT_RED });
      streaks.push({ pos: s.pos, dir: s.dir, length: 4.4, width: 1.5, colour: SHOT_HOT });
      return true;
    });
    fx.streaks(streaks);
  }

  private stepMissiles(dt: number): void {
    const craft = this.craft;
    const world = this.stage.world;
    const fx = this.stage.fx;
    const alive = craft.live && !this.down;
    this.missilesOut = this.missilesOut.filter((m) => {
      m.life -= dt;
      let blow = m.life <= 0;
      // What it chases, and whether it still can.
      let aim: Vector3 | null = null;
      let radius = 0;
      if (m.target === 'player') {
        if (!alive) m.target = null;
        else {
          const dist = m.pos.distanceTo(craft.pos);
          // A barrel roll, flares: at the right moment it flies on, blind.
          if (craft.masked && dist < 440) { m.target = null; this.stage.float(m.pos, 'DODGED', '#35d0c7'); }
          else { aim = craft.pos; radius = craft.radius + 1.5; }
        }
      } else if (m.target) {
        if (m.target.dead) m.target = null;
        else { aim = m.target.pos; radius = FOES[m.target.kind].radius + 2; }
      }
      m.speed = Math.min(m.mine ? 330 : 172, m.speed + (m.mine ? 260 : 60) * dt);
      if (aim) {
        v1.copy(aim).sub(m.pos);
        const dist = v1.length() || 1;
        // Toward where the target will be.
        if (m.target !== 'player' && m.target) v1.addScaledVector(m.target.vel, dist / m.speed);
        else v1.addScaledVector(craft.vel, (dist / m.speed) * 0.6);
        v1.normalize();
        const angle = Math.acos(Math.max(-1, Math.min(1, m.dir.dot(v1))));
        if (angle > 1e-3) m.dir.lerp(v1, Math.min(1, ((m.mine ? 3.2 : 1.15) * dt) / angle)).normalize();
        if (dist < radius + m.speed * dt) blow = true;
      }
      m.pos.addScaledVector(m.dir, m.speed * dt);
      if (m.pos.y < world.groundAt(m.pos.x, m.pos.z) + 0.5) blow = true;
      m.smokeIn -= dt;
      if (m.smokeIn <= 0) {
        m.smokeIn = 0.028;
        v1.copy(m.pos).addScaledVector(m.dir, -2.6);
        fx.puff(v1, m.mine ? '#cfd6e6' : '#ff8a6b', 1.7, 0.75);
      }
      m.mesh.position.copy(m.pos);
      m.mesh.lookAt(v1.copy(m.pos).add(m.dir));
      if (!blow) return true;

      this.stage.scene.remove(m.mesh);
      fx.explosion(m.pos, 1.5);
      const [x, y] = this.ear(m.pos);
      this.run.audio.boom(x, y);
      if (m.mine) {
        // Everything in the blast takes it; the one it was after, in full.
        for (const foe of [...this.foes]) {
          const d = foe.pos.distanceTo(m.pos) - FOES[foe.kind].radius;
          if (d < 34) this.hitFoe(foe, foe === m.target ? 16 : 7, foe.pos);
        }
      } else if (alive && m.pos.distanceTo(craft.pos) < craft.radius + 12) this.damage(22, m.pos);
      return false;
    });
  }

  /** A crate under a balloon: over the land, over the sea — for a boat, low enough to sail through. */
  private dropSupply(near: Vector3): void {
    const mesh = instance(skyModels().supply);
    this.stage.scene.add(mesh);
    const pos = near.clone();
    const world = this.stage.world;
    if (this.craft.kind === 'boat') {
      // On the water, clear of the land.
      for (let i = 0; i < 12 && world.groundAt(pos.x, pos.z) > 0; i += 1) pos.addScaledVector(v1.set(pos.x, 0, pos.z).normalize(), 30);
      pos.y = 5;
    } else if (this.craft.kind === 'tank') {
      // On the ground it drives on: back toward the tank if that fell in the sea.
      for (let i = 0; i < 12 && world.mainland.heightAt(pos.x, pos.z) < 1; i += 1) pos.lerp(this.craft.pos, 0.3);
      pos.y = Math.max(0, world.mainland.heightAt(pos.x, pos.z)) + 5;
    } else pos.y = Math.max(world.groundAt(pos.x, pos.z) + 70, Math.min(360, pos.y));
    this.supply = { mesh, pos, life: 40, t: 0 };
  }

  private stepSupply(dt: number): void {
    const s = this.supply;
    if (!s) return;
    s.life -= dt;
    s.t += dt;
    // It comes down to what the machine has become: within reach of a hull as of wings.
    if (this.craft.kind !== 'plane') s.pos.y += (this.stage.world.groundAt(s.pos.x, s.pos.z) + 5 - s.pos.y) * (1 - Math.exp(-1.2 * dt));
    s.mesh.position.copy(s.pos);
    s.mesh.position.y += Math.sin(s.t * 1.6) * (this.craft.kind === 'boat' ? 0.6 : 3);
    s.mesh.rotation.y = s.t * 0.7;
    const taken = this.craft.live && !this.down && s.mesh.position.distanceTo(this.craft.pos) < 26;
    if (taken) {
      this.hull = Math.min(MAX_HULL, this.hull + 70);
      this.missiles = MAX_MISSILES;
      this.missileIn = 0;
      this.run.audio.pickup('med');
      this.stage.fx.burst(s.mesh.position, '#35d0c7', 26, 70, { size: 1.6, life: 0.7, gravity: 20 });
      this.stage.fx.flash(s.mesh.position, '#35d0c7', 70, 0.4);
      this.stage.float(s.pos, '+', '#35d0c7');
    }
    if (taken || s.life <= 0) {
      this.stage.scene.remove(s.mesh);
      this.supply = null;
    }
  }

  /* ──────────────────────────────────────────────────────── waves ─── */

  private stepDirector(dt: number): void {
    if (!this.waveOn) {
      this.waitIn -= dt;
      if (this.waitIn <= 0) this.startWave();
      return;
    }
    this.waveT += dt;
    while (this.queue.length && this.queue[0].at <= this.waveT && this.foes.length < 26) this.spawnOne(this.queue.shift()!);
    if (!this.queue.length && !this.foes.length) {
      this.waveOn = false;
      this.waitIn = 5;
      this.run.cleared();
      // Supplies, ahead of the vehicle.
      if (!this.supply) {
        const c = this.craft;
        v1.copy(c.fwd).setY(0).normalize().multiplyScalar(c.kind === 'plane' ? 430 : c.kind === 'boat' ? 240 : 150).add(c.pos);
        const far = Math.hypot(v1.x, v1.z);
        const edge = this.stage.world.radius - 200;
        if (far > edge) v1.multiplyScalar(edge / far);
        v1.y = c.pos.y;
        this.dropSupply(v1);
      }
    }
  }

  /** A place for newcomers: ahead of the machine, more or less; on the water for what sails, on the mainland for what walks. */
  private spawnPoint(kind: FoeKind, out: Vector3): Vector3 {
    const c = this.craft;
    const world = this.stage.world;
    const def = FOES[kind];
    const heading = Math.atan2(c.fwd.x, c.fwd.z);
    for (let i = 0; i < 14; i += 1) {
      const a = heading + (Math.random() - 0.5) * (def.sea || def.land ? 3.4 + i * 0.2 : 2.6);
      const d = def.land ? 170 + Math.random() * 120 : def.sea ? 360 + Math.random() * 160 : 640 + Math.random() * 140;
      out.set(c.pos.x + Math.sin(a) * d, 0, c.pos.z + Math.cos(a) * d);
      const far = Math.hypot(out.x, out.z);
      if (far > world.radius) out.multiplyScalar(world.radius / far);
      if (def.land ? world.mainland.heightAt(out.x, out.z) > 1.2 : !def.sea || world.groundAt(out.x, out.z) <= 0) break;
    }
    out.y = def.land ? Math.max(0, world.mainland.heightAt(out.x, out.z)) : def.sea ? 0
      : this.ctx.afloat ? world.groundAt(out.x, out.z) + 60 + Math.random() * 90 : Math.max(world.groundAt(out.x, out.z) + 100, Math.min(430, c.pos.y + (Math.random() - 0.5) * 180));
    return out;
  }

  private startWave(): void {
    const { n, boss } = this.run.nextWave();
    this.waveN = n;
    this.waveOn = true;
    this.compose(n, boss, this.budget(n, boss));
  }

  /** What wave `n` is worth, in robots' costs. */
  private budget(n: number, boss: boolean): number {
    // A boss comes with few around it: it is the fight.
    return Math.max(3.5, 4 + (n - FIRST_RIDE_WAVE) * 1.8) * (boss ? 0.3 : 1);
  }

  /** Robots of wave `n` worth `budget`, queued to come. */
  private compose(n: number, boss: boolean, budget: number): void {
    this.waveT = 0;
    this.queue = [];
    const pool = POOLS[this.craft.kind].filter((k) => FOES[k].from <= n);
    const picked: FoeKind[] = [];
    while (budget > 0.4 && picked.length < 40) {
      const fits = pool.filter((k) => FOES[k].cost <= budget + 0.5);
      if (!fits.length) break;
      let roll = Math.random() * fits.reduce((sum, k) => sum + FOES[k].weight, 0);
      let kind = fits[0];
      for (const k of fits) { roll -= FOES[k].weight; if (roll <= 0) { kind = k; break; } }
      picked.push(kind);
      budget -= FOES[kind].cost;
    }
    // They come in flights of their own kind, one flight after the other.
    let at = 0.6;
    for (const kind of pool) {
      const count = picked.filter((k) => k === kind).length;
      for (let i = 0; i < count; i += FLIGHT_OF[kind]) {
        const of = Math.min(FLIGHT_OF[kind], count - i);
        const lead = this.spawnPoint(kind, new Vector3());
        for (let slot = 0; slot < of; slot += 1) this.queue.push({ at, kind, lead, slot, of });
        at += 2.4;
      }
    }
    if (boss) {
      // The dreadnought rises on the far side of where the fight is.
      const a = Math.atan2(this.craft.fwd.x, this.craft.fwd.z);
      const at = new Vector3(this.centre.x + Math.sin(a) * 330, 0, this.centre.z + Math.cos(a) * 330);
      at.y = this.stage.world.groundAt(at.x, at.z) + (this.ctx.afloat ? 150 : 250);
      this.queue.push({ at: 1.5, kind: 'boss', lead: at, slot: 0, of: 1 });
      this.queue.sort((p, q) => p.at - q.at);
    }
  }

  private spawnOne(q: Queued): void {
    // The machine may have changed shape, or gone far, since the wave was drawn up.
    const kind = this.fit(q.kind);
    const def = FOES[kind];
    const world = this.stage.world;
    const stale = kind !== q.kind || (kind !== 'boss' && Math.hypot(q.lead.x - this.craft.pos.x, q.lead.z - this.craft.pos.z) > (def.land ? 420 : 1100))
      || (def.land && world.mainland.heightAt(q.lead.x, q.lead.z) < 1.2);
    if (stale) this.spawnPoint(kind, q.lead);
    v1.copy(this.craft.pos).sub(q.lead).setY(0).normalize();
    // A V behind its leader.
    v2.set(v1.z, 0, -v1.x);
    const rank = q.slot - (q.of - 1) / 2;
    const at = q.lead.clone().addScaledVector(v2, rank * (def.land ? 14 : 26)).addScaledVector(v1, -Math.abs(rank) * (def.land ? 10 : 18));
    if (def.land) {
      if (world.mainland.heightAt(at.x, at.z) < 1) at.copy(q.lead);
      at.y = Math.max(0, world.mainland.heightAt(at.x, at.z));
    } else if (!def.sea) at.y += Math.abs(rank) * 6;
    this.addFoe(kind, at, v1);
    if (kind === 'boss') {
      this.run.audio.megaBoom();
      this.stage.shake(0.6);
    } else if (q.slot === 0) {
      const [x, y] = this.ear(at);
      this.run.audio.alert(x, y);
    }
  }

  /* ─────────────────────────────────────────────────── instruments ─── */

  /** What the instruments show this frame. */
  frame(): HudFrame {
    const stage = this.stage;
    const craft = this.craft;
    const focal = stage.focal();
    const p: StagePoint = { x: 0, y: 0, shown: false, depth: 0 };
    const marks: Mark[] = [];
    const blips: HudFrame['radar']['blips'] = [];
    for (const foe of this.foes) {
      stage.onStage(foe.pos, p);
      const def = FOES[foe.kind];
      marks.push({
        x: p.x, y: p.y, shown: p.shown, r: (def.radius * focal) / Math.max(1, p.depth), dist: foe.pos.distanceTo(craft.pos),
        kind: def.heavy ? 'big' : 'foe', hp: def.heavy || foe.hp < foe.maxHp ? foe.hp / foe.maxHp : null,
      });
      blips.push({ x: foe.pos.x - craft.pos.x, z: foe.pos.z - craft.pos.z, kind: def.heavy ? 'big' : 'foe' });
    }
    if (this.supply) {
      stage.onStage(this.supply.mesh.position, p);
      marks.push({ x: p.x, y: p.y, shown: p.shown, r: (9 * focal) / Math.max(1, p.depth), dist: this.supply.pos.distanceTo(craft.pos), kind: 'supply', hp: null });
      blips.push({ x: this.supply.pos.x - craft.pos.x, z: this.supply.pos.z - craft.pos.z, kind: 'supply' });
    }
    this.marks = marks;
    const live = craft.live && !this.down;
    let lock: HudFrame['lock'] = null;
    if (this.lockOn && live) {
      stage.onStage(this.lockOn.pos, p);
      if (p.shown) lock = { x: p.x, y: p.y, r: (FOES[this.lockOn.kind].radius * focal) / Math.max(1, p.depth), k: this.lockT };
    }
    let threat: HudFrame['threat'] = null;
    let nearest = Infinity;
    for (const m of this.missilesOut) {
      if (m.target !== 'player') continue;
      blips.push({ x: m.pos.x - craft.pos.x, z: m.pos.z - craft.pos.z, kind: 'missile' });
      const d = m.pos.distanceTo(craft.pos);
      if (d >= nearest) continue;
      nearest = d;
      stage.onStage(m.pos, p);
      threat = { x: p.x, y: p.y, shown: p.shown };
    }
    let sight: HudFrame['sight'] = null;
    stage.onStage(craft.muzzle(0, v3).addScaledVector(craft.aim, 340), p);
    if (p.depth > 1) sight = { x: p.x, y: p.y };

    const input = this.input;
    const key = (code: string) => input.label(code);
    const plane = craft.kind === 'plane';
    // The mainland, while the machine is not on it: where it becomes the tank.
    const land = stage.world.mainland;
    if (craft.kind !== 'tank' && land.heightAt(craft.pos.x, craft.pos.z) < 0) {
      // Its nearest shore, more or less: toward its middle, as far as its edge.
      v3.set(land.x - craft.pos.x, 0, land.z - craft.pos.z);
      const away = Math.max(0, Math.hypot(v3.x / land.rx, v3.z / land.rz) - 1);
      const far = v3.length() || 1;
      v3.multiplyScalar(Math.min(1, (away * Math.min(land.rx, land.rz) + 60) / far)).add(craft.pos).setY(14);
      stage.onStage(v3, p);
      marks.push({ x: p.x, y: p.y, shown: p.shown, r: 0, dist: v3.distanceTo(craft.pos), kind: 'tank', hp: null });
    }
    const g = craft.gauges(stage);
    const yaw = Math.atan2(craft.fwd.x, craft.fwd.z);
    return {
      time: this.time, live, brackets: true, sight, hot: this.hot != null,
      ring: plane && input.device === 'pointer' && input.pointer ? input.pointer : null,
      marks, lock, threat, warn: live ? this.warn : null,
      dials: {
        speed: g.speed, alt: g.alt, power: g.power, fast: g.boosting, boost: g.boost, boostDry: g.boostDry,
        heat: this.heat, jammed: this.jammed, missiles: this.missiles, maxMissiles: MAX_MISSILES,
      },
      hurt: this.hurt, hurtFrom: this.hurtFrom,
      radar: {
        yaw, range: plane ? 900 : 500, blips,
        isles: [
          ...stage.world.isles.map((i) => ({ x: i.x - craft.pos.x, z: i.z - craft.pos.z, hw: i.hw, hd: i.hd })),
          { x: land.x - craft.pos.x, z: land.z - craft.pos.z, hw: land.rx * 0.92, hd: land.rz * 0.92 },
        ],
        homeX: -craft.pos.x, homeZ: -craft.pos.z,
      },
      floats: stage.floatsOnStage(), rollKeys: [key('KeyQ'), key('KeyE')],
    };
  }
}
