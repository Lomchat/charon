// The tank — the machine's shape on the land: how it drives over the
// mainland's relief under the pilot's hand, and where the eye sits behind it.
//
// A hull and a turret: W / S drive, A / D turn the hull (on the spot, too);
// the mouse turns the view, and the gun points where the view does, whatever
// the hull is doing. Driven into the sea, it becomes the boat (`takeTurn`).
// It is never moored: the machine only ever turns into it.
import { AdditiveBlending, Euler, Quaternion, Sprite, SpriteMaterial, Vector3, type Group } from 'three';
import type { Form } from '../forms';
import { CANNON, type Craft, type CraftEnv, type CraftState, type Gauges } from './craft';
import { TURRET, type Machine } from './machine';
import type { Rig, Stage } from './stage';

const TOP_SPEED = 40;
const BOOST = 1.9;
const RADIUS = 6.5;
/** How deep it wades before it floats (and is the boat). */
const WADE = 1.5;

/** Where a gun sits in the turret (machine.ts: its tank pose). */
const GUN_Z = 2.4;

const v1 = new Vector3();
const v2 = new Vector3();
const euler = new Euler();
const look = { x: 0, y: 0 };

export class Tank implements Craft {
  readonly kind = 'tank';
  readonly mesh: Group;
  readonly rootPos = new Vector3();
  readonly rootQuat = new Quaternion();
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly fwd = new Vector3(0, 0, 1);
  readonly aim = new Vector3(0, 0, 1);
  readonly radius = RADIUS;
  readonly gun = CANNON;
  readonly gate = new Vector3();
  readonly moored = false;
  readonly dodging = false;
  readonly masked = false;
  private owned: Array<{ dispose: () => void }> = [];
  /** Its headlights: the tank's alone. */
  private lamps: Sprite[] = [];
  private guns: Group[];
  private phase: 'held' | 'live' | 'down' = 'held';
  private turn: Form | null = null;
  private t = 0;
  private yaw = 0;
  private speed = 0;
  private pitch = 0;
  private roll = 0;
  /** The view, relative to the hull: the mouse turns it; the hull turns under it. */
  private lookYaw = 0;
  private lookPitch = 0.14;
  private boost = 1;
  private boostDry = false;
  private boosting = false;
  /** 0..1: the gun has just fired (it comes back, the hull rocks). */
  private kick = 0;
  private fov = 60;

  constructor(stage: Stage, readonly machine: Machine) {
    this.mesh = machine.root;
    this.guns = [machine.part('gun1'), machine.part('gun-1')];
    const nose = machine.part('nose');
    for (const x of [-1.1, 1.1]) {
      const material = new SpriteMaterial({ map: stage.glow, color: '#fff3c9', blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7, fog: false });
      this.owned.push(material);
      const sprite = new Sprite(material);
      sprite.position.set(x, -0.2, 2.6);
      sprite.scale.setScalar(4.2);
      sprite.visible = false;
      nose.add(sprite);
      this.lamps.push(sprite);
    }
    if (!this.mesh.parent) stage.scene.add(this.mesh);
  }

  get live(): boolean { return this.phase === 'live'; }

  takeTurn(): Form | null {
    const turn = this.turn;
    this.turn = null;
    return turn;
  }

  muzzle(side: number, out: Vector3): Vector3 {
    this.machine.pivot(out).addScaledVector(this.aim, TURRET.tank.reach);
    out.y += TURRET.tank.gun;
    if (side) out.addScaledVector(v1.set(-this.aim.z, 0, this.aim.x).normalize(), -0.5 * side);
    return out;
  }

  seat(out: Vector3): Vector3 {
    return out.copy(this.pos).setY(this.pos.y + 4);
  }

  idle(): void { /* never moored */ }
  moor(): void { /* never moored */ }
  cast(): void { this.phase = 'live'; }

  /** Its gun has fired: it kicks. */
  fired(stage: Stage): void {
    this.kick = 1;
    this.muzzle(0, v1);
    stage.fx.flash(v1, '#fff3c9', 20, 0.09);
    stage.fx.burst(v1, '#9aa1b1', 5, 18, { size: 1.8, life: 0.7, gravity: -6, drag: 2.4, swell: true, spread: 1.5 });
    stage.shake(0.22);
  }

  state(): CraftState {
    return { pos: this.pos.clone(), yaw: this.yaw, speed: this.speed, boost: this.boost, boostDry: this.boostDry };
  }

  hold(state: CraftState, stage: Stage): void {
    if (this.phase !== 'held') { this.lookYaw = 0; this.lookPitch = 0.14; this.pitch = 0; this.roll = 0; }
    this.phase = 'held';
    this.pos.copy(state.pos);
    this.yaw = state.yaw;
    this.speed = Math.max(-TOP_SPEED * 0.55, Math.min(TOP_SPEED * BOOST, state.speed));
    this.boost = state.boost; this.boostDry = state.boostDry; this.boosting = false;
    this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.vel.copy(this.fwd).multiplyScalar(this.speed);
    this.place(1, stage);
  }

  release(): void {
    this.phase = 'live';
    this.machine.set('tank');
    for (const lamp of this.lamps) lamp.visible = true;
    this.turn = null;
  }

  step(dt: number, env: CraftEnv): void {
    const { stage, input } = env;
    this.t += dt;
    if (this.phase !== 'live') return;

    // The view: the mouse turns it (captured), or leans it to the side it is on; the arrows too.
    input.takeLook(look);
    if (input.locked) {
      this.lookYaw -= look.x * 0.0026;
      this.lookPitch += look.y * 0.002;
    } else {
      input.offset(look);
      if (Math.abs(look.x) > 0.14) this.lookYaw -= Math.sign(look.x) * Math.min(1, (Math.abs(look.x) - 0.14) / 0.6) * 2 * dt;
      this.lookPitch += (0.14 + look.y * 0.5 - this.lookPitch) * (1 - Math.exp(-3 * dt));
    }
    this.lookYaw -= input.arrowX * 1.8 * dt;
    this.lookPitch -= input.arrowY * 0.9 * dt;
    this.lookPitch = Math.max(-0.7, Math.min(0.45, this.lookPitch));

    // The engine: a tank of boost on top of it. A slope ahead takes speed, a slope down gives some.
    if (this.boostDry && this.boost >= 0.33) this.boostDry = false;
    this.boosting = input.boost && !this.boostDry && this.boost > 0 && input.ahead > 0;
    if (this.boosting) {
      this.boost = Math.max(0, this.boost - dt / 3);
      if (this.boost <= 0) this.boostDry = true;
    } else this.boost = Math.min(1, this.boost + dt / 5);
    const ahead = input.ahead;
    const grade = Math.max(0.4, Math.min(1.2, 1 - Math.sin(this.pitch) * Math.sign(this.speed || ahead || 1) * 1.3));
    const want = (ahead > 0 ? TOP_SPEED * (this.boosting ? BOOST : 1) : ahead < 0 ? -TOP_SPEED * 0.55 : 0) * grade;
    this.speed += (want - this.speed) * (1 - Math.exp(-(ahead ? 1.9 : 3.4) * dt));

    // Tracks: it turns on the spot, a little less at speed. The view does not turn with the hull.
    const turned = input.side * (1.5 - 0.5 * Math.min(1, Math.abs(this.speed) / TOP_SPEED)) * (this.speed < -1 ? -1 : 1) * dt;
    this.yaw -= turned;
    this.lookYaw += turned;
    this.lookYaw = Math.atan2(Math.sin(this.lookYaw), Math.cos(this.lookYaw));
    this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    const world = stage.world;
    const nx = this.pos.x + this.fwd.x * this.speed * dt;
    const nz = this.pos.z + this.fwd.z * this.speed * dt;
    const far = Math.hypot(nx, nz);
    if (far > world.radius) { this.speed = 0; env.warn('TURN BACK'); } else { this.pos.x = nx; this.pos.z = nz; }
    // In over its tracks: it floats, and is the boat.
    if (world.mainland.heightAt(this.pos.x, this.pos.z) < -WADE) this.turn = 'boat';
    this.vel.copy(this.fwd).multiplyScalar(this.speed);

    this.kick = Math.max(0, this.kick - dt * 3.2);
    this.place(dt, stage);
    this.point();
  }

  /** The guns point where the view does, and come back after a shot. */
  private point(): void {
    const yaw = this.yaw + this.lookYaw;
    const cp = Math.cos(this.lookPitch);
    this.aim.set(Math.sin(yaw) * cp, -Math.sin(this.lookPitch) + 0.08, Math.cos(yaw) * cp).normalize();
    // The barrels do not go under the hull's deck.
    v1.copy(this.aim);
    v1.y = Math.max(v1.y, -0.14);
    this.machine.aim(v1.normalize());
    for (const gun of this.guns) gun.position.z = GUN_Z - this.kick * 1.1;
  }

  /** On the ground: at its height, leaning the way it lies. */
  private place(dt: number, stage: Stage): void {
    const land = stage.world.mainland;
    const ground = (x: number, z: number): number => Math.max(-WADE, land.heightAt(x, z));
    const rx = -this.fwd.z;
    const rz = this.fwd.x;
    this.pos.y = ground(this.pos.x, this.pos.z);
    const pitch = Math.atan2(ground(this.pos.x + this.fwd.x * 5.5, this.pos.z + this.fwd.z * 5.5) - ground(this.pos.x - this.fwd.x * 5.5, this.pos.z - this.fwd.z * 5.5), 11);
    const roll = Math.atan2(ground(this.pos.x + rx * 3.8, this.pos.z + rz * 3.8) - ground(this.pos.x - rx * 3.8, this.pos.z - rz * 3.8), 7.6);
    const k = dt >= 1 ? 1 : 1 - Math.exp(-9 * dt);
    this.pitch += (pitch - this.pitch) * k;
    this.roll += (roll - this.roll) * k;
    // The machine's root is at its soles: on the ground.
    this.rootPos.copy(this.pos);
    this.rootQuat.setFromEuler(euler.set(-this.pitch - this.kick * 0.03, this.yaw, -this.roll, 'YXZ'));
    if (this.phase === 'held') return;
    this.mesh.position.copy(this.rootPos);
    this.mesh.quaternion.copy(this.rootQuat);
    // Dust off its tracks (spray, where it wades).
    const way = Math.abs(this.speed) / TOP_SPEED;
    if (this.phase === 'live' && way > 0.15 && Math.random() < Math.min(1, way)) {
      const wet = land.heightAt(this.pos.x, this.pos.z) < 0.2;
      for (const side of [3.8, -3.8]) {
        v2.set(this.pos.x - this.fwd.x * 6 * Math.sign(this.speed) + rx * side, this.pos.y + 0.6, this.pos.z - this.fwd.z * 6 * Math.sign(this.speed) + rz * side);
        if (wet) stage.fx.burst(v2, '#cfe0fb', 1, 10, { size: 1.3, life: 0.6, gravity: 50, lift: 12, drag: 1.2, spread: 2 });
        else stage.fx.puff(v2, Math.random() < 0.5 ? '#6c6850' : '#4b4a3c', 1.6 + way * 1.4, 0.8, 0, 3, 0);
      }
    }
  }

  rig(dt: number, _stage: Stage, out: Rig): void {
    const yaw = this.yaw + this.lookYaw;
    const cp = Math.cos(this.lookPitch);
    v1.set(Math.sin(yaw) * cp, -Math.sin(this.lookPitch), Math.cos(yaw) * cp);
    out.eye.copy(this.pos).addScaledVector(v1, -(31 + (this.boosting ? 5 : 0)));
    out.eye.y += 11;
    out.look.copy(this.pos).addScaledVector(v1, 80);
    out.look.y += 9;
    out.up.set(0, 1, 0);
    out.roll = 0;
    const fov = 60 + (this.boosting ? 10 : 0);
    this.fov += (fov - this.fov) * (dt > 0 ? 1 - Math.exp(-4 * dt) : 1);
    out.fov = this.fov;
  }

  gauges(): Gauges {
    return { speed: Math.abs(this.speed) * 1.5, pace: Math.abs(this.speed) / TOP_SPEED, alt: null, power: null, boost: this.boost, boostDry: this.boostDry, boosting: this.boosting };
  }

  wreck(stage: Stage): void {
    this.phase = 'down';
    this.mesh.visible = false;
    stage.fx.explosion(this.pos, 3);
  }

  dispose(stage: Stage, keep = false): void {
    for (const lamp of this.lamps) lamp.removeFromParent();
    for (const gun of this.guns) gun.position.z = GUN_Z;
    if (!keep) stage.scene.remove(this.mesh);
    for (const o of this.owned) o.dispose();
  }
}
