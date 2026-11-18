// The gunboat — the machine's shape on the water: how it comes in and waits by
// the island, casts off, sails under the pilot's hand, and where the eye sits
// behind it. Run onto the mainland's beach, it becomes the tank (`takeTurn`).
//
// A helm and a turret: W / S for the engine, A / D for the rudder; the mouse
// turns the view, and the turret points where the view does. Q or E throws
// flares: a missile on its way loses the boat.
import { Euler, Quaternion, Vector3, type Group } from 'three';
import type { Form } from '../forms';
import { MACHINE_GUN, type Craft, type CraftEnv, type CraftState, type Gauges } from './craft';
import { DATUM, TURRET, type Machine } from './machine';
import type { Rig, Stage } from './stage';

const TOP_SPEED = 46;
const BOOST = 2.3;
const RADIUS = 7;
/** Seconds it takes to come in and moor. */
const ARRIVAL = 5.5;
const FLARE_TIME = 1.6;
const FLARE_WAIT = 5;

const v1 = new Vector3();
const euler = new Euler();
const look = { x: 0, y: 0 };

export class Boat implements Craft {
  readonly kind = 'boat';
  readonly mesh: Group;
  readonly rootPos = new Vector3();
  readonly rootQuat = new Quaternion();
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly fwd = new Vector3(0, 0, 1);
  readonly aim = new Vector3(0, 0, 1);
  readonly radius = RADIUS;
  readonly gun = MACHINE_GUN;
  readonly gate: Vector3;
  private phase: 'in' | 'moored' | 'run' | 'held' | 'live' | 'down' = 'in';
  private turn: Form | null = null;
  private t = 0;
  private yaw: number;
  private speed = 0;
  private lean = 0;
  /** The view, relative to the bow: the mouse turns it, the boat carries it round. */
  private lookYaw = 0;
  private lookPitch = 0.16;
  private boost = 1;
  private boostDry = false;
  private boosting = false;
  private flare = 0;
  private flareIn = 0;
  private fov = 62;

  constructor(stage: Stage, readonly machine: Machine, private dock: { x: number; z: number; yaw: number }, gate: Vector3) {
    this.mesh = machine.root;
    this.gate = gate.clone();
    this.yaw = dock.yaw;
    if (!this.mesh.parent) stage.scene.add(this.mesh);
    this.idle(0, stage);
  }

  get moored(): boolean { return this.phase === 'moored'; }
  get live(): boolean { return this.phase === 'live'; }
  get dodging(): boolean { return false; }
  get masked(): boolean { return this.flare > 0; }

  muzzle(side: number, out: Vector3): Vector3 {
    this.machine.pivot(out).addScaledVector(this.aim, TURRET.boat.reach);
    out.y += TURRET.boat.gun;
    if (side) out.addScaledVector(v1.set(-this.aim.z, 0, this.aim.x).normalize(), -0.65 * side);
    return out;
  }

  seat(out: Vector3): Vector3 {
    return out.copy(this.pos).addScaledVector(this.fwd, 0.3).setY(this.pos.y + 3.4);
  }

  moor(): void {
    this.phase = 'moored';
    this.t = 0;
  }

  takeTurn(): Form | null {
    const turn = this.turn;
    this.turn = null;
    return turn;
  }

  state(): CraftState {
    return { pos: this.pos.clone(), yaw: this.yaw, speed: this.speed, boost: this.boost, boostDry: this.boostDry };
  }

  hold(state: CraftState, stage: Stage): void {
    if (this.phase !== 'held') { this.lookYaw = 0; this.lookPitch = 0.16; this.lean = 0; }
    this.phase = 'held';
    this.pos.copy(state.pos);
    this.yaw = state.yaw;
    this.speed = Math.max(-TOP_SPEED * 0.4, Math.min(TOP_SPEED * BOOST, state.speed));
    this.boost = state.boost; this.boostDry = state.boostDry; this.boosting = false;
    this.aim.copy(this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)));
    this.vel.copy(this.fwd).multiplyScalar(this.speed);
    this.place(0, stage);
  }

  release(): void {
    this.phase = 'live';
    this.machine.set('boat');
    this.turn = null;
  }

  idle(dt: number, stage: Stage): void {
    this.t += dt;
    if (this.phase === 'in') {
      // In from the open sea, along the way it will lie, slower and slower.
      const k = Math.min(1, this.t / ARRIVAL);
      const back = (1 - k) * (1 - k) * 300;
      this.pos.set(this.dock.x - Math.sin(this.yaw) * back, 0, this.dock.z - Math.cos(this.yaw) * back);
      this.speed = (1 - k) * TOP_SPEED;
      if (k >= 1) this.moor();
    } else {
      this.pos.set(this.dock.x, 0, this.dock.z);
      this.speed = 0;
    }
    this.aim.copy(this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)));
    this.place(dt, stage);
  }

  cast(): void {
    this.phase = 'run';
    this.t = 0;
  }

  step(dt: number, env: CraftEnv): void {
    const { stage, input } = env;
    this.t += dt;
    if (this.phase === 'down' || this.phase === 'held') return;
    const live = this.phase === 'live';
    if (this.phase === 'run' && this.t > 0.9) this.phase = 'live';

    // The view: the mouse turns it (captured), or leans it to the side it is on; the arrows too.
    input.takeLook(look);
    if (input.locked) {
      this.lookYaw -= look.x * 0.0026;
      this.lookPitch += look.y * 0.002;
    } else {
      input.offset(look);
      if (Math.abs(look.x) > 0.14) this.lookYaw -= Math.sign(look.x) * Math.min(1, (Math.abs(look.x) - 0.14) / 0.6) * 2 * dt;
      this.lookPitch += (0.16 + look.y * 0.5 - this.lookPitch) * (1 - Math.exp(-3 * dt));
    }
    this.lookYaw -= input.arrowX * 1.8 * dt;
    this.lookPitch -= input.arrowY * 0.9 * dt;
    this.lookPitch = Math.max(-0.55, Math.min(0.5, this.lookPitch));
    this.lookYaw = Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw));

    // The engine: a tank of boost on top of it.
    if (this.boostDry && this.boost >= 0.33) this.boostDry = false;
    this.boosting = live && input.boost && !this.boostDry && this.boost > 0 && input.ahead > 0;
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - dt / 3);
      if (this.boost <= 0) this.boostDry = true;
    } else this.boost = Math.min(1, this.boost + dt / 5);
    const ahead = live ? input.ahead : this.phase === 'run' ? 1 : 0;
    const want = ahead > 0 ? TOP_SPEED * (this.boosting ? BOOST : 1) : ahead < 0 ? -TOP_SPEED * 0.4 : 0;
    this.speed += (want - this.speed) * (1 - Math.exp(-(ahead ? 1.1 : 0.5) * dt));

    // The rudder bites with the way on: none at rest, all of it at speed.
    const way = Math.min(1, Math.abs(this.speed) / (TOP_SPEED * 0.5));
    const helm = live ? input.side : 0;
    const turned = helm * 1.05 * (0.25 + 0.75 * way) * (this.speed < 0 ? -1 : 1) * dt;
    this.yaw -= turned;
    // The view stays where it looked: the bow turns under it… a little, then carries it.
    this.lookYaw += turned * 0.35;
    this.lean += (helm * way * 0.2 - this.lean) * (1 - Math.exp(-4 * dt));
    this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // The land stops it, hard if it came fast.
    const nx = this.pos.x + this.fwd.x * this.speed * dt;
    const nz = this.pos.z + this.fwd.z * this.speed * dt;
    const bow = Math.sign(this.speed || 1) * 11;
    // The mainland's beach shelves up under it: no wall there — its keel touches, it becomes the tank.
    if (live && stage.world.mainland.heightAt(nx + this.fwd.x * bow * 0.6, nz + this.fwd.z * bow * 0.6) > -0.5) {
      this.pos.x = nx;
      this.pos.z = nz;
      this.turn = 'tank';
    } else if (stage.world.groundAt(nx + this.fwd.x * bow, nz + this.fwd.z * bow) > 0) {
      if (Math.abs(this.speed) > 16) {
        v1.set(nx + this.fwd.x * bow, 1.5, nz + this.fwd.z * bow);
        stage.fx.burst(v1, '#ffb86b', 14, 50, { size: 1.3, life: 0.5 });
        env.damage(Math.abs(this.speed) > 60 ? 16 : 8, null, true);
        env.audio.crash(false);
      }
      this.speed *= -0.3;
    } else {
      this.pos.x = nx;
      this.pos.z = nz;
    }
    // The edge of the fight: the sea pushes it back.
    const far = Math.hypot(this.pos.x, this.pos.z);
    if (far > stage.world.radius) {
      this.pos.x *= stage.world.radius / far;
      this.pos.z *= stage.world.radius / far;
      env.warn('TURN BACK');
    }
    this.vel.copy(this.fwd).multiplyScalar(this.speed);

    // Flares.
    this.flare = Math.max(0, this.flare - dt);
    this.flareIn = Math.max(0, this.flareIn - dt);
    if (input.takeRoll() && live && this.flareIn <= 0) {
      this.flare = FLARE_TIME;
      this.flareIn = FLARE_WAIT;
      env.audio.roll();
      for (let i = 0; i < 10; i += 1) {
        v1.copy(this.pos).setY(4);
        stage.fx.burst(v1, i % 2 ? '#fff3c9' : '#ffb86b', 2, 46, { size: 1.6, life: 1.3, gravity: 26, lift: 40, drag: 1.4 });
      }
      stage.fx.flash(v1, '#fff3c9', 46, 0.5);
    }

    this.place(dt, stage);
    // The turret points where the view does: at what is under the sight.
    const yaw = this.yaw + this.lookYaw;
    const cp = Math.cos(this.lookPitch);
    v1.set(Math.sin(yaw) * cp, -Math.sin(this.lookPitch) + 0.1, Math.cos(yaw) * cp).normalize();
    this.aim.copy(v1);
    this.machine.aim(this.aim);
  }

  private place(_dt: number, stage: Stage): void {
    const bob = Math.sin(this.t * 1.7) * 0.25;
    const way = this.speed / TOP_SPEED;
    this.pos.y = DATUM.boat + bob;
    // It lifts its bow with the way on, and leans into its turns. The machine's root is at its soles: on the water.
    this.rootQuat.setFromEuler(euler.set(-Math.max(0, way) * 0.07 + Math.sin(this.t * 1.3) * 0.012, this.yaw, this.lean, 'YXZ'));
    this.rootPos.set(this.pos.x, this.pos.y - DATUM.boat, this.pos.z);
    if (this.phase === 'held') return;
    this.mesh.position.copy(this.rootPos);
    this.mesh.quaternion.copy(this.rootQuat);
    if (this.phase === 'in' || this.phase === 'moored') this.machine.aim(null);
    // Its wake, and spray at the bow when it runs.
    if (Math.abs(way) > 0.12 && Math.random() < Math.min(1, Math.abs(way) * 1.2)) {
      for (const side of [3, -3]) {
        v1.set(this.pos.x - this.fwd.x * 11 - this.fwd.z * side, 0.4, this.pos.z - this.fwd.z * 11 + this.fwd.x * side);
        stage.fx.burst(v1, Math.random() < 0.6 ? '#cfe0fb' : '#3a7ba3', 1, 8, { size: 1.5, life: 0.9, gravity: 30, lift: 6 + Math.abs(way) * 12, drag: 1.2, spread: 2 });
      }
      if (way > 0.7) {
        v1.set(this.pos.x + this.fwd.x * 12, 0.6, this.pos.z + this.fwd.z * 12);
        stage.fx.burst(v1, '#cfe0fb', 1, 22, { size: 1.2, life: 0.5, gravity: 80, lift: 24 * way, drag: 1 });
      }
    }
  }

  rig(dt: number, _stage: Stage, out: Rig): void {
    const yaw = this.yaw + this.lookYaw;
    const cp = Math.cos(this.lookPitch);
    v1.set(Math.sin(yaw) * cp, -Math.sin(this.lookPitch), Math.cos(yaw) * cp);
    out.eye.copy(this.pos).addScaledVector(v1, -(34 + (this.boosting ? 6 : 0)));
    out.eye.y += 10;
    out.look.copy(this.pos).addScaledVector(v1, 80);
    out.look.y += 9;
    out.up.set(0, 1, 0);
    out.roll = 0;
    const fov = 62 + (this.boosting ? 12 : 0);
    this.fov += (fov - this.fov) * (dt > 0 ? 1 - Math.exp(-4 * dt) : 1);
    out.fov = this.fov;
  }

  gauges(): Gauges {
    return { speed: Math.abs(this.speed) * 0.9, pace: Math.abs(this.speed) / TOP_SPEED, alt: null, power: null, boost: this.boost, boostDry: this.boostDry, boosting: this.boosting };
  }

  wreck(stage: Stage): void {
    this.phase = 'down';
    this.mesh.visible = false;
    stage.fx.explosion(this.pos, 3);
    stage.fx.splash(this.pos, 3);
  }

  dispose(stage: Stage, keep = false): void {
    if (!keep) stage.scene.remove(this.mesh);
  }
}
