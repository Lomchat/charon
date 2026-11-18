// The 3D stage of the mini-game: one renderer, one scene, one camera, the
// archipelago, and what is drawn over it. Every third-person way of playing —
// on foot, in the seaplane, at the helm — plays on this ONE stage, in this one
// world: going from one to the next is a camera that moves, never a cut.
//
// Drawn at a low resolution and scaled up in whole pixels, like the board.
import {
  BoxGeometry, Color, DirectionalLight, FogExp2, HemisphereLight, InstancedMesh, Matrix4, MeshLambertMaterial, PerspectiveCamera, Scene,
  Vector3, WebGLRenderer, type CanvasTexture,
} from 'three';
import type { World } from '../layout';
import { Fx } from './fx';
import { Hud } from './hud';
import { buildSkyWorld, FOG_DENSITY, glowTexture, HAZE, MOON, type SkyWorld } from './world';

/** Where the eye is, what it looks at, and how. */
export type Rig = { eye: Vector3; look: Vector3; up: Vector3; roll: number; fov: number };

export function makeRig(): Rig {
  return { eye: new Vector3(), look: new Vector3(), up: new Vector3(0, 1, 0), roll: 0, fov: 64 };
}

export function copyRig(from: Rig, to: Rig): Rig {
  to.eye.copy(from.eye); to.look.copy(from.look); to.up.copy(from.up); to.roll = from.roll; to.fov = from.fov;
  return to;
}

/**
 * `to`, part of the way from `from` (k: 0..1). The eye swings round what it
 * looks at, and what it frames there changes size at a steady rate: a long
 * lens far above becomes a wide one close behind without the picture ever
 * pulling back first.
 */
export function blendRig(from: Rig, to: Rig, k: number, out: Rig): Rig {
  const fromArm = b1.subVectors(from.eye, from.look);
  const toArm = b2.subVectors(to.eye, to.look);
  const fromFar = Math.max(1e-3, fromArm.length());
  const toFar = Math.max(1e-3, toArm.length());
  const half = (fov: number): number => Math.tan((fov * Math.PI) / 360);
  out.fov = from.fov + (to.fov - from.fov) * k;
  const framed = Math.exp(Math.log(fromFar * half(from.fov)) * (1 - k) + Math.log(toFar * half(to.fov)) * k);
  fromArm.divideScalar(fromFar).lerp(toArm.divideScalar(toFar), k);
  out.look.lerpVectors(from.look, to.look, k);
  // Two opposite arms have no way round: straight through, then.
  if (fromArm.lengthSq() < 1e-4) out.eye.lerpVectors(from.eye, to.eye, k);
  else out.eye.copy(out.look).addScaledVector(fromArm.normalize(), framed / half(out.fov));
  out.up.lerpVectors(from.up, to.up, k).normalize();
  out.roll = from.roll + (to.roll - from.roll) * k;
  return out;
}

export type StagePoint = { x: number; y: number; shown: boolean; depth: number };

type Float = { at: Vector3; text: string; colour: string; t: number };

const v1 = new Vector3();
const v2 = new Vector3();
const b1 = new Vector3();
const b2 = new Vector3();

export class Stage {
  readonly root: HTMLDivElement;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(64, 16 / 9, 0.5, 7000);
  readonly world: SkyWorld;
  readonly fx: Fx;
  readonly hud = new Hud();
  readonly glow: CanvasTexture;
  size = { w: 1, h: 1 };
  /** 0..1: how hard the eye shakes; it settles by itself. */
  trauma = 0;
  time = 0;
  private floats: Float[] = [];
  private warm: InstancedMesh;
  private fill: DirectionalLight;
  private observer: ResizeObserver;
  private onResize: Array<(w: number, h: number) => void> = [];

  constructor(mount: HTMLElement, layout: World, homeId: string) {
    this.root = document.createElement('div');
    this.root.className = 'dk-sky';
    // Throws where there is no WebGL: the run then stays as it was.
    this.renderer = new WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.domElement.className = 'dk-sky-gl';
    this.root.append(this.renderer.domElement, this.hud.canvas);
    mount.append(this.root);

    this.scene.fog = new FogExp2(HAZE, FOG_DENSITY);
    this.scene.background = new Color(HAZE);
    // Night, but a readable one: the moon, and the sky's own light.
    const moon = new DirectionalLight('#dbe7ff', 2.6);
    moon.position.copy(MOON);
    // And a little light from the eye: what the player faces is never a silhouette.
    this.fill = new DirectionalLight('#cfd8ee', 1.1);
    this.scene.add(new HemisphereLight('#a9c0ea', '#22344e', 2.4), moon, this.fill, this.fill.target);

    this.world = buildSkyWorld(layout, homeId);
    this.scene.add(this.world.group);
    this.glow = glowTexture();
    this.fx = new Fx(this.glow);
    this.scene.add(this.fx.group);

    // What a turn of the machine is drawn with (morph.ts: plates, each its own colour): one speck of it, out of
    // sight under the sea, so that its shader is built with the first frame and not at the first turn.
    this.warm = new InstancedMesh(new BoxGeometry(0.01, 0.01, 0.01), new MeshLambertMaterial(), 1);
    this.warm.setMatrixAt(0, new Matrix4().makeTranslation(0, -60, 0));
    this.warm.setColorAt(0, new Color('#000000'));
    this.warm.frustumCulled = false;
    this.scene.add(this.warm);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.root);
    this.resize();
    // Faded in by the stylesheet, over the board.
    requestAnimationFrame(() => this.root.classList.add('is-on'));
  }

  dispose(): void {
    this.warm.geometry.dispose();
    (this.warm.material as MeshLambertMaterial).dispose();
    this.warm.dispose();
    this.observer.disconnect();
    this.world.dispose();
    this.fx.dispose();
    this.glow.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.root.remove();
  }

  /** Told of the stage's size now, and whenever it changes. */
  sized(listener: (w: number, h: number) => void): void {
    this.onResize.push(listener);
    listener(this.size.w, this.size.h);
  }

  private resize(): void {
    const w = Math.max(1, this.root.clientWidth);
    const h = Math.max(1, this.root.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    this.size = { w, h };
    // One stage pixel = a whole number of screen pixels, about 340 rows of them.
    const k = Math.max(1, Math.round((h * dpr) / 340));
    this.renderer.setSize(Math.ceil((w * dpr) / k), Math.ceil((h * dpr) / k), false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hud.resize(w, h, dpr);
    for (const listener of this.onResize) listener(w, h);
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Words rising from a point of the world. */
  float(at: Vector3, text: string, colour: string): void {
    this.floats.push({ at: at.clone(), text, colour, t: 0 });
  }

  update(dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.floats = this.floats.filter((f) => { f.t += dt; return f.t < 1.1; });
    this.fx.update(dt);
  }

  /** Put the eye where a rig says; never under the ground, shaken by what just happened. */
  apply(rig: Rig): void {
    const cam = this.camera;
    v1.copy(rig.eye);
    v1.y = Math.max(v1.y, this.world.groundAt(v1.x, v1.z) + 0.9);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * 2.4;
      v1.x += (Math.random() - 0.5) * s; v1.y += (Math.random() - 0.5) * s; v1.z += (Math.random() - 0.5) * s;
    }
    cam.position.copy(v1);
    cam.up.copy(rig.up);
    cam.lookAt(rig.look);
    if (rig.roll) cam.rotateZ(-rig.roll);
    // Close things need a near plane close to the eye; far ones, precision: it follows the height.
    const near = Math.max(0.4, Math.min(2, (v1.y - this.world.groundAt(v1.x, v1.z)) * 0.08));
    if (Math.abs(cam.fov - rig.fov) > 0.05 || Math.abs(cam.near - near) > 0.05) {
      cam.fov = rig.fov;
      cam.near = near;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    this.fill.position.copy(cam.position);
    this.fill.target.position.copy(rig.look);
    this.world.update(this.time, cam.position);
  }

  /** A point of the world on the stage, in CSS pixels; `shown` = in front of the eye and inside the frame. */
  onStage(at: Vector3, out: StagePoint): StagePoint {
    v1.copy(at).applyMatrix4(this.camera.matrixWorldInverse);
    const { w, h } = this.size;
    out.depth = -v1.z;
    if (v1.z < -0.5) {
      v2.copy(at).project(this.camera);
      out.x = (v2.x * 0.5 + 0.5) * w;
      out.y = (0.5 - v2.y * 0.5) * h;
      out.shown = Math.abs(v2.x) < 0.96 && v2.y > -0.86 && v2.y < 0.78;
    } else {
      // Behind the eye: only its side matters.
      const l = Math.hypot(v1.x, v1.y) || 1;
      out.x = w / 2 + (v1.x / l) * w;
      out.y = h / 2 - (v1.y / l) * h;
      out.shown = false;
    }
    return out;
  }

  /** What a world length measures on the stage, at a distance of 1. */
  focal(): number {
    return this.size.h / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /** The direction under a point of the stage (CSS pixels), from the eye. */
  ray(x: number, y: number, out: Vector3): Vector3 {
    return out.set((x / this.size.w) * 2 - 1, 1 - (y / this.size.h) * 2, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
  }

  /** The words in the air, placed for the instruments. */
  floatsOnStage(): Array<{ x: number; y: number; text: string; colour: string; k: number }> {
    const p: StagePoint = { x: 0, y: 0, shown: false, depth: 0 };
    return this.floats.map((f) => {
      this.onStage(f.at, p);
      return { x: p.x, y: p.y, text: f.text, colour: f.colour, k: p.depth > 0.5 ? f.t / 1.1 : 1 };
    });
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
