// What bursts, burns and streaks in the flight phase: cubes for sparks, smoke
// and fire (voxels, like everything else up there), stretched boxes for
// bullets, and soft flashes of light. Three instanced meshes, a fixed budget.
import {
  AdditiveBlending, BoxGeometry, Color, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Sprite, SpriteMaterial,
  Vector3, type Texture,
} from 'three';

type Cube = {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; max: number; size: number; gravity: number; drag: number; r: number; g: number; b: number;
  /** It grows to `size` first (smoke), instead of starting at it. */
  swell: boolean;
};

type Flash = { sprite: Sprite; life: number; max: number; size: number };

/** A bullet, a tracer, an orb: anything drawn as a box along its way. */
export type Streak = { pos: Vector3; dir: Vector3; length: number; width: number; colour: Color };

const MAX_CUBES = 900;
const MAX_STREAKS = 360;
const FORWARD = new Vector3(0, 0, 1);

export type CubeOpts = { size?: number; life?: number; gravity?: number; drag?: number; spread?: number; swell?: boolean; lift?: number };

export class Fx {
  readonly group = new Group();
  private cubes: Cube[] = [];
  private cubeMesh: InstancedMesh;
  private streakMesh: InstancedMesh;
  private flashes: Flash[] = [];
  private pool: Sprite[] = [];
  private colour = new Color();
  private m = new Matrix4();
  private q = new Quaternion();
  private s = new Vector3();
  private owned: Array<{ dispose: () => void }> = [];

  constructor(private glow: Texture) {
    const box = new BoxGeometry(1, 1, 1);
    const cubeMaterial = new MeshBasicMaterial();
    const streakMaterial = new MeshBasicMaterial({ fog: false });
    this.owned.push(box, cubeMaterial, streakMaterial);
    this.cubeMesh = new InstancedMesh(box, cubeMaterial, MAX_CUBES);
    this.streakMesh = new InstancedMesh(box, streakMaterial, MAX_STREAKS);
    for (const mesh of [this.cubeMesh, this.streakMesh]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      // Allocate the colours now: every instance is written each frame.
      mesh.setColorAt(0, this.colour.set('#ffffff'));
      this.group.add(mesh);
    }
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.cubeMesh.dispose();
    this.streakMesh.dispose();
    for (const s of [...this.pool, ...this.flashes.map((f) => f.sprite)]) s.material.dispose();
  }

  /** Cubes thrown from a point, every way. */
  burst(at: Vector3, colour: string, count: number, speed: number, o: CubeOpts = {}): void {
    this.colour.set(colour);
    const { r, g, b } = this.colour;
    for (let i = 0; i < count && this.cubes.length < MAX_CUBES; i += 1) {
      // A direction on the sphere.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const k = Math.sqrt(1 - u * u);
      const v = speed * (0.3 + Math.random() * 0.7);
      const spread = o.spread ?? 0;
      this.cubes.push({
        x: at.x + (Math.random() - 0.5) * spread, y: at.y + (Math.random() - 0.5) * spread, z: at.z + (Math.random() - 0.5) * spread,
        vx: Math.cos(a) * k * v, vy: u * v + (o.lift ?? 0), vz: Math.sin(a) * k * v,
        life: 0, max: (o.life ?? 0.6) * (0.6 + Math.random() * 0.8), size: (o.size ?? 1.2) * (0.6 + Math.random() * 0.8),
        gravity: o.gravity ?? 60, drag: o.drag ?? 1.2, r, g, b, swell: o.swell ?? false,
      });
    }
  }

  /** One cube left behind: a trail of smoke, a puff of exhaust. */
  puff(at: Vector3, colour: string, size: number, life: number, vx = 0, vy = 0, vz = 0, swell = true): void {
    if (this.cubes.length >= MAX_CUBES) return;
    this.colour.set(colour);
    this.cubes.push({
      x: at.x, y: at.y, z: at.z, vx, vy, vz, life: 0, max: life, size, gravity: 0, drag: 1.5,
      r: this.colour.r, g: this.colour.g, b: this.colour.b, swell,
    });
  }

  /** A light that swells and dies. */
  flash(at: Vector3, colour: string, size: number, life: number): void {
    if (this.flashes.length >= 28) return;
    const sprite = this.pool.pop() ?? new Sprite(new SpriteMaterial({
      map: this.glow, blending: AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    }));
    sprite.material.color.set(colour);
    sprite.material.opacity = 1;
    sprite.position.copy(at);
    sprite.scale.setScalar(size * 0.4);
    this.group.add(sprite);
    this.flashes.push({ sprite, life: 0, max: life, size });
  }

  /** Something blows up: fire, embers, smoke, a flash. `scale` 1 = a drone. */
  explosion(at: Vector3, scale: number): void {
    this.flash(at, '#ffd98a', 60 * scale, 0.32);
    this.burst(at, '#fff3c9', Math.round(6 * scale + 4), 46 * scale, { size: 2.2 * scale, life: 0.35, gravity: 0, drag: 3 });
    this.burst(at, '#ffb86b', Math.round(10 * scale + 6), 70 * scale, { size: 1.8 * scale, life: 0.6, gravity: 30, drag: 2 });
    this.burst(at, '#ff5d5d', Math.round(6 * scale + 3), 95 * scale, { size: 1.1 * scale, life: 0.8, gravity: 90, drag: 1 });
    this.burst(at, '#343c50', Math.round(7 * scale + 3), 30 * scale, { size: 3.4 * scale, life: 1.4, gravity: -8, drag: 2.2, swell: true, spread: 4 * scale });
    this.burst(at, '#9aa1b1', Math.round(5 * scale + 3), 110 * scale, { size: 0.9 * scale, life: 1.1, gravity: 120, drag: 0.6 });
  }

  /** Something meets the sea. */
  splash(at: Vector3, scale = 1): void {
    this.burst(at, '#cfe0fb', Math.round(16 * scale), 46 * scale, { size: 1.6 * scale, life: 0.8, gravity: 130, drag: 0.8, lift: 44 * scale, spread: 3 });
    this.burst(at, '#3a7ba3', Math.round(10 * scale), 26 * scale, { size: 2.2 * scale, life: 0.9, gravity: 90, drag: 1.2, lift: 22 * scale, spread: 5 });
  }

  update(dt: number): void {
    const keep: Cube[] = [];
    const array = this.cubeMesh.instanceMatrix.array as Float32Array;
    const colours = this.cubeMesh.instanceColor!.array as Float32Array;
    let n = 0;
    for (const c of this.cubes) {
      c.life += dt;
      if (c.life >= c.max) continue;
      const slow = Math.exp(-c.drag * dt);
      c.vx *= slow; c.vy = c.vy * slow - c.gravity * dt; c.vz *= slow;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      // The sea swallows what falls into it.
      if (c.y < 0 && c.gravity > 0) continue;
      keep.push(c);
      const k = c.life / c.max;
      const size = c.size * (c.swell ? Math.min(1, k * 4) * (1 - k * k) : 1 - k * k);
      const o = n * 16;
      array[o] = size; array[o + 1] = 0; array[o + 2] = 0; array[o + 3] = 0;
      array[o + 4] = 0; array[o + 5] = size; array[o + 6] = 0; array[o + 7] = 0;
      array[o + 8] = 0; array[o + 9] = 0; array[o + 10] = size; array[o + 11] = 0;
      array[o + 12] = c.x; array[o + 13] = c.y; array[o + 14] = c.z; array[o + 15] = 1;
      colours[n * 3] = c.r; colours[n * 3 + 1] = c.g; colours[n * 3 + 2] = c.b;
      n += 1;
    }
    this.cubes = keep;
    this.cubeMesh.count = n;
    this.cubeMesh.instanceMatrix.needsUpdate = true;
    this.cubeMesh.instanceColor!.needsUpdate = true;

    this.flashes = this.flashes.filter((f) => {
      f.life += dt;
      const k = f.life / f.max;
      if (k >= 1) {
        this.group.remove(f.sprite);
        this.pool.push(f.sprite);
        return false;
      }
      f.sprite.scale.setScalar(f.size * (0.4 + 0.6 * Math.sqrt(k)));
      f.sprite.material.opacity = 1 - k * k;
      return true;
    });
  }

  /** Draw this frame's bullets. */
  streaks(list: Streak[]): void {
    const n = Math.min(list.length, MAX_STREAKS);
    for (let i = 0; i < n; i += 1) {
      const s = list[i];
      this.q.setFromUnitVectors(FORWARD, s.dir);
      this.m.compose(s.pos, this.q, this.s.set(s.width, s.width, s.length));
      this.streakMesh.setMatrixAt(i, this.m);
      this.streakMesh.setColorAt(i, s.colour);
    }
    this.streakMesh.count = n;
    this.streakMesh.instanceMatrix.needsUpdate = true;
    if (this.streakMesh.instanceColor) this.streakMesh.instanceColor.needsUpdate = true;
  }
}
