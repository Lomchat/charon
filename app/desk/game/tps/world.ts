// The archipelago in 3D: the board's own layout (layout.ts) raised into
// islands, on a night sea under a moon. Same machines, same decks, same
// beacons — a machine is still an island, a working directory still a deck.
//
// ONE scale for everything: a board pixel is `SCALE` units, whether the pilot
// walks the island, sails round it or flies over it. That is what lets the
// fight go from one to the other without a seam.
//
// Built once per run; nothing here reads a session.
import {
  AdditiveBlending, BackSide, BoxGeometry, BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute,
  Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, NearestFilter, Object3D, PlaneGeometry,
  Points, PointsMaterial, Quaternion, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, Vector3,
} from 'three';
import { LAND, T, WATER } from '../art';
import type { Island, World } from '../layout';
import { hashStr, seeded } from '../model';
import { buildMainland, MAINLAND_RZ, type Mainland } from './mainland';
import { skyModels } from './models';
import { materials, type Model } from './voxels';

/** World units per board pixel (the seaplane spans 19 units, the pilot stands 6 tall). */
export const SCALE = 0.45;
/** The top of every island, over a sea at 0. */
export const LAND_Y = 5;
const DECK_Y = LAND_Y + 0.4;
const TILE = T * SCALE;

/** The horizon: what the distance fades to. */
export const HAZE = '#1a3352';
export const FOG_DENSITY = 0.00062;
/** Where the moon hangs (a unit vector), and the light that comes from it. */
export const MOON = new Vector3(-0.46, 0.4, 0.79).normalize();

export type Tower = { x: number; z: number; r: number; top: number };

export type SkyWorld = {
  group: Group;
  /** A board point (pixels) in the world, and back. */
  toWorld: (px: number, py: number, out: Vector3) => Vector3;
  boardX: (x: number) => number;
  boardY: (z: number) => number;
  /** The height of what lies under a point: the sea (0), an island's top, the mainland's relief. */
  groundAt: (x: number, z: number) => number;
  /** The immense island north of the archipelago: ground with a relief (its `heightAt` goes under 0 off its beaches). */
  mainland: Mainland;
  towers: Tower[];
  /** The island the run started on: its centre and half-sizes. */
  home: { x: number; z: number; hw: number; hd: number };
  /** Every island, for the radar: centre and half-sizes. */
  isles: Array<{ x: number; z: number; hw: number; hd: number }>;
  /** How far from home the fight may go. */
  radius: number;
  update: (time: number, eye: Vector3) => void;
  dispose: () => void;
};

/** A soft round light, for halos (drawn chunky by the low-resolution stage). */
export function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

function moonTexture(): CanvasTexture {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d')!;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      if (d > 14) continue;
      // A crescent of shade on one side, a few seas.
      const shade = Math.hypot(x - 21, y - 12) < 13 ? 0 : 1;
      const sea = (Math.hypot(x - 11, y - 10) < 3.2 || Math.hypot(x - 18, y - 20) < 2.6 || Math.hypot(x - 9, y - 19) < 1.8) ? 1 : 0;
      g.fillStyle = shade ? (sea ? '#8a96b4' : '#aab6d2') : sea ? '#cfd8ec' : '#f1f4fb';
      g.fillRect(x, y, 1, 1);
    }
  }
  const t = new CanvasTexture(c);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  return t;
}

const SEA_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// The board's water (scenery.ts): a dark sea, patches a shade lighter, short
// ripples that come and go — and here, a path of glints toward the moon.
const SEA_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uRipple;
  uniform vec3 uGlint;
  uniform vec3 uHaze;
  uniform float uDensity;
  uniform vec2 uMoon;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 p = vWorld.xz;
    vec3 toEye = vWorld - cameraPosition;
    float dist = length(toEye);
    float near = 1.0 - smoothstep(220.0, 900.0, dist);
    // The swell: broad bands that drift, in a few flat steps.
    float swell = sin(p.x * 0.011 + uTime * 0.22) + sin(p.y * 0.016 - uTime * 0.18) + sin((p.x + p.y) * 0.007 + uTime * 0.12);
    vec3 col = mix(uDeep, uMid, floor((swell + 3.0) / 6.0 * 5.0) / 5.0);
    // Close by, patches a shade lighter.
    col = mix(col, uMid, step(0.62, hash(floor(p / 56.0))) * 0.45 * near);
    // Ripples: dashes along x, on rows; each cell lights up now and then.
    vec2 cell = vec2(floor(p.x / 16.0), floor(p.y / 7.0));
    float seed = hash(cell);
    float beat = floor(uTime * 0.7 + seed * 9.0);
    float lit = step(0.84, hash(cell + beat * 0.37));
    float dash = step(fract(p.y / 7.0), 0.3) * step(fract(p.x / 16.0), 0.3 + 0.55 * seed);
    col = mix(col, uRipple, lit * dash * near);
    // Close by (on foot, from a deck), smaller ripples between the big ones.
    vec2 fine = vec2(floor(p.x / 5.0), floor(p.y / 2.2));
    float fseed = hash(fine + 7.0);
    float flit = step(0.8, hash(fine + floor(uTime * 0.9 + fseed * 7.0) * 0.61));
    float fdash = step(fract(p.y / 2.2), 0.34) * step(fract(p.x / 5.0), 0.25 + 0.6 * fseed);
    col = mix(col, uRipple, flit * fdash * (1.0 - smoothstep(40.0, 150.0, dist)) * 0.8);
    // The moon's path: where the eye looks toward it, the ripples catch its light.
    float toward = dot(normalize(toEye.xz), uMoon);
    float path = smoothstep(0.972, 0.998, toward) * smoothstep(60.0, 420.0, dist);
    float spark = step(0.52, hash(cell * 1.7 + floor(uTime * 1.6 + seed * 5.0)));
    col = mix(col, uGlint, path * spark * dash * 0.9);
    col = mix(col, uRipple, path * 0.22);
    float fog = 1.0 - exp(-uDensity * uDensity * dist * dist);
    gl_FragColor = vec4(mix(col, uHaze, fog), 1.0);
    #include <colorspace_fragment>
  }
`;

const DOME_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAGMENT = /* glsl */ `
  uniform vec3 uHaze;
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uMoonDir;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -1.0, 1.0);
    // Banded, as a pixel sky is: a few flat steps from the horizon up.
    float up = floor(clamp(h, 0.0, 1.0) * 14.0) / 14.0;
    vec3 col = mix(uHaze, uLow, smoothstep(0.0, 0.3, up));
    col = mix(col, uHigh, smoothstep(0.25, 0.9, up));
    // The moon lights the sky around it.
    float m = max(0.0, dot(normalize(vDir), uMoonDir));
    col += vec3(0.1, 0.13, 0.2) * floor(pow(m, 26.0) * 4.0) / 4.0;
    if (h < 0.0) col = uHaze;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Flat quads collected into one mesh. */
class Quads {
  private position: number[] = [];
  private normal: number[] = [];
  private colour: number[] = [];
  private c = new Color();

  /** Four corners counter-clockwise seen from the side its normal points to. */
  add(a: number[], b: number[], c: number[], d: number[], n: number[], colour: string): void {
    this.c.set(colour);
    for (const v of [a, b, c, a, c, d]) {
      this.position.push(v[0], v[1], v[2]);
      this.normal.push(n[0], n[1], n[2]);
      this.colour.push(this.c.r, this.c.g, this.c.b);
    }
  }

  /** A horizontal rectangle facing up. */
  top(x0: number, z0: number, x1: number, z1: number, y: number, colour: string): void {
    this.add([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], colour);
  }

  /** A wall from (x0,z0) to (x1,z1), between two heights, facing `n`. */
  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, n: number[], colour: string): void {
    this.add([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0], n, colour);
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.position, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.normal, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.colour, 3));
    return g;
  }
}

export function buildSkyWorld(world: World, homeId: string): SkyWorld {
  const group = new Group();
  const owned: Array<{ dispose: () => void }> = [];
  const keep = <X extends { dispose: () => void }>(x: X): X => { owned.push(x); return x; };
  const { lit, glow } = materials();
  const models = skyModels();

  const homeIsle = world.islands.find((i) => i.vpsId === homeId) ?? world.islands[0];
  // Board pixels → world: the home island's centre is the origin.
  const ox = homeIsle ? (homeIsle.tx + homeIsle.tw / 2) * T : 0;
  const oz = homeIsle ? (homeIsle.ty + homeIsle.th / 2) * T : 0;
  const wx = (px: number) => (px - ox) * SCALE;
  const wz = (py: number) => (py - oz) * SCALE;

  /* ── the land ── */

  const land = new Set<number>();
  const key = (tx: number, ty: number) => (tx + 4096) * 16384 + (ty + 4096);
  const quads = new Quads();
  const glowing = new Quads();
  const towers: Tower[] = [];
  const isles: SkyWorld['isles'] = [];
  const spots: Record<'lighthouse' | 'lantern' | 'bush' | 'console', Matrix4[]> = { lighthouse: [], lantern: [], bush: [], console: [] };
  const halos: Array<{ x: number; y: number; z: number; size: number; colour: string }> = [];
  const beams: Array<{ x: number; y: number; z: number; seed: number; length: number }> = [];
  const pose = new Object3D();
  const spot = (kind: keyof typeof spots, x: number, y: number, z: number, scale: number, turn = 0) => {
    pose.position.set(x, y, z);
    pose.rotation.set(0, turn, 0);
    pose.scale.setScalar(scale);
    pose.updateMatrix();
    spots[kind].push(pose.matrix.clone());
  };
  let reach = 0;

  const isLand = (isle: Island, i: number, j: number) => i >= 0 && j >= 0 && i < isle.tw && j < isle.th && isle.ground[j * isle.tw + i] === 1;
  const GRASS = [LAND.grass, LAND.grass, LAND.grassDark, LAND.grassLight, LAND.grass];
  const DECK = [LAND.deck, LAND.deckLight, LAND.deck, LAND.deckDark];

  for (const isle of world.islands) {
    const rand = seeded(isle.seed ^ 0x5bd1);
    const x0 = wx(isle.tx * T);
    const z0 = wz(isle.ty * T);
    const cx = x0 + (isle.tw * TILE) / 2;
    const cz = z0 + (isle.th * TILE) / 2;
    isles.push({ x: cx, z: cz, hw: (isle.tw * TILE) / 2, hd: (isle.th * TILE) / 2 });
    reach = Math.max(reach, Math.hypot(Math.abs(cx) + (isle.tw * TILE) / 2, Math.abs(cz) + (isle.th * TILE) / 2));
    const onDeck = (px: number, py: number) => isle.plots.some((p) => px >= p.x - 4 && px <= p.x + p.w + 4 && py >= p.y - 4 && py <= p.y + p.h + 4);

    for (let j = -1; j <= isle.th; j += 1) {
      for (let i = -1; i <= isle.tw; i += 1) {
        const ax = x0 + i * TILE;
        const az = z0 + j * TILE;
        if (isLand(isle, i, j)) {
          land.add(key(isle.tx + i, isle.ty + j));
          // The grass, mottled in half-tiles.
          for (let q = 0; q < 4; q += 1) {
            const hx = ax + (q % 2) * (TILE / 2);
            const hz = az + (q >> 1) * (TILE / 2);
            quads.top(hx, hz, hx + TILE / 2, hz + TILE / 2, LAND_Y, GRASS[Math.floor(rand() * GRASS.length)]);
          }
          // Cliffs where the sea begins: a rim of grass, then rock down under the water.
          const sides: Array<[number, number, number, number, number, number, number[]]> = [
            [i, j - 1, ax + TILE, az, ax, az, [0, 0, -1]],
            [i, j + 1, ax, az + TILE, ax + TILE, az + TILE, [0, 0, 1]],
            [i - 1, j, ax, az, ax, az + TILE, [-1, 0, 0]],
            [i + 1, j, ax + TILE, az + TILE, ax + TILE, az, [1, 0, 0]],
          ];
          for (const [ni, nj, sx, sz, ex, ez, n] of sides) {
            if (isLand(isle, ni, nj)) continue;
            quads.wall(sx, sz, ex, ez, LAND_Y - 0.9, LAND_Y, n, LAND.rim);
            quads.wall(sx, sz, ex, ez, 1.3, LAND_Y - 0.9, n, rand() < 0.3 ? LAND.cliffLine : LAND.cliff);
            quads.wall(sx, sz, ex, ez, -3, 1.3, n, LAND.cliffDark);
          }
          // Here and there, a bush.
          if (!isle.small && rand() < 0.07 && !onDeck((isle.tx + i + 0.5) * T, (isle.ty + j + 0.5) * T)) {
            spot('bush', ax + TILE / 2, LAND_Y, az + TILE / 2, 0.45 + rand() * 0.2, rand() * 6.28);
          }
        } else {
          // Shallows around the coast, and foam at the foot of the cliffs.
          let coast = false;
          for (let dj = -1; dj <= 1 && !coast; dj += 1) for (let di = -1; di <= 1; di += 1) if (isLand(isle, i + di, j + dj)) { coast = true; break; }
          if (!coast) continue;
          quads.top(ax, az, ax + TILE, az + TILE, 0.12, WATER.shallow);
          if (isLand(isle, i, j - 1) && rand() < 0.7) glowing.top(ax + 1.2, az, ax + TILE - 1.2, az + 0.6, 0.2, WATER.foam);
          if (isLand(isle, i, j + 1) && rand() < 0.7) glowing.top(ax + 1.2, az + TILE - 0.6, ax + TILE - 1.2, az + TILE, 0.2, WATER.foam);
          if (isLand(isle, i - 1, j) && rand() < 0.7) glowing.top(ax, az + 1.2, ax + 0.6, az + TILE - 1.2, 0.2, WATER.foam);
          if (isLand(isle, i + 1, j) && rand() < 0.7) glowing.top(ax + TILE - 0.6, az + 1.2, ax + TILE, az + TILE - 1.2, 0.2, WATER.foam);
        }
      }
    }

    // The decks: planks, a lantern at two corners, a console per station.
    for (const plot of isle.plots) {
      const px0 = wx(plot.x);
      const pz0 = wz(plot.y);
      const px1 = wx(plot.x + plot.w);
      const pz1 = wz(plot.y + plot.h);
      const plank = 8 * SCALE;
      let n = 0;
      for (let z = pz0; z < pz1 - 0.01; z += plank, n += 1) {
        quads.top(px0, z, px1, Math.min(pz1, z + plank), DECK_Y, DECK[(n + Math.floor(rand() * 2)) % DECK.length]);
      }
      quads.wall(px1, pz0, px0, pz0, LAND_Y, DECK_Y, [0, 0, -1], LAND.deckEdge);
      quads.wall(px0, pz1, px1, pz1, LAND_Y, DECK_Y, [0, 0, 1], LAND.deckEdge);
      quads.wall(px0, pz0, px0, pz1, LAND_Y, DECK_Y, [-1, 0, 0], LAND.deckEdge);
      quads.wall(px1, pz1, px1, pz0, LAND_Y, DECK_Y, [1, 0, 0], LAND.deckEdge);
      for (const lx of [px0 + 1.6, px1 - 1.6]) {
        spot('lantern', lx, DECK_Y, pz0 + 1.6, 0.42);
        halos.push({ x: lx, y: DECK_Y + 4.6, z: pz0 + 1.6, size: 22, colour: '#ffc763' });
      }
      for (const station of plot.stations) spot('console', wx(station.deskX), DECK_Y, wz(station.deskY - 6), 0.47);
    }

    // The beacon.
    const size = isle.small ? 0.22 : 0.36;
    const bx = wx(isle.beaconX);
    const bz = wz(isle.beaconY - 6);
    spot('lighthouse', bx, LAND_Y, bz, size);
    towers.push({ x: bx, z: bz, r: 10 * size, top: LAND_Y + 66 * size });
    halos.push({ x: bx, y: LAND_Y + 55 * size, z: bz, size: 150 * size, colour: '#fff3c9' });
    beams.push({ x: bx, y: LAND_Y + 55 * size, z: bz, seed: (isle.seed % 628) / 100, length: isle.small ? 170 : 300 });
  }

  group.add(new Mesh(keep(quads.geometry()), lit));
  group.add(new Mesh(keep(glowing.geometry()), glow));

  // One instanced mesh per model part, for everything that stands in numbers.
  const stand = (model: Model, at: Matrix4[]) => {
    if (!at.length) return;
    for (const [geometry, material] of [[model.lit, lit], [model.glow, glow]] as const) {
      if (!geometry) continue;
      const mesh = new InstancedMesh(geometry, material, at.length);
      at.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  };
  stand(models.lighthouse, spots.lighthouse);
  stand(models.lantern, spots.lantern);
  stand(models.bush, spots.bush);
  stand(models.console, spots.console);

  /* ── the lights ── */

  const soft = keep(glowTexture());
  const haloMaterials = new Map<string, SpriteMaterial>();
  for (const h of halos) {
    let material = haloMaterials.get(h.colour);
    if (!material) {
      material = keep(new SpriteMaterial({ map: soft, color: h.colour, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.75 }));
      haloMaterials.set(h.colour, material);
    }
    const sprite = new Sprite(material);
    sprite.position.set(h.x, h.y, h.z);
    sprite.scale.setScalar(h.size);
    group.add(sprite);
  }

  // The beacons sweep: two flat blades of light each, turning.
  const blade = keep(new BufferGeometry());
  blade.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, -0.05, 1, 0, 0.05, 0, 0, 0, -1, 0, 0.05, -1, 0, -0.05], 3));
  const beamMaterial = keep(new MeshBasicMaterial({
    color: '#fff3c9', transparent: true, opacity: 0.1, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false,
  }));
  const sweeps = beams.map((b) => {
    const mesh = new Mesh(blade, beamMaterial);
    mesh.position.set(b.x, b.y, b.z);
    mesh.scale.set(b.length, 1, b.length);
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, seed: b.seed };
  });

  /* ── the sea, the sky ── */

  const seaMaterial = keep(new ShaderMaterial({
    // Pushed back a little: what lies just over the water (shallows, foam) wins, even far away.
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    vertexShader: SEA_VERTEX,
    fragmentShader: SEA_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      // The board's water, a shade lighter: from the air the sea must read under a night sky.
      uDeep: { value: new Color('#0a1830') },
      uMid: { value: new Color('#102646') },
      uRipple: { value: new Color('#1d4168') },
      uGlint: { value: new Color('#9fc4e8') },
      uHaze: { value: new Color(HAZE) },
      uDensity: { value: FOG_DENSITY },
      uMoon: { value: [MOON.x / Math.hypot(MOON.x, MOON.z), MOON.z / Math.hypot(MOON.x, MOON.z)] },
    },
  }));
  const sea = new Mesh(keep(new PlaneGeometry(1, 1)), seaMaterial);
  sea.rotation.x = -Math.PI / 2;
  sea.scale.setScalar(24000);
  sea.frustumCulled = false;
  group.add(sea);

  const heavens = new Group();
  const dome = new Mesh(keep(new SphereGeometry(5200, 20, 14)), keep(new ShaderMaterial({
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    uniforms: {
      uHaze: { value: new Color(HAZE) },
      uLow: { value: new Color('#102140') },
      uHigh: { value: new Color('#050a17') },
      uMoonDir: { value: MOON.clone() },
    },
    side: BackSide, depthWrite: false, depthTest: false,
  })));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  heavens.add(dome);

  const starRand = seeded(0x51a2);
  const stars: number[] = [];
  for (let i = 0; i < 520; i += 1) {
    const a = starRand() * Math.PI * 2;
    const h = 0.06 + starRand() * 0.94;
    const r = Math.sqrt(1 - h * h);
    stars.push(Math.cos(a) * r * 5000, h * 5000, Math.sin(a) * r * 5000);
  }
  const starGeometry = keep(new BufferGeometry());
  starGeometry.setAttribute('position', new Float32BufferAttribute(stars, 3));
  const starPoints = new Points(starGeometry, keep(new PointsMaterial({
    // Tested against depth: a star is behind everything, never over the plane.
    color: '#cfe0fb', size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false, transparent: true, opacity: 0.85,
  })));
  starPoints.renderOrder = -9;
  starPoints.frustumCulled = false;
  heavens.add(starPoints);

  const moonHalo = new Sprite(keep(new SpriteMaterial({
    map: soft, color: '#9fc4e8', blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.22, fog: false,
  })));
  moonHalo.position.copy(MOON).multiplyScalar(4600);
  moonHalo.scale.setScalar(1100);
  moonHalo.renderOrder = -8;
  heavens.add(moonHalo);
  const moon = new Sprite(keep(new SpriteMaterial({ map: keep(moonTexture()), depthWrite: false, fog: false })));
  moon.position.copy(MOON).multiplyScalar(4500);
  moon.scale.setScalar(430);
  moon.renderOrder = -7;
  heavens.add(moon);
  group.add(heavens);

  /* ── the clouds ── */

  /* ── the mainland ── */

  // North of every island, clear of them all: straight ahead of the pilot who has just landed.
  let north = 0;
  for (const isle of isles) north = Math.min(north, isle.z - isle.hd);
  const mainland = buildMainland(hashStr(homeId) ^ 0x3a1d, 0, north - 380 - MAINLAND_RZ);
  group.add(mainland.group);
  keep(mainland);

  const radius = Math.max(1700, reach + 750, Math.abs(mainland.z) + MAINLAND_RZ + 320);
  const cloudRand = seeded(hashStr(homeId) ^ 0xc10d);
  const puffs: Matrix4[] = [];
  const q = new Quaternion();
  const at = new Vector3();
  const sized = new Vector3();
  for (let i = 0; i < 44; i += 1) {
    const a = cloudRand() * Math.PI * 2;
    const d = Math.sqrt(cloudRand()) * (radius + 1300);
    const cx = Math.cos(a) * d;
    const cz = Math.sin(a) * d;
    const cy = 190 + cloudRand() * 330;
    const big = 0.7 + cloudRand() * 1.1;
    const parts = 4 + Math.floor(cloudRand() * 5);
    for (let p = 0; p < parts; p += 1) {
      at.set(cx + (cloudRand() - 0.5) * 190 * big, cy + (cloudRand() - 0.5) * 22 * big, cz + (cloudRand() - 0.5) * 110 * big);
      sized.set((70 + cloudRand() * 90) * big, (16 + cloudRand() * 18) * big, (50 + cloudRand() * 60) * big);
      puffs.push(new Matrix4().compose(at, q, sized));
    }
  }
  const clouds = new InstancedMesh(
    keep(new BoxGeometry(1, 1, 1)),
    keep(new MeshLambertMaterial({ color: '#4c6392', transparent: true, opacity: 0.8, depthWrite: false })),
    puffs.length,
  );
  puffs.forEach((m, i) => clouds.setMatrixAt(i, m));
  clouds.instanceMatrix.needsUpdate = true;
  clouds.frustumCulled = false;
  clouds.renderOrder = 2;
  group.add(clouds);

  const groundAt = (x: number, z: number): number => {
    const tx = Math.floor((x / SCALE + ox) / T);
    const tz = Math.floor((z / SCALE + oz) / T);
    return land.has(key(tx, tz)) ? LAND_Y : Math.max(0, mainland.heightAt(x, z));
  };

  const homeW = homeIsle ? (homeIsle.tw * TILE) / 2 : 40;
  const homeD = homeIsle ? (homeIsle.th * TILE) / 2 : 30;

  return {
    group, groundAt, towers, isles, radius, mainland,
    toWorld: (px, py, out) => out.set(wx(px), LAND_Y, wz(py)),
    boardX: (x) => x / SCALE + ox,
    boardY: (z) => z / SCALE + oz,
    home: { x: 0, z: 0, hw: homeW, hd: homeD },
    update(time, eye) {
      seaMaterial.uniforms.uTime.value = time;
      sea.position.set(eye.x, 0, eye.z);
      heavens.position.copy(eye);
      for (const s of sweeps) s.mesh.rotation.y = time * 0.45 + s.seed;
    },
    dispose() {
      for (const o of owned) o.dispose();
      group.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh && (mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
      });
    },
  };
}
