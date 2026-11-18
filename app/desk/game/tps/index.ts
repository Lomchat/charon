// The 3D phase of the mini-game. After the first wave the board's fight is
// seen from behind the pilot — the SAME fight, still run by game/arcade.ts
// (ground.ts) — then, a wave later, two vehicles come to the island: a
// seaplane and a gunboat. Walk to one and the pilot boards it: the fight goes
// on in the air or on the water (combat.ts), on the same stage, in the same
// world, the eye gliding from one place to the next. No cut anywhere.
//
//   stage.ts   renderer, world, camera     foot.ts    the ground fight, in 3D
//   combat.ts  the fight around a vehicle   plane.ts / boat.ts  the vehicles
//   foes.ts    the robots a vehicle fights  input.ts  keys and mouse
//   world.ts   sea, sky, islands            models.ts everything, as boxes
//   hud.ts     the instruments              fx.ts     bursts, bullets, flashes
//
// Still a TOY: nothing here reads or writes a session. This module is loaded
// on demand (it brings three.js with it).
import { AdditiveBlending, BoxGeometry, ConeGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, Vector3 } from 'three';
import type { Form } from '../forms';
import type { World } from '../layout';
import { Boat } from './boat';
import { Combat } from './combat';
import type { Craft } from './craft';
import type { FoeKind } from './foes';
import { Foot } from './foot';
import type { GroundPort } from './ground';
import type { Mark } from './hud';
import { Input } from './input';
import { Machine } from './machine';
import { Plane } from './plane';
import type { TpsRun } from './run';
import { blendRig, copyRig, makeRig, Stage } from './stage';
import { LAND_Y, SCALE } from './world';

export type { GroundFoe, GroundPickup, GroundPod, GroundPort, GroundScene, GroundShot } from './ground';
export type { TpsRun } from './run';

export type TpsOpen = {
  /**
   * The 2D view to start from: its centre (board pixels), its zoom (CSS pixels
   * per board pixel). The eye begins right over it, looking straight down, and
   * swings to behind the pilot. Null: it starts there.
   */
  from: { x: number; y: number; zoom: number } | null;
  /** Which way the pilot faces to begin with (its forward on the board is (sin, cos)). */
  yaw: number;
};

export type TpsState = {
  /** On foot, or in a vehicle (and which). */
  /** On foot (null), or the machine's shape. */
  craft: Form | null;
  hull: number;
  missiles: number;
  foes: number;
  boss: number | null;
  pace: number;
  boosting: boolean;
  down: boolean;
  /** Which way the ears face on foot (the pilot's heading). */
  yaw: number;
};

/** What the ground robots become when the pilot leaves the island: they come after it. */
const FOLLOW: Record<'plane' | 'boat', Record<string, FoeKind>> = {
  plane: { grunt: 'drone', drone: 'drone', bomber: 'drone', gunner: 'gunner', dasher: 'ace', tank: 'bomber', boss: 'boss' },
  boat: { grunt: 'skimmer', drone: 'drone', bomber: 'mine', gunner: 'gunner', dasher: 'skimmer', tank: 'warship', boss: 'boss' },
};

const ease = (k: number): number => k * k * (3 - 2 * k);
const v1 = new Vector3();

export class Tps {
  private stage: Stage;
  private input = new Input();
  private foot: Foot | null;
  private combat: Combat | null = null;
  private rides: Craft[] = [];
  private rings: Mesh[] = [];
  /** Over each ring, an arrow that bounces: where to go. */
  private arrows: Group[] = [];
  private ringMaterial: MeshBasicMaterial | null = null;
  private owned: Array<{ dispose: () => void }> = [];
  /** Climbing aboard: how far along, from where, into what. */
  private hop: { t: number; from: Vector3; craft: Craft; wave: { share: number; boss: boolean } | null; adopt: Array<{ kind: FoeKind; at: Vector3 }> } | null = null;
  private rig = makeRig();
  private rigFrom = makeRig();
  private rigTo = makeRig();
  private blend = 1;
  private blendIn = 1;
  private time = 0;
  /** 0..1: how far the view has come closer (the right button). */
  private zoom = 0;

  constructor(mount: HTMLElement, layout: World, homeId: string, private run: TpsRun, private port: GroundPort, open: TpsOpen) {
    this.stage = new Stage(mount, layout, homeId);
    this.stage.sized((w, h) => this.input.resize(w, h));
    this.foot = new Foot(this.stage, port, this.input, open.yaw);
    this.foot.rig(0, this.rigTo);
    if (open.from) {
      // Right over the 2D view, looking straight down, north up: what was on the board is where it was.
      const fov = 14;
      const tall = (this.stage.size.h / open.from.zoom) * SCALE;
      this.stage.world.toWorld(open.from.x, open.from.y, this.rig.look);
      this.rig.eye.copy(this.rig.look);
      this.rig.eye.y += tall / 2 / Math.tan((fov * Math.PI) / 360);
      this.rig.up.set(0, 0, -1);
      this.rig.fov = fov;
      // It holds while the stage fades in over the board (the two pictures are one), then comes down.
      this.swing(2.3, 0.5);
    } else copyRig(this.rigTo, this.rig);
    this.stage.apply(this.rig);
  }

  dispose(): void {
    this.foot?.dispose();
    this.combat?.dispose();
    for (const ride of this.rides) ride.dispose(this.stage);
    for (const ring of this.rings) this.stage.scene.remove(ring);
    for (const arrow of this.arrows) this.stage.scene.remove(arrow);
    for (const o of this.owned) o.dispose();
    this.stage.dispose();
  }

  /** The eye glides from where it is to where it should be, over `seconds`, after holding still for `hold`. */
  private swing(seconds: number, hold = 0): void {
    copyRig(this.rig, this.rigFrom);
    this.blend = -hold / seconds;
    this.blendIn = seconds;
  }

  /* ─────────────────────────────────────────── for the ground fight ─── */

  /** The pilot is on foot (the board's fight is still the game). */
  get afoot(): boolean {
    return this.foot != null && !this.hop;
  }

  /** Which way the pilot faces, on foot. */
  heading(): number {
    return this.foot ? this.foot.yaw : 0;
  }

  /** The left button is held (on foot: fire). */
  get trigger(): boolean {
    return this.input.trigger;
  }

  burst(x: number, y: number, colour: string, count: number, speed: number): void {
    this.foot?.burst(x, y, colour, count, speed);
  }

  blast(x: number, y: number, radius: number, colour: string, loud: boolean): void {
    this.foot?.blast(x, y, radius, colour, loud);
  }

  float(x: number, y: number, text: string, colour: string): void {
    this.foot?.float(x, y, text, colour);
  }

  shake(amount: number): void {
    this.stage.shake(amount);
  }

  /* ─────────────────────────────────────────────────── the vehicles ─── */

  /** The vehicles come to the island: the seaplane to its south shore, the gunboat to its east. `there`: they already wait. */
  deliver(there = false): void {
    if (this.rides.length) return;
    const world = this.stage.world;
    const home = world.home;
    // Out from the middle of the island to its shore, then a berth clear of it.
    const shore = (x: number, z: number, dx: number, dz: number): number => {
      let d = 0;
      while (d < 4000 && world.groundAt(x + dx * d, z + dz * d) > 0) d += 1;
      return d;
    };
    const px = home.x - home.hw * 0.2;
    const south = shore(px, home.z, 0, 1);
    const plane = new Plane(this.stage, new Machine('plane'), { x: px, z: home.z + south + 14, yaw: Math.PI / 2 }, new Vector3(px, LAND_Y, home.z + south - 5));
    const bz = home.z + home.hd * 0.15;
    const east = shore(home.x, bz, 1, 0);
    const boat = new Boat(this.stage, new Machine('boat'), { x: home.x + east + 7.5, z: bz, yaw: 0 }, new Vector3(home.x + east - 5, LAND_Y, bz));
    this.rides = [plane, boat];
    if (there) for (const ride of this.rides) ride.moor();

    // Where to stand to board: a ring on the ground, a column of light over it.
    const ringGeometry = new RingGeometry(2.5, 3.5, 24);
    const columnGeometry = new BoxGeometry(0.5, 46, 0.5);
    this.ringMaterial = new MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.8, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false });
    const columnMaterial = new MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.16, blending: AdditiveBlending, depthWrite: false, fog: false });
    // And an arrow over it, pointing down: four-sided, like everything here.
    const shaftGeometry = new BoxGeometry(1.5, 4.5, 1.5);
    const headGeometry = new ConeGeometry(3.4, 4.6, 4);
    const arrowMaterial = new MeshBasicMaterial({ color: '#ffe066', fog: false });
    const arrowShade = new MeshBasicMaterial({ color: '#c9962f', fog: false });
    this.owned.push(ringGeometry, columnGeometry, this.ringMaterial, columnMaterial, shaftGeometry, headGeometry, arrowMaterial, arrowShade);
    for (const ride of this.rides) {
      const arrow = new Group();
      const shaft = new Mesh(shaftGeometry, arrowShade);
      shaft.position.y = 4.4;
      const head = new Mesh(headGeometry, arrowMaterial);
      head.rotation.x = Math.PI;
      arrow.add(shaft, head);
      arrow.position.copy(ride.gate);
      this.stage.scene.add(arrow);
      this.arrows.push(arrow);
      const ring = new Mesh(ringGeometry, this.ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(ride.gate).setY(LAND_Y + 0.6);
      const column = new Mesh(columnGeometry, columnMaterial);
      column.position.copy(ride.gate).setY(LAND_Y + 23);
      this.stage.scene.add(ring, column);
      this.rings.push(ring, column);
    }
  }

  /** The pilot walked into a vehicle's ring: it climbs aboard, and the fight on foot is over. */
  private board(craft: Craft): void {
    const foot = this.foot;
    if (!foot) return;
    const left = this.port.leave();
    const world = this.stage.world;
    const follow = FOLLOW[craft.kind === 'boat' ? 'boat' : 'plane'];
    const adopt = left.foes.map((f) => {
      const kind = follow[f.type] ?? 'drone';
      const at = world.toWorld(f.x, f.y, new Vector3());
      at.y = LAND_Y + 16;
      return { kind, at };
    });
    this.hop = { t: 0, from: foot.at.clone(), craft, wave: left.fighting ? { share: left.share, boss: left.boss } : null, adopt };
    for (const ring of this.rings) this.stage.scene.remove(ring);
    this.rings = [];
    for (const arrow of this.arrows) this.stage.scene.remove(arrow);
    this.arrows = [];
    foot.body.visible = true;
    this.stage.fx.streaks([]);
    this.swing(1.9);
    this.run.audio.land();
  }

  /* ───────────────────────────────────────────────────────── input ─── */

  /** True: the game used the key. */
  key(e: KeyboardEvent, down: boolean): boolean {
    return this.input.key(e, down);
  }

  pointer(type: 'move' | 'down' | 'up', x: number, y: number, button: number, dx: number, dy: number, locked: boolean): void {
    if (type === 'move') this.input.pointerMove(x, y, dx, dy, locked);
    else if (type === 'down') this.input.pointerDown(button);
    else this.input.pointerUp(button);
  }

  /** The mouse was captured, or let go. */
  setLocked(locked: boolean): void {
    this.input.setLocked(locked);
  }

  release(): void {
    this.input.release();
  }

  /* ───────────────────────────────────────────────────────── step ─── */

  step(dt: number): void {
    const stage = this.stage;
    this.time += dt;
    this.input.update(dt);

    const hop = this.hop;
    if (hop && this.foot) {
      // Up and over, into its seat.
      hop.t += dt / 0.6;
      const k = Math.min(1, hop.t);
      hop.craft.seat(v1);
      this.foot.body.position.lerpVectors(hop.from, v1, ease(k));
      this.foot.body.position.y += Math.sin(Math.PI * k) * 4;
      this.foot.body.scale.setScalar(SCALE * (1 - 0.5 * k));
      if (k >= 1) {
        this.foot.dispose();
        this.foot = null;
        this.hop = null;
        hop.craft.cast();
        // The machine is the fight's from here on (it will turn into other shapes): no longer one of the moored ones.
        this.rides = this.rides.filter((r) => r !== hop.craft);
        this.combat = new Combat(stage, this.run, hop.craft, this.input, hop.wave, hop.adopt, (seconds) => this.swing(seconds));
      }
    } else if (this.foot) {
      this.foot.step(dt);
      // Into a ring: aboard.
      for (const ride of this.rides) {
        if (!ride.moored) continue;
        const dx = this.foot.at.x - ride.gate.x;
        const dz = this.foot.at.z - ride.gate.z;
        if (dx * dx + dz * dz < 4.4 * 4.4) { this.board(ride); break; }
      }
    }
    // What is not being driven waits (or is still coming in).
    for (const ride of this.rides) ride.idle(dt, stage);
    this.combat?.step(dt);
    if (this.ringMaterial) this.ringMaterial.opacity = 0.55 + 0.3 * Math.sin(this.time * 5);
    for (let i = 0; i < this.rings.length; i += 2) this.rings[i].scale.setScalar(1 + 0.12 * Math.sin(this.time * 5));
    for (const arrow of this.arrows) {
      arrow.position.y = LAND_Y + 12 + Math.abs(Math.sin(this.time * 5)) * 3.2;
      arrow.rotation.y = this.time * 2.2;
    }

    stage.update(dt);

    // The eye: behind whoever is being played, gliding there when that just changed.
    if (this.combat) this.combat.rig(dt, this.rigTo);
    else if (hop) hop.craft.rig(dt, stage, this.rigTo);
    else this.foot?.rig(dt, this.rigTo);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.blendIn);
      blendRig(this.rigFrom, this.rigTo, ease(Math.max(0, this.blend)), this.rig);
    } else copyRig(this.rigTo, this.rig);
    // The right button: the view comes closer, whatever is being played.
    this.zoom += ((this.input.zoom ? 1 : 0) - this.zoom) * (1 - Math.exp(-12 * dt));
    this.rig.fov *= 1 - 0.34 * this.zoom;
    stage.apply(this.rig);
  }

  draw(): void {
    const stage = this.stage;
    stage.render();
    if (this.combat) { stage.hud.draw(this.combat.frame()); return; }
    if (!this.foot) return;
    // Every vehicle sent is shown the way to, moored or still coming in: its ring is where to wait for it.
    const rides = this.hop ? [] : this.rides.map((r) => ({ kind: r.kind, at: r.gate }));
    stage.hud.draw(this.foot.frame(rides));
  }

  state(): TpsState {
    const c = this.combat?.state();
    return {
      craft: this.combat ? this.combat.craft.kind : null, hull: c ? c.hull : 1, missiles: c ? c.missiles : 0, foes: c ? c.foes : 0,
      boss: c ? c.boss : null, pace: c ? c.pace : 0, boosting: c ? c.boosting : false, down: c ? c.down : false,
      yaw: this.foot ? this.foot.yaw : 0,
    };
  }

  /** What a test needs to play: where things are on the stage, and how it fares. */
  probe(): { mode: 'foot' | 'boarding' | Form; live: boolean; hull: number; missiles: number; marks: Mark[]; alt: number; rides: number; size: { w: number; h: number } } {
    const c = this.combat;
    const state = c?.state();
    return {
      mode: c ? c.craft.kind : this.hop ? 'boarding' : 'foot', live: c ? c.craft.live : this.foot != null,
      hull: state ? Math.round(state.hull * 100) : 100, missiles: state ? state.missiles : 0,
      marks: c ? c.marks : this.foot ? this.foot.marks : [], alt: c ? c.craft.pos.y : 0,
      rides: this.rides.filter((r) => r.moored).length, size: this.stage.size,
    };
  }
}
