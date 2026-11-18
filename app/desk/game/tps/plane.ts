// The seaplane — the machine's shape in the air: how it comes in and waits by
// the island, takes off, flies under the pilot's hand, and where the eye sits
// behind it.
//
// Flown by the mouse (the nose follows the cursor; the arrows are a stick for
// hands off it), W / S on the throttle, A / D on the rudder; the flying itself
// is flight.ts. It lands: on the sea it becomes the boat, on the mainland the
// tank (`takeTurn`).
import {
  AdditiveBlending, CircleGeometry, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Sprite, SpriteMaterial, Vector3,
  type Group, type Object3D,
} from 'three';
import type { Form } from '../forms';
import { MACHINE_GUN, type Craft, type CraftEnv, type CraftState, type Gauges } from './craft';
import { barrelRoll, createFlight, CRUISE_THROTTLE, isRolling, orient, stepFlight, stickToward, TUNE, type Flight, type Stick } from './flight';
import { DATUM, NOSE_TIP, type Machine } from './machine';
import type { Rig, Stage } from './stage';

/** The plane's origin above the water when it floats (the fuselage over the floats' soles). */
const WATERLINE = DATUM.plane;
const RADIUS = 5.5;
/** Seconds it takes to come in and moor. */
const ARRIVAL = 5.5;

/** A sink faster than this (world units per second) is no landing: it costs. */
const HARD = 40;

const v1 = new Vector3();
const stick2 = { x: 0, y: 0 };

export class Plane implements Craft {
  readonly kind = 'plane';
  readonly mesh: Group;
  readonly rootPos = new Vector3();
  readonly rootQuat = new Quaternion();
  readonly vel = new Vector3();
  readonly radius = RADIUS;
  readonly gun = MACHINE_GUN;
  readonly gate: Vector3;
  private flight: Flight;
  private stick: Stick = { x: 0, y: 0, boost: false, power: 0, rudder: 0 };
  private turn: Form | null = null;
  private prop: Mesh;
  private exhaust: Sprite;
  private shadow: Mesh;
  private owned: Array<{ dispose: () => void }> = [];
  /** What is the plane's alone: its propeller's disc, its engine's glow. */
  private extras: Object3D[] = [];
  /** `in`: on its way; `moored`; `run`: the take-off; `held`: being turned into; `live`; `down`. */
  private phase: 'in' | 'moored' | 'run' | 'held' | 'live' | 'down' = 'in';
  private t = 0;
  private camYaw: number;
  private camPitch = 0;
  private camRoll = 0;
  private fov = 64;
  private warnBeep = 0;

  /** `dock`: where it waits on the water, and which way it points. */
  constructor(stage: Stage, readonly machine: Machine, private dock: { x: number; z: number; yaw: number }, gate: Vector3) {
    this.mesh = machine.root;
    this.gate = gate.clone();
    this.flight = createFlight(dock.x, WATERLINE, dock.z, dock.yaw, 0);
    this.camYaw = dock.yaw;
    const nose = machine.part('nose');
    const propGeometry = new CircleGeometry(3.1, 14);
    const propMaterial = new MeshBasicMaterial({ color: '#cfd6e6', transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false });
    this.prop = new Mesh(propGeometry, propMaterial);
    this.prop.position.set(0, 0.1, NOSE_TIP);
    nose.add(this.prop);
    const material = new SpriteMaterial({ map: stage.glow, color: '#ffb86b', blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8, fog: false });
    this.exhaust = new Sprite(material);
    this.exhaust.position.set(0, -1.4, 0.2);
    this.exhaust.scale.setScalar(7);
    nose.add(this.exhaust);
    this.extras.push(this.prop, this.exhaust);
    this.owned.push(material);
    // Its shadow on what lies under it: how high it flies, at a glance.
    const shadowGeometry = new PlaneGeometry(1, 1);
    const shadowMaterial = new MeshBasicMaterial({ color: '#02050b', transparent: true, opacity: 0.4, depthWrite: false });
    this.shadow = new Mesh(shadowGeometry, shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.owned.push(propGeometry, propMaterial, shadowGeometry, shadowMaterial);
    stage.scene.add(this.shadow);
    if (!this.mesh.parent) stage.scene.add(this.mesh);
    this.idle(0, stage);
  }

  get pos(): Vector3 { return this.flight.pos; }
  get fwd(): Vector3 { return this.flight.fwd; }
  get aim(): Vector3 { return this.flight.fwd; }
  get moored(): boolean { return this.phase === 'moored'; }
  get live(): boolean { return this.phase === 'live'; }
  get dodging(): boolean { return isRolling(this.flight); }
  get masked(): boolean { return isRolling(this.flight); }

  muzzle(side: number, out: Vector3): Vector3 {
    const f = this.flight;
    if (!side) return out.copy(f.pos).addScaledVector(f.up, -2.4).addScaledVector(f.fwd, 2);
    return out.copy(f.pos).addScaledVector(f.right, -5 * side).addScaledVector(f.fwd, 6.4).addScaledVector(f.up, 0.4);
  }

  seat(out: Vector3): Vector3 {
    const f = this.flight;
    return out.copy(f.pos).addScaledVector(f.up, 1.2).addScaledVector(f.fwd, 1.6);
  }

  takeTurn(): Form | null {
    const turn = this.turn;
    this.turn = null;
    return turn;
  }

  state(): CraftState {
    const f = this.flight;
    return { pos: f.pos.clone(), yaw: f.yaw, speed: f.speed * Math.cos(f.pitch), boost: f.boost, boostDry: f.boostDry };
  }

  hold(state: CraftState, stage: Stage): void {
    const f = this.flight;
    if (this.phase !== 'held') { this.camYaw = state.yaw; this.camPitch = 0.2; this.camRoll = 0; }
    this.phase = 'held';
    for (const o of this.extras) o.visible = false;
    this.shadow.visible = false;
    f.pos.copy(state.pos);
    f.yaw = state.yaw;
    // It leaves climbing, wings level, at what its engine gives.
    f.pitch = 0.24; f.roll = 0; f.spin = 0; f.spinDir = 0; f.stalled = false;
    f.speed = state.speed;
    f.throttle = CRUISE_THROTTLE;
    f.boost = state.boost; f.boostDry = state.boostDry; f.boosting = false;
    orient(f);
    this.vel.copy(f.fwd).multiplyScalar(f.speed);
    this.place(0, stage, 40);
  }

  release(stage: Stage): void {
    this.phase = 'live';
    this.machine.set('plane');
    for (const o of this.extras) o.visible = true;
    this.shadow.visible = true;
    this.turn = null;
    this.place(0, stage, 40);
  }

  moor(): void {
    this.phase = 'moored';
    this.t = 0;
  }

  /** It lands off the island, runs in on its floats, and waits with its engine ticking over. */
  idle(dt: number, stage: Stage): void {
    const f = this.flight;
    this.t += dt;
    if (this.phase === 'in') {
      const k = Math.min(1, this.t / ARRIVAL);
      // From behind where it will wait, down a long slope, then slower and slower on the water.
      const back = (1 - k) * (1 - k) * 420;
      f.yaw = this.dock.yaw;
      f.pos.set(this.dock.x - Math.sin(f.yaw) * back, WATERLINE + Math.max(0, 0.45 - k) * 150, this.dock.z - Math.cos(f.yaw) * back);
      f.pitch = k < 0.45 ? -0.16 : 0;
      f.speed = 0;
      if (k > 0.45 && k < 0.95 && Math.random() < 0.8) this.spray(stage, 30 * (1 - k));
      if (k >= 1) this.moor();
    } else {
      f.pos.set(this.dock.x, WATERLINE + Math.sin(this.t * 1.4) * 0.18, this.dock.z);
      f.yaw = this.dock.yaw;
      f.pitch = Math.sin(this.t * 0.9) * 0.012;
    }
    orient(f);
    this.place(dt, stage, this.phase === 'in' ? 26 : 9);
  }

  cast(): void {
    this.phase = 'run';
    this.t = 0;
    this.flight.speed = 24;
    this.flight.pitch = 0;
    this.camYaw = this.flight.yaw;
  }

  private spray(stage: Stage, lift: number): void {
    const f = this.flight;
    for (const side of [3.4, -3.4]) {
      v1.copy(f.pos).addScaledVector(f.right, side).addScaledVector(f.fwd, -4);
      v1.y = 0.6;
      stage.fx.burst(v1, Math.random() < 0.5 ? '#cfe0fb' : '#3a7ba3', 1, 14, { size: 1.5, life: 0.7, gravity: 60, lift: 14 + lift, drag: 1 });
    }
  }

  step(dt: number, env: CraftEnv): void {
    const f = this.flight;
    const { stage, input } = env;
    const stick = this.stick;
    this.t += dt;
    if (this.phase === 'down' || this.phase === 'held') return;

    if (this.phase === 'run') {
      // The take-off: a run on the water, the floats come unstuck, the plane is the pilot's.
      f.stalled = false;
      f.throttle = CRUISE_THROTTLE;
      stick.x = 0; stick.y = this.t > 2.1 ? 0.3 : 0; stick.boost = false; stick.power = 0; stick.rudder = 0;
      stepFlight(f, stick, dt);
      if (this.t < 2.1) {
        f.pitch = 0; f.stalled = false; f.pos.y = WATERLINE;
        if (Math.random() < 0.9) this.spray(stage, f.speed * 0.16);
      }
      if (this.t >= 3.1) this.phase = 'live';
    } else {
      if (input.device === 'pointer' && input.pointer) {
        // The nose follows the cursor: the direction under it, seen from the eye.
        stickToward(f, stage.ray(input.pointer.x, input.pointer.y, v1), stick2);
        // The rudder swings the nose off the cursor: the cursor does not bank it back while it is held.
        stick.x = input.side ? 0 : stick2.x; stick.y = stick2.y;
      } else {
        stick.x = input.keys.x; stick.y = input.keys.y;
      }
      // The edge of the fight: the plane is turned back toward the archipelago.
      const out = Math.hypot(f.pos.x, f.pos.z) - stage.world.radius;
      if (out > 0) {
        stickToward(f, v1.set(-f.pos.x, 0, -f.pos.z).normalize(), stick2);
        const k = Math.min(1, out / 240);
        stick.x += (stick2.x - stick.x) * k;
        stick.y += (-f.pitch * 2 - stick.y) * k * 0.5;
        env.warn('TURN BACK');
      }
      stick.boost = input.boost;
      stick.power = input.ahead;
      stick.rudder = input.side;
      const side = input.takeRoll();
      if (side && barrelRoll(f, side)) env.audio.roll();
      stepFlight(f, stick, dt);
      this.collide(env);
      // Coming down too hard to land: the last moment to pull up.
      const low = f.pos.y - stage.world.groundAt(f.pos.x, f.pos.z) < 34 && f.speed * Math.sin(f.pitch) < -HARD;
      if (f.stalled) env.warn('STALL');
      else if (low) env.warn('PULL UP');
      else if (f.pos.y > TUNE.ceiling) env.warn('THIN AIR');
      if (f.stalled || low) {
        this.warnBeep -= dt;
        if (this.warnBeep <= 0) { this.warnBeep = 0.42; env.audio.alarm(); }
      } else this.warnBeep = 0;
    }
    this.vel.copy(f.fwd).multiplyScalar(f.speed);
    this.place(dt, stage, 40);
  }

  /**
   * What it touches. The sea: it lands on it and becomes the boat. The
   * mainland: the tank. Too hard a landing is paid for. An island of the
   * archipelago, a tower: it bounces off, and pays for it.
   */
  private collide(env: CraftEnv): void {
    const f = this.flight;
    const { stage } = env;
    const world = stage.world;
    const ground = world.groundAt(f.pos.x, f.pos.z);
    const shore = world.mainland.heightAt(f.pos.x, f.pos.z);
    const sea = ground <= 0;
    if (f.pos.y < ground + (sea ? WATERLINE : 3.2)) {
      const fall = -f.speed * Math.sin(f.pitch) + (f.speed < TUNE.stall ? TUNE.sink * (1 - f.speed / TUNE.stall) : 0);
      if (sea || shore >= ground) {
        // Down: the machine turns into what goes there.
        f.pos.y = ground + (sea ? WATERLINE : 3.2);
        if (fall > HARD) { env.damage(Math.min(30, 8 + (fall - HARD) * 0.5), null, true); env.audio.crash(sea); }
        v1.copy(f.pos);
        if (sea) { v1.y = 0.5; stage.fx.splash(v1, 1.8); } else { v1.y = ground + 1; stage.fx.burst(v1, '#8f845f', 16, 40, { size: 1.5, life: 0.7, lift: 16 }); }
        this.turn = sea ? 'boat' : 'tank';
        return;
      }
      v1.copy(f.pos);
      v1.y = ground + 1;
      stage.fx.burst(v1, '#ffb86b', 16, 60, { size: 1.4, life: 0.5 });
      f.pos.y = ground + 5;
      f.pitch = Math.max(f.pitch, 0.42);
      f.speed *= 0.82;
      env.damage(26, null, true);
      env.audio.crash(false);
    }
    for (const tower of stage.world.towers) {
      if (f.pos.y > tower.top) continue;
      const dx = f.pos.x - tower.x;
      const dz = f.pos.z - tower.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d > tower.r + RADIUS) continue;
      // Thrown clear of it, to the side it came from.
      f.pos.x = tower.x + (dx / d) * (tower.r + RADIUS + 3);
      f.pos.z = tower.z + (dz / d) * (tower.r + RADIUS + 3);
      f.yaw = Math.atan2(dx, dz);
      f.speed *= 0.75;
      stage.fx.burst(f.pos, '#ffb86b', 18, 70, { size: 1.5, life: 0.5 });
      env.damage(26, null, true);
      env.audio.crash(false);
    }
    // Skimming the water throws spray.
    if (ground <= 0 && f.pos.y < 13 && Math.random() < 0.7) {
      v1.copy(f.pos).addScaledVector(f.fwd, -6);
      v1.y = 0.5;
      stage.fx.burst(v1, '#cfe0fb', 1, 16, { size: 1.3, life: 0.6, gravity: 70, lift: 22, drag: 1, spread: 5 });
    }
  }

  /** Put the model where the flight is; what it leaves in the air. */
  private place(dt: number, stage: Stage, propSpeed: number): void {
    const f = this.flight;
    // The machine's root is at its floats' soles: under the fuselage, along its own up.
    this.rootQuat.copy(f.quat);
    this.rootPos.copy(f.pos).addScaledVector(f.up, -WATERLINE);
    if (this.phase === 'held') return;
    this.mesh.position.copy(this.rootPos);
    this.mesh.quaternion.copy(this.rootQuat);
    this.prop.rotation.z += dt * propSpeed;
    // The afterburner shows.
    this.exhaust.scale.setScalar(f.boosting ? 17 + Math.random() * 5 : 6 + Math.random());
    if (this.phase === 'live' || this.phase === 'run') {
      if (f.boosting) {
        for (let i = 0; i < 2; i += 1) {
          v1.copy(f.pos).addScaledVector(f.fwd, -8 - i * 5);
          stage.fx.puff(v1, Math.random() < 0.5 ? '#ffb86b' : '#fff3c9', 1.7, 0.32, 0, 0, 0, false);
        }
      }
      // A hard turn pulls vapour off the wingtips.
      if (Math.abs(f.roll) > 0.78 && f.speed > 70) {
        for (const side of [9.4, -9.4]) {
          v1.copy(f.pos).addScaledVector(f.right, side).addScaledVector(f.up, 0.6).addScaledVector(f.fwd, 1.5);
          stage.fx.puff(v1, '#cfe0fb', 0.75, 0.42, 0, 0, 0, false);
        }
      }
      // The air itself, to feel the speed: motes the plane rushes past — a storm of them under the afterburner.
      const motes = f.boosting ? 3 : Math.random() < 0.3 ? 1 : 0;
      for (let i = 0; i < motes; i += 1) {
        v1.copy(f.pos).addScaledVector(f.fwd, (150 + Math.random() * 130) * (f.boosting ? 2 : 1))
          .addScaledVector(f.right, (Math.random() - 0.5) * 170).addScaledVector(f.up, (Math.random() - 0.5) * 100 + 8);
        stage.fx.puff(v1, '#9fc4e8', f.boosting ? 0.8 : 0.5, 0.9, 0, 0, 0, false);
      }
    }
    const ground = stage.world.groundAt(f.pos.x, f.pos.z);
    const height = Math.max(0, f.pos.y - ground);
    this.shadow.position.set(f.pos.x, ground + 0.25, f.pos.z);
    this.shadow.rotation.z = f.yaw;
    this.shadow.scale.set(19 * (1 + height / 260), 15 * (1 + height / 260), 1);
    (this.shadow.material as MeshBasicMaterial).opacity = 0.42 * Math.max(0, 1 - height / 330);
  }

  rig(dt: number, _stage: Stage, out: Rig): void {
    const f = this.flight;
    // The eye follows the plane's heading with a little lag: a turn shows its flank.
    const k = (rate: number) => (dt > 0 ? 1 - Math.exp(-rate * dt) : 1);
    let turn = f.yaw - this.camYaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    if (this.phase === 'down') this.camYaw += dt * 0.18;
    else this.camYaw += turn * k(5.2);
    this.camPitch += (f.pitch * 0.82 - this.camPitch) * k(4.2);
    this.camRoll += (f.roll * 0.24 - this.camRoll) * k(5);
    const cp = Math.cos(this.camPitch);
    v1.set(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch), Math.cos(this.camYaw) * cp);
    // Behind and above: the plane sits in the lower third, the sight in the middle.
    const back = this.phase === 'down' ? 90 : 56 + (f.boosting ? 14 : 0);
    out.eye.copy(f.pos).addScaledVector(v1, -back);
    out.eye.y += 14;
    out.look.copy(f.pos).addScaledVector(v1, 120);
    out.look.y += 11;
    out.up.set(0, 1, 0);
    out.roll = this.camRoll;
    // The afterburner stretches the view.
    const fov = 64 + (f.boosting ? 22 : 0) + Math.max(0, f.speed - TUNE.cruise) * 0.04;
    this.fov += (fov - this.fov) * k(4);
    out.fov = this.fov;
  }

  gauges(stage: Stage): Gauges {
    const f = this.flight;
    return {
      speed: f.speed * 3, pace: f.speed / TUNE.cruise, alt: (f.pos.y - stage.world.groundAt(f.pos.x, f.pos.z)) * 3, power: f.throttle,
      boost: f.boost, boostDry: f.boostDry, boosting: f.boosting,
    };
  }

  wreck(stage: Stage): void {
    this.phase = 'down';
    this.mesh.visible = false;
    this.shadow.visible = false;
    stage.fx.explosion(this.flight.pos, 3);
  }

  dispose(stage: Stage, keep = false): void {
    for (const o of this.extras) o.removeFromParent();
    stage.scene.remove(this.shadow);
    if (!keep) stage.scene.remove(this.mesh);
    for (const o of this.owned) o.dispose();
  }
}
