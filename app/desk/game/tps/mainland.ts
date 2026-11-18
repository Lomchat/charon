// The mainland: one immense island beyond the archipelago, with beaches all
// round, plains, forests and a mountain spine. It is where the machine
// becomes a tank. Unlike the board's islands (flat tops raised from the
// layout) this is ground with a relief: a height at every point, which the
// tank follows and everything else stays above.
//
// Built once per run from a seed; nothing here reads a session.
import { BufferGeometry, Color, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, Object3D } from 'three';
import { LAND } from '../art';
import { seeded } from '../model';
import { buildModel, materials, type Box, type Model } from './voxels';

/** Half its width (east–west) and half its depth (north–south), world units. */
export const MAINLAND_RX = 760;
export const MAINLAND_RZ = 520;
/** One square of its ground. */
const CELL = 16;
/** How far past its nominal shape the ground is modelled (capes, the seabed off the beaches). */
const MARGIN = 1.2;

export type Mainland = {
  group: Group;
  x: number;
  z: number;
  rx: number;
  rz: number;
  /** The ground at a point: under 0 on the seabed around it, −Infinity out of its waters. */
  heightAt: (x: number, z: number) => number;
  dispose: () => void;
};

const SAND = ['#6c6850', '#757158', '#625f4a'];
const GRASS = [LAND.grass, LAND.grassDark, LAND.grassLight, LAND.grass, '#27402f'];
const ROCK = ['#3a4356', '#434d63', '#323a4c'];
const SNOW = ['#8f9cb8', '#a3afc9'];

function pine(): Box[] {
  return [
    [-0.5, 0, -0.5, 1, 3, 1, '#3a2c24'],
    [-2.6, 2.4, -2.6, 5.2, 2.4, 5.2, '#1c3a2c'],
    [-1.9, 4.8, -1.9, 3.8, 2.4, 3.8, '#22463a'],
    [-1.1, 7.2, -1.1, 2.2, 2.6, 2.2, '#2c5a44'],
  ];
}

function rock(): Box[] {
  return [
    [-2.2, 0, -1.8, 4.4, 2.2, 3.6, '#3a4356'],
    [-1.2, 2.2, -1.1, 2.6, 1.3, 2.2, '#4a556c'],
    [1.6, 0, 0.6, 2, 1.2, 1.8, '#323a4c'],
  ];
}

/** A lamp post by the shore: what tells the beach from the night. */
function beacon(): Box[] {
  return [
    [-0.4, 0, -0.4, 0.8, 6, 0.8, '#1c2230'],
    [-1, 6, -1, 2, 0.5, 2, '#343c50'],
    [-0.7, 6.5, -0.7, 1.4, 1.6, 1.4, '!#ffd27a'],
    [-1, 8.1, -1, 2, 0.4, 2, '#343c50'],
  ];
}

export function buildMainland(seed: number, cx: number, cz: number): Mainland {
  const rand = seeded(seed ^ 0x7a11);
  const p1 = rand() * 6.28;
  const p2 = rand() * 6.28;
  const p3 = rand() * 6.28;
  const ox = rand() * 400;
  const oz = rand() * 400;

  // Value noise, smooth between the corners of a lattice.
  const corner = (ix: number, iz: number): number => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x: number, z: number): number => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = corner(ix, iz);
    const b = corner(ix + 1, iz);
    const c = corner(ix, iz + 1);
    const d = corner(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
  const fbm = (x: number, z: number): number => noise(x, z) * 0.55 + noise(x * 2.1 + 9.2, z * 2.1 + 3.7) * 0.3 + noise(x * 4.3 + 1.3, z * 4.3 + 7.1) * 0.15;
  const smooth = (k: number): number => { const c = Math.max(0, Math.min(1, k)); return c * c * (3 - 2 * c); };

  /** The relief, from the middle of the island (local units). */
  const relief = (x: number, z: number): number => {
    const u = x / MAINLAND_RX;
    const v = z / MAINLAND_RZ;
    const r = Math.hypot(u, v);
    const th = Math.atan2(v, u);
    // Capes and bays.
    const coast = 1 + 0.09 * Math.sin(3 * th + p1) + 0.06 * Math.sin(5 * th + p2) + 0.035 * Math.sin(8 * th + p3);
    const d = coast - r;
    // The seabed shelves away from the beach.
    if (d < 0) return Math.max(-9, d * 70);
    const beach = Math.min(1, d / 0.045);
    const inland = smooth((d - 0.045) / 0.3);
    const hills = fbm((x + ox) / 230, (z + oz) / 230);
    const spine = 1 - Math.abs(2 * fbm((x + ox) / 430 + 7, (z + oz) / 430) - 1);
    return beach * 2.4 + inland * (3 + 30 * hills * hills + 36 * inland * spine * spine * hills);
  };

  // The ground, as a grid of heights.
  const nx = Math.ceil((MAINLAND_RX * MARGIN * 2) / CELL);
  const nz = Math.ceil((MAINLAND_RZ * MARGIN * 2) / CELL);
  const x0 = -(nx * CELL) / 2;
  const z0 = -(nz * CELL) / 2;
  const heights = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j += 1) for (let i = 0; i <= nx; i += 1) heights[j * (nx + 1) + i] = relief(x0 + i * CELL, z0 + j * CELL);
  const at = (i: number, j: number): number => heights[j * (nx + 1) + i];

  const heightAt = (wx: number, wz: number): number => {
    const gx = (wx - cx - x0) / CELL;
    const gz = (wz - cz - z0) / CELL;
    if (gx < 0 || gz < 0 || gx >= nx || gz >= nz) return -Infinity;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    // The very triangles that are drawn: two per square, cut the same way.
    if (fx + fz <= 1) return at(i, j) + (at(i + 1, j) - at(i, j)) * fx + (at(i, j + 1) - at(i, j)) * fz;
    return at(i + 1, j + 1) + (at(i, j + 1) - at(i + 1, j + 1)) * (1 - fx) + (at(i + 1, j) - at(i + 1, j + 1)) * (1 - fz);
  };

  // Its mesh: flat faces, each one colour (what grows or lies there).
  const position: number[] = [];
  const normal: number[] = [];
  const colours: number[] = [];
  const colour = new Color();
  const face = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, qx: number, qy: number, qz: number): void => {
    if (ay < -3 && by < -3 && qy < -3) return;
    // Counter-clockwise seen from above.
    const ux = bx - ax; const uy = by - ay; const uz = bz - az;
    const vx = qx - ax; const vy = qy - ay; const vz = qz - az;
    let px = uy * vz - uz * vy; let py = uz * vx - ux * vz; let pz = ux * vy - uy * vx;
    const len = Math.hypot(px, py, pz) || 1;
    px /= len; py /= len; pz /= len;
    const h = (ay + by + qy) / 3;
    const pick = corner(Math.round(ax * 3 + bx), Math.round(az * 3 + qz));
    const from = py < 0.8 && h > 4 ? ROCK : h < 2.7 ? SAND : h > 58 ? SNOW : h > 42 ? ROCK : GRASS;
    colour.set(from[Math.floor(pick * from.length) % from.length]);
    position.push(ax, ay, az, bx, by, bz, qx, qy, qz);
    for (let n = 0; n < 3; n += 1) { normal.push(px, py, pz); colours.push(colour.r, colour.g, colour.b); }
  };
  for (let j = 0; j < nz; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const xa = x0 + i * CELL; const xb = xa + CELL;
      const za = z0 + j * CELL; const zb = za + CELL;
      face(xa, at(i, j), za, xa, at(i, j + 1), zb, xb, at(i + 1, j), za);
      face(xb, at(i + 1, j + 1), zb, xb, at(i + 1, j), za, xa, at(i, j + 1), zb);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  const { lit, glow } = materials();
  const group = new Group();
  group.position.set(cx, 0, cz);
  const ground = new Mesh(geometry, lit);
  ground.frustumCulled = false;
  group.add(ground);

  // What stands on it: pines in patches, rocks, lamps along the shore.
  const owned: Array<{ dispose: () => void }> = [geometry];
  const pose = new Object3D();
  const scatter = (model: Model, spots: Matrix4[]): void => {
    for (const part of [[model.lit, lit], [model.glow, glow]] as const) {
      if (!part[0] || !spots.length) continue;
      const mesh = new InstancedMesh(part[0], part[1], spots.length);
      spots.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      owned.push(mesh);
    }
    if (model.lit) owned.push(model.lit);
    if (model.glow) owned.push(model.glow);
  };
  const stand = (x: number, z: number, scale: number, turn: number): Matrix4 => {
    pose.position.set(x, relief(x, z) - 0.3, z);
    pose.rotation.set(0, turn, 0);
    pose.scale.setScalar(scale);
    pose.updateMatrix();
    return pose.matrix.clone();
  };
  const pines: Matrix4[] = [];
  const rocks: Matrix4[] = [];
  const lamps: Matrix4[] = [];
  for (let n = 0; n < 2600 && pines.length < 420; n += 1) {
    const x = (rand() * 2 - 1) * MAINLAND_RX;
    const z = (rand() * 2 - 1) * MAINLAND_RZ;
    const h = relief(x, z);
    if (h < 3.4 || h > 36 || fbm((x + oz) / 150, (z + ox) / 150) < 0.52) continue;
    pines.push(stand(x, z, 1.3 + rand() * 1.5, rand() * 6.28));
  }
  for (let n = 0; n < 900 && rocks.length < 110; n += 1) {
    const x = (rand() * 2 - 1) * MAINLAND_RX;
    const z = (rand() * 2 - 1) * MAINLAND_RZ;
    if (relief(x, z) < 1) continue;
    rocks.push(stand(x, z, 0.8 + rand() * 2.2, rand() * 6.28));
  }
  // Round the coast, at the back of the beach.
  for (let n = 0; n < 26; n += 1) {
    const th = (n / 26) * Math.PI * 2 + rand() * 0.1;
    let r = 1.2;
    let x = 0;
    let z = 0;
    for (; r > 0.3; r -= 0.004) {
      x = Math.cos(th) * MAINLAND_RX * r;
      z = Math.sin(th) * MAINLAND_RZ * r;
      if (relief(x, z) > 2.2) break;
    }
    lamps.push(stand(x, z, 1.5, 0));
  }
  scatter(buildModel(pine()), pines);
  scatter(buildModel(rock()), rocks);
  scatter(buildModel(beacon()), lamps);

  return {
    group, x: cx, z: cz, rx: MAINLAND_RX, rz: MAINLAND_RZ, heightAt,
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}
