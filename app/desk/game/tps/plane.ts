// The seaplane: how it comes in and waits by the island, takes off, flies
// under the pilot's hand, and where the eye sits behind it.
//
// Flown by the cursor (the nose follows it) or by the keys (a stick); the
// flying itself is flight.ts.
import {
  AdditiveBlending, CircleGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Sprite, SpriteMaterial, Vector3,
} from 'three';
import type { Craft, CraftEnv, Gauges } from './craft';
import { barrelRoll, createFlight, isRolling, orient, stepFlight, stickToward, TUNE, type Flight, type Stick } from './flight';
import { skyModels } from './models';
import type { Rig, Stage } from './stage';
import { instance } from './voxels';

/** The plane's origin above the water when it floats. */
const WATERLINE = 4.3;
const RADIUS = 5.5;
/** Seconds it takes to come in and moor. */
const ARRIVAL = 5.5;

const v1 = new Vector3();
const stick2 = { x: 0, y: 0 };

export class Plane implements Craft {
  readonly kind = 'plane';
  readonly mesh = new Group();
  readonly vel = new Vector3();
  readonly radius = RADIUS;
  readonly gate: Vector3;
  private flight: Flight;
  private stick: Stick = { x: 0, y: 0, boost: false, brake: false };
  private prop: Mesh;
  private exhaust: Sprite;
  private shadow: Mesh;
  private owned: Array<{ dispose: () => void }> = [];
  /** `in`: on its way; `moored`; `run`: the take-off; `live`; `down`. */
  private phase: 'in' | 'moored' | 'run' | 'live' | 'down' = 'in';
  private t = 0;
  private camYaw: number;
  private camPitch = 0;
  private camRoll = 0;
  private fov = 64;
  private warnBeep = 0;

  /** `dock`: where it waits on the water, and which way it points. */
  constructor(stage: Stage, private dock: { x: number; z: number; yaw: number }, gate: Vector3) {
    this.gate = gate.clone();
    this.flight = createFlight(dock.x, WATERLINE, dock.z, dock.yaw, 0);
    this.camYaw = dock.yaw;
    this.mesh.add(instance(skyModels().plane));
    const propGeometry = new CircleGeometry(3.1, 14);
    const propMaterial = new MeshBasicMaterial({ color: '#cfd6e6', transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false });
    this.prop = new Mesh(propGeometry, propMaterial);
    this.prop.position.set(0, 0.1, 8.15);
    this.mesh.add(this.prop);
    const light = (colour: string, size: number, x: number, y: number, z: number, opacity = 0.9): Sprite => {
      const material = new SpriteMaterial({ map: stage.glow, color: colour, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity, fog: false });
      this.owned.push(material);
      const sprite = new Sprite(material);
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(size);
      this.mesh.add(sprite);
      return sprite;
    };
    light('#ff5d5d', 5, 9.6, 0.8, 2.3);
    light('#4ade80', 5, -9.6, 0.8, 2.3);
    this.exhaust = light('#ffb86b', 7, 0, -1.4, 5.4, 0.8);
    // Its shadow on what lies under it: how high it flies, at a glance.
    const shadowGeometry = new PlaneGeometry(1, 1);
    const shadowMaterial = new MeshBasicMaterial({ color: '#02050b', transparent: true, opacity: 0.4, depthWrite: false });
    this.shadow = new Mesh(shadowGeometry, shadowMaterial);
    this.shadow.rotation.x = -Math.PI / 2;
    this.owned.push(propGeometry, propMaterial, shadowGeometry, shadowMaterial);
    stage.scene.add(this.mesh, this.shadow);
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
    if (this.phase === 'down') return;

    if (this.phase === 'run') {
      // The take-off: a run on the water, the floats come unstuck, the plane is the pilot's.
      f.stalled = false;
      stick.x = 0; stick.y = this.t > 2.1 ? 0.3 : 0; stick.boost = false; stick.brake = false;
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
        stick.x = stick2.x; stick.y = stick2.y;
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
      stick.brake = input.brake;
      const side = input.takeRoll();
      if (side && barrelRoll(f, side)) env.audio.roll();
      stepFlight(f, stick, dt);
      this.collide(env);
      if (f.stalled) env.warn('STALL');
      else if (f.pos.y - stage.world.groundAt(f.pos.x, f.pos.z) < 30 && f.pitch < -0.12) env.warn('PULL UP');
      else if (f.pos.y > TUNE.ceiling) env.warn('THIN AIR');
      if (f.stalled || (f.pos.y - stage.world.groundAt(f.pos.x, f.pos.z) < 30 && f.pitch < -0.12)) {
        this.warnBeep -= dt;
        if (this.warnBeep <= 0) { this.warnBeep = 0.42; env.audio.alarm(); }
      } else this.warnBeep = 0;
    }
    this.vel.copy(f.fwd).multiplyScalar(f.speed);
    this.place(dt, stage, 40);
  }

  /** The sea, the land, the towers: it bounces off, and pays for it. */
  private collide(env: CraftEnv): void {
    const f = this.flight;
    const { stage } = env;
    const ground = stage.world.groundAt(f.pos.x, f.pos.z);
    if (f.pos.y < ground + 3.2) {
      v1.copy(f.pos);
      if (ground > 0) { v1.y = ground + 1; stage.fx.burst(v1, '#ffb86b', 16, 60, { size: 1.4, life: 0.5 }); }
      else { v1.y = 0.5; stage.fx.splash(v1, 1.6); }
      f.pos.y = ground + 5;
      f.pitch = Math.max(f.pitch, 0.42);
      f.speed *= 0.82;
      env.damage(26, null, true);
      env.audio.crash(ground <= 0);
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
    this.mesh.position.copy(f.pos);
    this.mesh.quaternion.copy(f.quat);
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
      speed: f.speed * 3, pace: f.speed / TUNE.cruise, alt: (f.pos.y - stage.world.groundAt(f.pos.x, f.pos.z)) * 3,
      boost: f.boost, boostDry: f.boostDry, boosting: f.boosting,
    };
  }

  wreck(stage: Stage): void {
    this.phase = 'down';
    this.mesh.visible = false;
    this.shadow.visible = false;
    stage.fx.explosion(this.flight.pos, 3);
  }

  dispose(stage: Stage): void {
    stage.scene.remove(this.mesh, this.shadow);
    for (const o of this.owned) o.dispose();
  }
}
