// How the seaplane flies. Pure: a state, a stick, a time step — no scene, no
// input device, nothing drawn here.
//
// An arcade model that still flies like a plane: the stick banks it into a
// turn and pitches its nose, the throttle sets what the engine gives, the
// rudder swings the nose flat; speed is traded for height and won back in a
// dive, too slow and the wings let go — it falls —, too high and the air
// gets thin.
//
// Axes: +Y is up. At yaw 0 the nose points to +Z and the RIGHT wing to −X, so
// a right turn makes the yaw decrease. `roll` > 0 is the right wing down.
import { Matrix4, Quaternion, Vector3 } from 'three';

/**
 * What the pilot asks for. `x` > 0 banks and turns right, `y` > 0 pulls the
 * nose up; `power` moves the throttle (1 opens it, -1 closes it); `rudder` > 0
 * swings the nose right, wings level.
 */
export type Stick = { x: number; y: number; boost: boolean; power: number; rudder: number };

export type Flight = {
  pos: Vector3;
  yaw: number;
  pitch: number;
  /** The bank of the turn (the barrel roll comes on top: `spin`). */
  roll: number;
  speed: number;
  /** The throttle, 0..1: it stays where it was left. */
  throttle: number;
  /** A barrel roll: its side (±1, 0 = none), how far it is (0..1), and the wait before the next. */
  spinDir: number;
  spinT: number;
  spinCool: number;
  /** The extra roll of that barrel roll, radians. */
  spin: number;
  /** The afterburner's tank, 0..1; `boosting` = it is burning right now. */
  boost: number;
  boosting: boolean;
  /** Emptied: it must refill to a third before it lights again. */
  boostDry: boolean;
  stalled: boolean;
  fwd: Vector3;
  right: Vector3;
  up: Vector3;
  quat: Quaternion;
};

export const TUNE = {
  cruise: 96,
  /** What the engine gives with the throttle closed, and wide open. */
  idle: 30,
  full: 152,
  /** Seconds for the throttle to go from one end to the other. */
  throttleTime: 1.7,
  /** The afterburner: near three times the cruise. */
  boost: 2.9,
  /** Under this the wings let go. */
  stall: 50,
  /** How fast it falls once they have, at no speed at all. */
  sink: 46,
  /** Radians per second of the rudder alone. */
  rudderRate: 0.8,
  /** Radians per second at full stick, at cruise speed. */
  yawRate: 1.05,
  pitchRate: 1.0,
  maxBank: 1.08,
  maxPitch: 1.22,
  /** Thin air starts here; the plane cannot hold above `ceiling + 80`. */
  ceiling: 640,
  /** Seconds of afterburner in a full tank, and to fill an empty one. */
  boostTime: 3.2,
  boostFill: 5,
  spinTime: 0.62,
  spinWait: 1.1,
  /** How far a barrel roll slides the plane sideways. */
  spinSlide: 30,
};

/** The throttle that holds the cruise. */
export const CRUISE_THROTTLE = (TUNE.cruise - TUNE.idle) / (TUNE.full - TUNE.idle);

const m4 = new Matrix4();
const left = new Vector3();
const flat = new Vector3();

export function createFlight(x: number, y: number, z: number, yaw: number, speed: number): Flight {
  const f: Flight = {
    pos: new Vector3(x, y, z), yaw, pitch: 0, roll: 0, speed, throttle: CRUISE_THROTTLE,
    spinDir: 0, spinT: 0, spinCool: 0, spin: 0,
    boost: 1, boosting: false, boostDry: false, stalled: false,
    fwd: new Vector3(), right: new Vector3(), up: new Vector3(), quat: new Quaternion(),
  };
  orient(f);
  return f;
}

/** The plane's axes and its rotation, from its angles. */
export function orient(f: Flight): void {
  const cp = Math.cos(f.pitch);
  f.fwd.set(Math.sin(f.yaw) * cp, Math.sin(f.pitch), Math.cos(f.yaw) * cp);
  // Level right wing, then the up that goes with the nose; the roll turns both.
  flat.set(-Math.cos(f.yaw), 0, Math.sin(f.yaw));
  f.up.crossVectors(flat, f.fwd).normalize();
  const angle = f.roll + f.spin;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  f.right.copy(flat).multiplyScalar(c).addScaledVector(f.up, -s);
  f.up.multiplyScalar(c).addScaledVector(flat, s);
  left.copy(f.right).negate();
  f.quat.setFromRotationMatrix(m4.makeBasis(left, f.up, f.fwd));
}

/** Start a barrel roll to one side. False: one is under way, or too soon. */
export function barrelRoll(f: Flight, side: number): boolean {
  if (f.spinDir !== 0 || f.spinCool > 0 || f.stalled) return false;
  f.spinDir = side < 0 ? -1 : 1;
  f.spinT = 0;
  return true;
}

/** In a barrel roll: bullets miss, and what was locked on loses its lock. */
export function isRolling(f: Flight): boolean {
  return f.spinDir !== 0;
}

const ease = (k: number): number => k * k * (3 - 2 * k);
const toward = (from: number, to: number, rate: number, dt: number): number => from + (to - from) * (1 - Math.exp(-rate * dt));

export function stepFlight(f: Flight, stick: Stick, dt: number): void {
  const t = TUNE;

  // The afterburner: a tank that empties while held and refills when not.
  if (f.boostDry && f.boost >= 0.33) f.boostDry = false;
  f.boosting = stick.boost && !f.boostDry && f.boost > 0 && !f.stalled;
  if (f.boosting) {
    f.boost = Math.max(0, f.boost - dt / t.boostTime);
    if (f.boost <= 0) f.boostDry = true;
  } else f.boost = Math.min(1, f.boost + dt / t.boostFill);

  // The throttle stays where the hand leaves it.
  f.throttle = Math.max(0, Math.min(1, f.throttle + (Math.max(-1, Math.min(1, stick.power)) * dt) / t.throttleTime));

  // Speed: what the engine gives, less what the climb takes (a dive gives it back).
  const climb = Math.sin(f.pitch);
  const thin = Math.max(0, (f.pos.y - t.ceiling) / 80);
  const engine = (f.boosting ? t.cruise * t.boost : t.idle + (t.full - t.idle) * f.throttle) * (1 - 0.45 * Math.min(1, thin));
  const target = engine - climb * (climb > 0 ? 40 : 52);
  f.speed = toward(f.speed, target, f.boosting ? 2.6 : f.speed > t.cruise * 1.2 ? 1.6 : 1.0, dt);

  // Too slow: the wings let go and the nose falls until the speed is back.
  if (!f.stalled && f.speed < t.stall) f.stalled = true;
  else if (f.stalled && f.speed > t.stall + 14) f.stalled = false;

  // Slower turns tighter; the afterburner and thin air blunt the controls.
  const grip = Math.min(1.3, Math.max(0.5, t.cruise / Math.max(1, f.speed))) * (f.stalled ? 0.3 : 1);
  const sx = Math.max(-1, Math.min(1, stick.x));
  let sy = Math.max(-1, Math.min(1, stick.y));
  if (f.stalled) sy = Math.min(sy, 0) - 0.9;
  if (thin > 0) sy = Math.min(sy, 1 - thin) - thin * 0.8;

  f.yaw -= sx * t.yawRate * grip * dt;
  // The rudder: the nose swings, the wings stay level.
  f.yaw -= Math.max(-1, Math.min(1, stick.rudder)) * t.rudderRate * (f.stalled ? 0.4 : 1) * dt;
  // The nose stops short of the vertical, softly: the last degrees take longer.
  const room = sy > 0 ? (t.maxPitch - f.pitch) / 0.35 : (f.pitch + t.maxPitch) / 0.35;
  f.pitch += sy * t.pitchRate * grip * Math.max(0, Math.min(1, room)) * dt;
  f.pitch = Math.max(-t.maxPitch, Math.min(t.maxPitch, f.pitch));
  // Hands off, it trims itself back toward level, slowly.
  if (Math.abs(sy) < 0.04) f.pitch = toward(f.pitch, 0, 0.3, dt);
  f.roll = toward(f.roll, sx * t.maxBank, 4.2, dt);

  // The barrel roll: a full turn about the nose, and a slide to its side.
  f.spinCool = Math.max(0, f.spinCool - dt);
  let slide = 0;
  if (f.spinDir !== 0) {
    f.spinT += dt / t.spinTime;
    if (f.spinT >= 1) {
      f.spinDir = 0; f.spinT = 0; f.spin = 0; f.spinCool = t.spinWait;
    } else {
      f.spin = f.spinDir * Math.PI * 2 * ease(f.spinT);
      slide = f.spinDir * (t.spinSlide / t.spinTime) * Math.sin(Math.PI * f.spinT) * (Math.PI / 2);
    }
  }

  orient(f);
  f.pos.addScaledVector(f.fwd, f.speed * dt);
  // Under the stall the wings carry less and less: it sinks, nose level or not.
  if (f.speed < t.stall) f.pos.y -= t.sink * (1 - f.speed / t.stall) * dt;
  if (slide) f.pos.addScaledVector(flat.set(-Math.cos(f.yaw), 0, Math.sin(f.yaw)), slide * dt);
}

/**
 * The stick that brings the nose onto a direction (the pointer's): how hard to
 * turn and to pitch for the angle that is left. `dir` is a unit vector.
 */
export function stickToward(f: Flight, dir: Vector3, out: { x: number; y: number }): void {
  const fx = Math.sin(f.yaw);
  const fz = Math.cos(f.yaw);
  // Signed angle on the ground between the nose and the direction: > 0 = it is on the right.
  const side = dir.x * -fz + dir.z * fx;
  const ahead = dir.x * fx + dir.z * fz;
  const yawErr = Math.atan2(side, ahead);
  const pitchErr = Math.asin(Math.max(-1, Math.min(1, dir.y))) - f.pitch;
  out.x = Math.max(-1, Math.min(1, yawErr * 2.6));
  out.y = Math.max(-1, Math.min(1, pitchErr * 3));
}
