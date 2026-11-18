// The robots a vehicle fights: who they are, and how each one fights.
//
// In the air:
//   drone    a swarm that makes passes, a few shots each time
//   gunner   a robot on a jetpack: keeps its distance, fires aimed bursts
//   ace      a robot on a wing: gets on your tail, and (later) fires missiles
//   bomber   a gunship: slow and thick, missiles, a turret, drones in its hold
//   boss     the dreadnought
// On the water (they meet the boat only):
//   skimmer  a robot on a jet-ski: circles, fires, cuts across the bow
//   mine     drifts to the boat and goes off against its hull
//   warship  the robots' own gunboat: a turret, missiles, mines over the side
//
// A foe only knows what `FoeCtx` tells it, and only acts through it: the shots,
// the missiles and the newcomers belong to the fight (combat.ts). None of them
// may enter the land, the sea or a tower: `settle` holds them out.
import { Vector3, type Group } from 'three';
import type { Tower } from './world';

export type FoeKind = 'drone' | 'gunner' | 'ace' | 'bomber' | 'boss' | 'skimmer' | 'mine' | 'warship';

/** `from`: the first wave it shows up in; `cost`: what it takes from a wave's budget. */
export const FOES: Record<FoeKind, {
  hp: number; speed: number; turn: number; radius: number; score: number; cost: number; from: number;
  weight: number; blast: number; ram: number; sea?: boolean; heavy?: boolean;
}> = {
  drone: { hp: 2, speed: 116, turn: 1.9, radius: 6, score: 15, cost: 1, from: 5, weight: 6, blast: 1, ram: 14 },
  gunner: { hp: 6, speed: 104, turn: 0, radius: 9, score: 40, cost: 2, from: 5, weight: 4, blast: 1.5, ram: 18 },
  ace: { hp: 8, speed: 126, turn: 1.45, radius: 9, score: 60, cost: 3, from: 6, weight: 3, blast: 1.7, ram: 20 },
  bomber: { hp: 46, speed: 46, turn: 0.5, radius: 24, score: 250, cost: 7, from: 7, weight: 1, blast: 3.4, ram: 40, heavy: true },
  boss: { hp: 300, speed: 40, turn: 0.4, radius: 46, score: 2500, cost: 0, from: 7, weight: 0, blast: 7, ram: 60, heavy: true },
  skimmer: { hp: 4, speed: 62, turn: 1.7, radius: 5, score: 30, cost: 1.5, from: 5, weight: 6, blast: 1.2, ram: 14, sea: true },
  mine: { hp: 3, speed: 15, turn: 1.2, radius: 4, score: 10, cost: 0.5, from: 5, weight: 5, blast: 2.2, ram: 30, sea: true },
  warship: { hp: 60, speed: 24, turn: 0.45, radius: 15, score: 300, cost: 7, from: 7, weight: 1, blast: 3.6, ram: 40, sea: true, heavy: true },
};

/** Who a wave may bring, by what the player drives. */
export const POOLS: Record<'plane' | 'boat', FoeKind[]> = {
  plane: ['drone', 'gunner', 'ace', 'bomber'],
  boat: ['skimmer', 'mine', 'drone', 'gunner', 'warship'],
};

/** How many of a kind come together. */
export const FLIGHT_OF: Record<FoeKind, number> = { drone: 4, gunner: 2, ace: 2, bomber: 1, boss: 1, skimmer: 3, mine: 4, warship: 1 };

export type Foe = {
  kind: FoeKind;
  mesh: Group;
  pos: Vector3;
  /** Where it travels (a unit vector) and how fast. */
  dir: Vector3;
  vel: Vector3;
  speed: number;
  hp: number;
  maxHp: number;
  /** Seconds of swelling after a hit. */
  flash: number;
  t: number;
  state: number;
  /** Its own clocks: the next shot, the next burst or pattern, the next missile, the next brood. */
  shotIn: number;
  burst: number;
  nextIn: number;
  missileIn: number;
  spawnIn: number;
  seed: number;
  dead: boolean;
};

export type FoeCtx = {
  /** The player's craft: where it is and where it points. */
  target: { pos: Vector3; fwd: Vector3 };
  /** Its velocity, to lead it. */
  velocity: Vector3;
  /** It is on the water: what flies comes down to it. */
  afloat: boolean;
  wave: number;
  /** The foe the player's missile is locking on, if any. */
  locked: Foe | null;
  foes: number;
  groundAt: (x: number, z: number) => number;
  towers: Tower[];
  /** One shot from a point, along a direction. */
  fire: (from: Vector3, dir: Vector3, speed: number, damage: number) => void;
  /** A homing missile. */
  launch: (from: Vector3, dir: Vector3) => void;
  spawn: (kind: FoeKind, at: Vector3) => void;
};

/** How high above the water a surface craft rides. */
const RIDE = 1.2;

export function makeFoe(kind: FoeKind, mesh: Group, at: Vector3, heading: Vector3, wave: number): Foe {
  const def = FOES[kind];
  const later = Math.max(0, wave - 5);
  const hp = Math.ceil(def.hp * (1 + 0.1 * later) * (kind === 'boss' ? 1 + (Math.max(0, wave - 7) / 5) * 0.6 : 1));
  const dir = heading.clone();
  if (def.sea) dir.y = 0;
  dir.normalize();
  const pos = at.clone();
  if (def.sea) pos.y = RIDE;
  return {
    kind, mesh, pos, dir, vel: dir.clone().multiplyScalar(def.speed), speed: def.speed * (1 + Math.min(0.3, 0.02 * later)),
    hp, maxHp: hp, flash: 0, t: 0, state: 0, shotIn: 1 + Math.random(), burst: 0, nextIn: 2 + Math.random() * 2,
    missileIn: 6 + Math.random() * 4, spawnIn: 8 + Math.random() * 4, seed: Math.random() * 100, dead: false,
  };
}

const to = new Vector3();
const want = new Vector3();
const aim = new Vector3();
const side = new Vector3();
const tmp = new Vector3();
const probe = new Vector3();
const prev = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Turn a foe's heading toward a direction, at most `rate` radians per second. */
function steer(f: Foe, toward: Vector3, rate: number, dt: number): void {
  const angle = Math.acos(Math.max(-1, Math.min(1, f.dir.dot(toward))));
  if (angle < 1e-3) return;
  f.dir.lerp(toward, Math.min(1, (rate * dt) / angle)).normalize();
}

/** Where to shoot to hit the player: ahead of it, with an error that grows with the spread. */
function lead(from: Vector3, ctx: FoeCtx, shotSpeed: number, spread: number, out: Vector3): Vector3 {
  const t = from.distanceTo(ctx.target.pos) / shotSpeed;
  out.copy(ctx.target.pos).addScaledVector(ctx.velocity, t).sub(from).normalize();
  out.x += (Math.random() - 0.5) * spread;
  out.y += (Math.random() - 0.5) * spread;
  out.z += (Math.random() - 0.5) * spread;
  return out.normalize();
}

/** Keep off what is under it and what is ahead of it, and under the ceiling: bend the wanted direction. */
function keepAloft(f: Foe, ctx: FoeCtx, floor: number): void {
  // What it would fly into in half a second counts as much as what it is over.
  probe.copy(f.pos).addScaledVector(f.dir, f.speed * 0.5);
  const ground = Math.max(ctx.groundAt(f.pos.x, f.pos.z), ctx.groundAt(probe.x, probe.z));
  if (f.pos.y < ground + floor) want.y += ((ground + floor - f.pos.y) / floor) * 1.6;
  else if (f.pos.y > 560) want.y -= (f.pos.y - 560) / 80;
  want.normalize();
}

/** On the water: head where it wants, round the land. */
function sail(f: Foe, ctx: FoeCtx, rate: number, dt: number): void {
  want.y = 0;
  if (want.lengthSq() < 1e-6) want.copy(f.dir);
  want.normalize();
  // Land ahead: the first clear bearing to one side or the other.
  const reach = 26 + f.speed * 0.6;
  if (ctx.groundAt(f.pos.x + want.x * reach, f.pos.z + want.z * reach) > 0) {
    const first = f.seed > 50 ? 1 : -1;
    for (const a of [0.7 * first, -0.7 * first, 1.4 * first, -1.4 * first, 2.4 * first]) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      tmp.set(want.x * c - want.z * s, 0, want.x * s + want.z * c);
      if (ctx.groundAt(f.pos.x + tmp.x * reach, f.pos.z + tmp.z * reach) <= 0) { want.copy(tmp); break; }
    }
  }
  steer(f, want, rate, dt);
  f.dir.y = 0;
  f.dir.normalize();
  f.vel.copy(f.dir).multiplyScalar(f.speed);
}

/** Nothing passes through the land, the sea or a tower: after its move, a foe is put back outside. */
function settle(f: Foe, ctx: FoeCtx, before: Vector3): void {
  const def = FOES[f.kind];
  if (def.sea) {
    // The shore stops it.
    if (ctx.groundAt(f.pos.x, f.pos.z) > 0) { f.pos.copy(before); f.dir.negate(); }
    f.pos.y = RIDE + Math.sin(f.t * 2.2 + f.seed) * 0.35;
    return;
  }
  const floor = ctx.groundAt(f.pos.x, f.pos.z) + def.radius * 0.7 + 2.5;
  if (f.pos.y < floor) {
    f.pos.y = floor;
    if (f.dir.y < 0.2) { f.dir.y = 0.35; f.dir.normalize(); }
    f.vel.y = Math.max(0, f.vel.y);
  }
  for (const tower of ctx.towers) {
    if (f.pos.y > tower.top + def.radius) continue;
    const dx = f.pos.x - tower.x;
    const dz = f.pos.z - tower.z;
    const d = Math.hypot(dx, dz) || 1;
    const min = tower.r + def.radius;
    if (d < min) { f.pos.x = tower.x + (dx / d) * min; f.pos.z = tower.z + (dz / d) * min; }
  }
}

export function stepFoe(f: Foe, ctx: FoeCtx, dt: number): void {
  const def = FOES[f.kind];
  const p = ctx.target;
  f.t += dt;
  f.flash = Math.max(0, f.flash - dt);
  to.copy(p.pos).sub(f.pos);
  const dist = to.length() || 1;
  to.multiplyScalar(1 / dist);
  // Later waves shoot a little faster and straighter.
  const keen = Math.min(1, Math.max(0, ctx.wave - 5) / 10);
  const before = prev.copy(f.pos);

  if (f.kind === 'drone') {
    if (f.state === 0) {
      // A pass: straight at where the player will be, a few shots on the way in.
      lead(f.pos, ctx, f.speed, 0, want);
      keepAloft(f, ctx, 14);
      steer(f, want, def.turn, dt);
      f.shotIn -= dt;
      if (dist < 280 && f.dir.dot(to) > 0.975 && f.shotIn <= 0) {
        ctx.fire(f.pos, lead(f.pos, ctx, 200, 0.05 - keen * 0.02, aim), 200, 5);
        f.burst += 1;
        f.shotIn = f.burst >= 3 ? 1.9 - keen * 0.5 : 0.2;
        if (f.burst >= 3) f.burst = 0;
      }
      if (dist < 46) { f.state = 1; f.nextIn = 1.1 + Math.random() * 0.8; }
    } else {
      // Breaks off, up and to a side, and comes round again.
      side.crossVectors(to, UP).normalize().multiplyScalar(f.seed > 50 ? 1 : -1);
      want.copy(to).negate().multiplyScalar(0.4).add(side).addScaledVector(UP, 0.45).normalize();
      keepAloft(f, ctx, 14);
      steer(f, want, def.turn * 1.2, dt);
      f.nextIn -= dt;
      if (f.nextIn <= 0) f.state = 0;
    }
    f.vel.copy(f.dir).multiplyScalar(f.speed);
  } else if (f.kind === 'gunner') {
    // Hovers on a circle around the player, facing it.
    const a = f.seed + f.t * 0.5 * (f.seed > 50 ? 1 : -1);
    const ring = ctx.afloat ? 150 : 230;
    tmp.set(Math.cos(a) * ring, (ctx.afloat ? 50 : 26) + Math.sin(f.t * 0.7 + f.seed) * 30, Math.sin(a) * ring).add(p.pos).addScaledVector(p.fwd, ctx.afloat ? 40 : 120);
    tmp.y = Math.max(ctx.groundAt(tmp.x, tmp.z) + 30, Math.min(560, tmp.y));
    want.copy(tmp).sub(f.pos);
    const gap = want.length();
    want.multiplyScalar(gap > 1 ? Math.min(f.speed, gap * 1.5) / gap : 0);
    f.vel.lerp(want, 1 - Math.exp(-2.2 * dt));
    f.dir.copy(to);
    f.shotIn -= dt;
    if (f.shotIn <= 0 && dist < 520) {
      ctx.fire(tmp.copy(f.pos).addScaledVector(to, 6), lead(f.pos, ctx, 205, 0.06 - keen * 0.025, aim), 205, 7);
      f.burst += 1;
      f.shotIn = f.burst >= 3 ? 2.7 - keen * 0.9 : 0.15;
      if (f.burst >= 3) f.burst = 0;
    }
  } else if (f.kind === 'ace') {
    if (f.state === 0) {
      // Gets behind the player, then onto it.
      const behind = to.dot(p.fwd) > 0.2 && dist < 380;
      if (behind) want.copy(to);
      else want.copy(p.pos).addScaledVector(p.fwd, -90).sub(f.pos).normalize();
      // Locked on, it jinks.
      if (ctx.locked === f) {
        side.crossVectors(f.dir, UP).normalize();
        want.addScaledVector(side, Math.sin(f.t * 5 + f.seed) * 0.8).addScaledVector(UP, Math.cos(f.t * 3.7 + f.seed) * 0.4).normalize();
      }
      keepAloft(f, ctx, 18);
      steer(f, want, def.turn, dt);
      if (dist < 340 && f.dir.dot(to) > 0.985) {
        f.shotIn -= dt;
        if (f.shotIn <= 0) {
          ctx.fire(tmp.copy(f.pos).addScaledVector(f.dir, 8), lead(f.pos, ctx, 215, 0.045 - keen * 0.02, aim), 215, 6);
          f.shotIn = 0.17;
          f.burst += 1;
          if (f.burst >= 7) { f.burst = 0; f.state = 1; f.nextIn = 1.4 + Math.random(); }
        }
      }
      if (dist < 40) { f.state = 1; f.nextIn = 1.2; }
      f.missileIn -= dt;
      if (ctx.wave >= 8 && f.missileIn <= 0 && dist > 170 && dist < 540 && f.dir.dot(to) > 0.8) {
        ctx.launch(tmp.copy(f.pos).addScaledVector(f.dir, 8), f.dir);
        f.missileIn = 11 - keen * 4;
      }
    } else {
      // Extends: away and up, to come back with speed.
      side.crossVectors(to, UP).normalize().multiplyScalar(f.seed > 50 ? 1 : -1);
      want.copy(to).negate().multiplyScalar(0.5).add(side).addScaledVector(UP, 0.3).normalize();
      keepAloft(f, ctx, 18);
      steer(f, want, def.turn, dt);
      f.nextIn -= dt;
      if (f.nextIn <= 0) f.state = 0;
    }
    f.vel.copy(f.dir).multiplyScalar(f.speed);
  } else if (f.kind === 'skimmer') {
    // Round the boat at a distance, closing in and opening out; now and then, straight across its bow.
    if (f.state === 0) {
      const turn = f.seed > 50 ? 1 : -1;
      const ring = 95 + Math.sin(f.t * 0.6 + f.seed) * 35;
      want.set(-to.z * turn + to.x * ((dist - ring) / 60), 0, to.x * turn + to.z * ((dist - ring) / 60));
      f.nextIn -= dt;
      if (f.nextIn <= 0 && dist < 220) { f.state = 1; f.nextIn = 2.2; }
    } else {
      want.copy(p.pos).addScaledVector(p.fwd, 26).sub(f.pos);
      f.nextIn -= dt;
      if (f.nextIn <= 0 || dist < 16) { f.state = 0; f.nextIn = 5 + Math.random() * 4; }
    }
    sail(f, ctx, def.turn, dt);
    f.shotIn -= dt;
    if (f.shotIn <= 0 && dist < 260) {
      ctx.fire(tmp.copy(f.pos).addScaledVector(UP, 3), lead(f.pos, ctx, 190, 0.07 - keen * 0.03, aim), 190, 5);
      f.burst += 1;
      f.shotIn = f.burst >= 2 ? 2.1 - keen * 0.6 : 0.18;
      if (f.burst >= 2) f.burst = 0;
    }
  } else if (f.kind === 'mine') {
    // Drifts to where the boat is.
    want.copy(to);
    sail(f, ctx, def.turn, dt);
  } else if (f.kind === 'warship') {
    // Stands off the boat, broadside on, and works its guns.
    const turn = f.seed > 50 ? 1 : -1;
    want.set(-to.z * turn + to.x * ((dist - 210) / 90), 0, to.x * turn + to.z * ((dist - 210) / 90));
    sail(f, ctx, def.turn, dt);
    f.shotIn -= dt;
    if (f.shotIn <= 0 && dist < 440) {
      ctx.fire(tmp.copy(f.pos).addScaledVector(UP, 5), lead(f.pos, ctx, 200, 0.06 - keen * 0.025, aim), 200, 8);
      f.shotIn = 1.1 - keen * 0.35;
    }
    f.missileIn -= dt;
    if (f.missileIn <= 0 && dist < 700) {
      ctx.launch(tmp.copy(f.pos).addScaledVector(UP, 8), aim.copy(to).setY(0.5).normalize());
      f.missileIn = 8.5 - keen * 2.5;
    }
    f.spawnIn -= dt;
    if (f.spawnIn <= 0 && ctx.foes < 22) {
      side.crossVectors(f.dir, UP).normalize();
      for (const off of [-22, 22]) ctx.spawn('mine', tmp.copy(f.pos).addScaledVector(side, off));
      f.spawnIn = 11;
    }
  } else {
    // The heavy ones of the air circle the home island, and bring their weapons to bear.
    const boss = f.kind === 'boss';
    const ring = boss ? 330 : 420;
    const height = ctx.afloat ? (boss ? 150 : 120) : boss ? 250 : 215;
    const r = Math.hypot(f.pos.x, f.pos.z) || 1;
    const turn = f.seed > 50 ? 1 : -1;
    // Along the circle, pulled back onto it.
    want.set((-f.pos.z / r) * turn + (-f.pos.x / r) * ((r - ring) / 220), (height - f.pos.y) / 120, (f.pos.x / r) * turn + (-f.pos.z / r) * ((r - ring) / 220)).normalize();
    steer(f, want, def.turn, dt);
    f.vel.copy(f.dir).multiplyScalar(f.speed);

    if (!boss) {
      f.shotIn -= dt;
      if (f.shotIn <= 0 && dist < 360) {
        ctx.fire(f.pos, lead(f.pos, ctx, 200, 0.07 - keen * 0.03, aim), 200, 7);
        f.shotIn = 1.3 - keen * 0.4;
      }
      f.missileIn -= dt;
      if (f.missileIn <= 0 && dist < 820) {
        ctx.launch(tmp.copy(f.pos).addScaledVector(UP, -8), to);
        f.missileIn = 7.5 - keen * 2.5;
      }
      f.spawnIn -= dt;
      if (f.spawnIn <= 0 && ctx.foes < 22) {
        side.crossVectors(f.dir, UP).normalize();
        for (const off of [-16, 16]) ctx.spawn('drone', tmp.copy(f.pos).addScaledVector(UP, -10).addScaledVector(side, off));
        f.spawnIn = 12;
      }
    } else {
      // The dreadnought runs through its weapons, one after the other.
      if (f.burst > 0) {
        // A stream under way.
        f.shotIn -= dt;
        if (f.shotIn <= 0) {
          ctx.fire(tmp.copy(f.pos).addScaledVector(UP, -12).addScaledVector(to, 30), lead(f.pos, ctx, 215, 0.035, aim), 215, 7);
          f.shotIn = 0.11;
          f.burst -= 1;
        }
      }
      f.nextIn -= dt;
      if (f.nextIn <= 0 && dist < 1100) {
        f.nextIn = 3.3 - keen * 0.8;
        f.state = (f.state + 1) % 4;
        side.crossVectors(to, UP).normalize();
        if (f.state === 0) {
          // A ring that opens as it comes.
          aim.crossVectors(side, to).normalize();
          for (let i = 0; i < 14; i += 1) {
            const a = (i / 14) * Math.PI * 2 + f.t;
            want.copy(to).addScaledVector(side, Math.cos(a) * 0.3).addScaledVector(aim, Math.sin(a) * 0.3).normalize();
            ctx.fire(tmp.copy(f.pos).addScaledVector(to, 34), want, 150, 9);
          }
        } else if (f.state === 1) f.burst = 13;
        else if (f.state === 2) {
          for (const off of [-40, 0, 40]) ctx.launch(tmp.copy(f.pos).addScaledVector(side, off).addScaledVector(UP, -14), to);
        } else if (ctx.foes < 20) {
          side.crossVectors(f.dir, UP).normalize();
          for (const off of [-50, 0, 50]) ctx.spawn('drone', tmp.copy(f.pos).addScaledVector(side, off).addScaledVector(UP, -24));
        }
      }
    }
  }

  f.pos.addScaledVector(f.vel, dt);
  settle(f, ctx, before);

  // Where it looks: along its way — a gunner at the player, the dreadnought slowly toward it.
  f.mesh.position.copy(f.pos);
  if (f.kind === 'boss') {
    f.mesh.lookAt(tmp.copy(f.pos).add(aim.copy(to).setY(to.y * 0.3)));
  } else if (f.kind === 'mine') {
    f.mesh.rotation.y = f.t * 0.6 + f.seed;
  } else {
    f.mesh.lookAt(tmp.copy(f.pos).add(f.dir));
    // What banks, banks into its turn.
    if (f.kind === 'drone' || f.kind === 'ace' || f.kind === 'skimmer') {
      f.mesh.rotateZ(Math.max(-0.9, Math.min(0.9, -aim.copy(f.dir).cross(want).y * 1.6)));
    }
  }
}
