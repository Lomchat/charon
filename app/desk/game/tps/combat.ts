// The fight around a vehicle — the seaplane or the gunboat: its guns and its
// missiles, the robots that come for it and what they throw, the waves, the
// supplies, and what the instruments show. The vehicle itself (how it moves,
// where it points, where the eye sits) is a `Craft`.
import { Color, Vector3, type Group } from 'three';
import type { Craft, CraftEnv } from './craft';
import { FLIGHT_OF, FOES, makeFoe, POOLS, stepFoe, type Foe, type FoeCtx, type FoeKind } from './foes';
import type { Streak } from './fx';
import type { HudFrame, Mark } from './hud';
import type { Input } from './input';
import { skyModels } from './models';
import type { TpsRun } from './run';
import type { Rig, Stage, StagePoint } from './stage';
import { instance } from './voxels';

type Shot = { pos: Vector3; prev: Vector3; dir: Vector3; speed: number; life: number; damage: number };
type Missile = {
  mesh: Group; pos: Vector3; dir: Vector3; speed: number; life: number; smokeIn: number;
  /** A robot, the player, or nothing (it flies straight). */
  target: Foe | 'player' | null;
  mine: boolean;
};
type Supply = { mesh: Group; pos: Vector3; life: number; t: number };
type Queued = { at: number; kind: FoeKind; lead: Vector3; slot: number; of: number };

const MAX_HULL = 100;
const MAX_MISSILES = 6;
const GUN_RANGE = 660;
const LOCK_RANGE = 760;
const SHOT_GOLD = new Color('#ffe066');
const SHOT_RED = new Color('#ff5d5d');
const SHOT_HOT = new Color('#ffb86b');

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

  /**
   * `wave`: one was under way when the pilot boarded. It goes on around the
   * vehicle: what stood on the island comes after it (`adopt`), and the
   * `share` the wave had not sent yet comes as robots a vehicle fights.
   */
  constructor(
    private stage: Stage, private run: TpsRun, readonly craft: Craft, private input: Input,
    wave: { share: number; boss: boolean } | null, adopt: Array<{ kind: FoeKind; at: Vector3 }>,
  ) {
    this.waveN = run.wave();
    this.waveOn = wave != null;
    this.ctx = {
      target: craft, velocity: craft.vel, afloat: craft.kind === 'boat', wave: this.waveN, locked: null, foes: 0,
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
    for (const a of adopt) this.addFoe(a.kind, a.at, v3.copy(craft.pos).sub(a.at));
    if (wave) this.compose(this.waveN, wave.boss, wave.share);
  }

  dispose(): void {
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
    const craft = this.craft;
    this.time += dt;
    this.safe = Math.max(0, this.safe - dt);
    this.hurt = Math.max(0, this.hurt - dt * 1.4);
    this.warn = null;
    craft.step(dt, this.env);
    const fighting = craft.live && !this.down;
    if (fighting) { this.liveT += dt; this.stepWeapons(dt); }
    this.stepFoes(dt);
    this.stepShots(dt);
    this.stepMissiles(dt);
    this.stepSupply(dt);
    if (fighting) this.stepDirector(dt);
    // Hurt, it smokes.
    if (fighting && this.hull < 40 && Math.random() < (this.hull < 20 ? 0.7 : 0.35)) {
      v1.copy(craft.pos).addScaledVector(craft.fwd, 3);
      this.stage.fx.puff(v1, this.hull < 20 ? '#1c2230' : '#343c50', 2.6, 1.1, 0, 6, 0);
    }
  }

  rig(dt: number, out: Rig): void {
    this.craft.rig(dt, this.stage, out);
  }

  /** The vehicle takes `amount`; from where, if it came from somewhere. `hard` = whatever it is doing. */
  private damage(amount: number, from: Vector3 | null, hard = false): void {
    if (this.down || !this.craft.live) return;
    if (this.safe > 0 || (!hard && this.craft.dodging)) return;
    this.hull -= amount;
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
    const firing = this.input.firing && !this.jammed;
    if (firing && this.gunIn <= 0) {
      this.gunIn = 1 / 15;
      this.gunSide = -this.gunSide;
      const speed = 560 + craft.vel.length();
      craft.muzzle(this.gunSide, v2);
      if (hot) {
        const t = v1.copy(hot.pos).sub(v2).length() / speed;
        v1.copy(hot.pos).addScaledVector(hot.vel, t).sub(v2).normalize();
      } else v1.copy(craft.pos).addScaledVector(craft.aim, 340).sub(v2).normalize();
      v1.x += (Math.random() - 0.5) * 0.012; v1.y += (Math.random() - 0.5) * 0.012; v1.z += (Math.random() - 0.5) * 0.012;
      this.shots.push({ pos: v2.clone(), prev: v2.clone(), dir: v1.clone().normalize(), speed, life: GUN_RANGE / speed, damage: 1 });
      this.stage.fx.flash(v2, '#fff3c9', 7, 0.05);
      this.heat = Math.min(1, this.heat + 0.021);
      if (this.heat >= 1) { this.jammed = true; audio.jam(); }
      audio.cannon();
    }
    if (!firing) this.heat = Math.max(0, this.heat - dt * 0.5);
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
    this.foeShots.push({ pos: from.clone(), prev: from.clone(), dir: dir.clone(), speed, life: 3.4, damage });
    const [x, y] = this.ear(from);
    this.run.audio.foeShot(x, y);
  }

  private addFoe(kind: FoeKind, at: Vector3, heading: Vector3): void {
    const mesh = instance(skyModels()[kind]);
    this.stage.scene.add(mesh);
    const foe = makeFoe(kind, mesh, at, heading, this.waveN);
    mesh.position.copy(foe.pos);
    this.foes.push(foe);
  }

  private stepFoes(dt: number): void {
    const craft = this.craft;
    this.ctx.wave = this.waveN;
    this.ctx.foes = this.foes.length;
    const fx = this.stage.fx;
    for (const foe of this.foes) {
      const def = FOES[foe.kind];
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
    this.stage.fx.explosion(foe.pos, def.blast);
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
        if (foe.dead || !this.crosses(s, foe.pos, FOES[foe.kind].radius + 1.4)) continue;
        this.hitFoe(foe, s.damage, s.pos);
        return false;
      }
      if (s.pos.y < world.groundAt(s.pos.x, s.pos.z)) {
        if (s.pos.y < 1) { v1.copy(s.pos); v1.y = 0.4; fx.burst(v1, '#cfe0fb', 2, 18, { size: 1, life: 0.4, lift: 16 }); }
        return false;
      }
      streaks.push({ pos: s.pos, dir: s.dir, length: 9, width: 0.55, colour: SHOT_GOLD });
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
    if (this.craft.kind === 'boat') {
      // On the water, clear of the land.
      for (let i = 0; i < 12 && this.stage.world.groundAt(pos.x, pos.z) > 0; i += 1) pos.addScaledVector(v1.set(pos.x, 0, pos.z).normalize(), 30);
      pos.y = 5;
    } else pos.y = Math.max(this.stage.world.groundAt(pos.x, pos.z) + 70, Math.min(360, pos.y));
    this.supply = { mesh, pos, life: 40, t: 0 };
  }

  private stepSupply(dt: number): void {
    const s = this.supply;
    if (!s) return;
    s.life -= dt;
    s.t += dt;
    s.mesh.position.copy(s.pos);
    s.mesh.position.y += Math.sin(s.t * 1.6) * (this.craft.kind === 'boat' ? 0.6 : 3);
    s.mesh.rotation.y = s.t * 0.7;
    const taken = this.craft.live && !this.down && s.mesh.position.distanceTo(this.craft.pos) < 26;
    if (taken) {
      this.hull = Math.min(MAX_HULL, this.hull + 40);
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
        v1.copy(c.fwd).setY(0).normalize().multiplyScalar(this.craft.kind === 'boat' ? 240 : 430).add(c.pos);
        const far = Math.hypot(v1.x, v1.z);
        const edge = this.stage.world.radius - 200;
        if (far > edge) v1.multiplyScalar(edge / far);
        v1.y = c.pos.y;
        this.dropSupply(v1);
      }
    }
  }

  /** A place for newcomers: ahead of the player, more or less; on the water for what sails. */
  private spawnPoint(kind: FoeKind, out: Vector3): Vector3 {
    const c = this.craft;
    const world = this.stage.world;
    const sea = !!FOES[kind].sea;
    const heading = Math.atan2(c.fwd.x, c.fwd.z);
    for (let i = 0; i < 10; i += 1) {
      const a = heading + (Math.random() - 0.5) * (sea ? 3.4 : 2.6);
      const d = sea ? 360 + Math.random() * 160 : 640 + Math.random() * 140;
      out.set(c.pos.x + Math.sin(a) * d, 0, c.pos.z + Math.cos(a) * d);
      const far = Math.hypot(out.x, out.z);
      if (far > world.radius) out.multiplyScalar(world.radius / far);
      if (!sea || world.groundAt(out.x, out.z) <= 0) break;
    }
    out.y = sea ? 0 : this.ctx.afloat ? 60 + Math.random() * 90 : Math.max(100, Math.min(430, c.pos.y + (Math.random() - 0.5) * 180));
    return out;
  }

  private startWave(): void {
    const { n, boss } = this.run.nextWave();
    this.waveN = n;
    this.waveOn = true;
    this.compose(n, boss, 1);
  }

  /** Wave `n`'s robots, or the `share` of them still owed, queued to come. */
  private compose(n: number, boss: boolean, share: number): void {
    this.waveT = 0;
    this.queue = [];
    let budget = Math.max(4, 5 + (n - 5) * 2.4) * (boss ? 0.5 : 1) * share;
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
      // The dreadnought rises on the far side of the home island.
      const a = Math.atan2(this.craft.pos.x, this.craft.pos.z) + Math.PI;
      this.queue.push({ at: 1.5, kind: 'boss', lead: new Vector3(Math.sin(a) * 330, this.ctx.afloat ? 150 : 250, Math.cos(a) * 330), slot: 0, of: 1 });
      this.queue.sort((p, q) => p.at - q.at);
    }
  }

  private spawnOne(q: Queued): void {
    v1.copy(this.craft.pos).sub(q.lead).setY(0).normalize();
    // A V behind its leader.
    v2.set(v1.z, 0, -v1.x);
    const rank = q.slot - (q.of - 1) / 2;
    const at = q.lead.clone().addScaledVector(v2, rank * 26).addScaledVector(v1, -Math.abs(rank) * 18);
    if (!FOES[q.kind].sea) at.y += Math.abs(rank) * 6;
    this.addFoe(q.kind, at, v1);
    if (q.kind === 'boss') {
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
    const hints: HudFrame['hints'] = live && this.liveT < 12 && this.waveN <= 6 ? (plane ? [
      { keys: [key('KeyW'), key('KeyA'), key('KeyS'), key('KeyD')], mouse: 'move', word: 'FLY' },
      { keys: ['SPACE'], mouse: 'left', word: 'CANNON' },
      { keys: [key('KeyF')], mouse: 'right', word: 'MISSILE' },
      { keys: [key('KeyQ'), key('KeyE')], word: 'ROLL' },
      { keys: ['SHIFT'], word: 'BOOST' },
      { keys: [key('KeyX')], word: 'BRAKE' },
      { keys: [key('KeyI')], word: input.invert ? 'UP = CLIMB' : 'DOWN = CLIMB' },
    ] : [
      { keys: [key('KeyW'), key('KeyA'), key('KeyS'), key('KeyD')], word: 'HELM' },
      { keys: [], mouse: 'move', word: 'AIM' },
      { keys: ['SPACE'], mouse: 'left', word: 'CANNON' },
      { keys: [key('KeyF')], mouse: 'right', word: 'MISSILE' },
      { keys: [key('KeyQ'), key('KeyE')], word: 'FLARES' },
      { keys: ['SHIFT'], word: 'BOOST' },
    ]) : null;
    const g = craft.gauges(stage);
    const yaw = Math.atan2(craft.fwd.x, craft.fwd.z);
    return {
      time: this.time, live, brackets: true, sight, hot: this.hot != null,
      ring: plane && input.device === 'pointer' && input.pointer ? input.pointer : null,
      marks, lock, threat, warn: live ? this.warn : null,
      dials: { speed: g.speed, alt: g.alt, fast: g.boosting, boost: g.boost, boostDry: g.boostDry, heat: this.heat, jammed: this.jammed, missiles: this.missiles, maxMissiles: MAX_MISSILES },
      hurt: this.hurt, hurtFrom: this.hurtFrom,
      radar: {
        yaw, range: plane ? 900 : 500, blips,
        isles: stage.world.isles.map((i) => ({ x: i.x - craft.pos.x, z: i.z - craft.pos.z, hw: i.hw, hd: i.hd })),
        homeX: -craft.pos.x, homeZ: -craft.pos.z,
      },
      floats: stage.floatsOnStage(), hints, rollKeys: [key('KeyQ'), key('KeyE')],
    };
  }
}
