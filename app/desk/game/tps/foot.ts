// The fight on foot, seen from behind the pilot: the board's own game
// (ground.ts), every piece of it given a body on the 3D stage, and a camera
// that the mouse turns. It decides nothing — it shows, and it says which way
// the pilot faces.
import { Color, Group, Mesh, MeshBasicMaterial, BoxGeometry, SphereGeometry, Vector3 } from 'three';
import type { RobotKind } from '../art';
import type { Streak } from './fx';
import type { GroundFoe, GroundPickup, GroundPod, GroundPort } from './ground';
import type { HudFrame, Mark } from './hud';
import type { Input } from './input';
import { skyModels } from './models';
import type { Rig, Stage, StagePoint } from './stage';
import { instance, type Model } from './voxels';
import { LAND_Y, SCALE } from './world';

type FoeView = { group: Group; frames: Group[] | null; look: ReturnType<GroundPort['look']> };
type PickupView = { group: Group; chute: Group };

/** How high a shot flies over the ground, in board pixels (the 2D game draws it at the chest). */
const CHEST = 8;
const GROUND = LAND_Y + 0.25;
/** Board pixels: a robot nearer than this crowds the pilot. */
const CROWD = 46;

const v1 = new Vector3();
const v2 = new Vector3();
const look = { x: 0, y: 0 };

export class Foot {
  /** Which way the pilot faces: its forward on the board is (sin yaw, cos yaw). */
  yaw: number;
  private pitch = 0.42;
  private pilot = new Group();
  private pilotFrames: Record<'stand' | 'walkA' | 'walkB', Group>;
  private gun: Mesh;
  private shield: Mesh;
  private foes = new Map<GroundFoe, FoeView>();
  private pods = new Map<GroundPod, Group>();
  private pickups = new Map<GroundPickup, PickupView>();
  private heli: Group | null = null;
  private streaks: Streak[] = [];
  private pool: Streak[] = [];
  private colours = new Map<string, Color>();
  private owned: Array<{ dispose: () => void }> = [];
  private centre = new Vector3();
  private hp = -1;
  private hurt = 0;
  /** 0..1: how crowded the pilot is (the eye rises with it). */
  private press = 0;
  private time = 0;
  /** What the instruments last pointed at: for a test to play by. */
  marks: Mark[] = [];
  /** Where the pilot stands, in the world. */
  readonly at = new Vector3();

  constructor(private stage: Stage, private port: GroundPort, private input: Input, yaw: number) {
    this.yaw = yaw;
    const models = skyModels();
    const frame = (model: Model): Group => { const g = instance(model); this.pilot.add(g); return g; };
    this.pilotFrames = { stand: frame(models.hero.stand), walkA: frame(models.hero.walkA), walkB: frame(models.hero.walkB) };
    const gunGeometry = new BoxGeometry(2, 2, 7);
    const gunMaterial = new MeshBasicMaterial({ color: '#e8eef9' });
    this.gun = new Mesh(gunGeometry, gunMaterial);
    this.gun.position.set(-4, 6.5, 4.5);
    const shieldGeometry = new SphereGeometry(10, 10, 8);
    const shieldMaterial = new MeshBasicMaterial({ color: '#35d0c7', transparent: true, opacity: 0.2, depthWrite: false });
    this.shield = new Mesh(shieldGeometry, shieldMaterial);
    this.shield.position.y = 8;
    this.pilot.add(this.gun, this.shield);
    this.pilot.scale.setScalar(SCALE);
    this.owned.push(gunGeometry, gunMaterial, shieldGeometry, shieldMaterial);
    stage.scene.add(this.pilot);
    this.step(0);
    this.centre.copy(this.at);
  }

  dispose(): void {
    const scene = this.stage.scene;
    scene.remove(this.pilot);
    for (const v of this.foes.values()) scene.remove(v.group);
    for (const g of this.pods.values()) scene.remove(g);
    for (const v of this.pickups.values()) scene.remove(v.group);
    if (this.heli) scene.remove(this.heli);
    this.stage.fx.streaks([]);
    for (const o of this.owned) o.dispose();
  }

  /** The pilot's body, to take with it into a vehicle. */
  get body(): Group {
    return this.pilot;
  }

  /** A board point, on the ground of the world. */
  private ground(x: number, y: number, out: Vector3): Vector3 {
    this.stage.world.toWorld(x, y, out);
    out.y = GROUND;
    return out;
  }

  /** A board point of the air (a shot, a spark): the 2D game draws it `CHEST` pixels up the screen. */
  private air(x: number, y: number, out: Vector3): Vector3 {
    this.stage.world.toWorld(x, y + CHEST, out);
    out.y = GROUND + CHEST * SCALE;
    return out;
  }

  /* ───────────────────────────────── what the ground fight throws ─── */

  burst(x: number, y: number, colour: string, count: number, speed: number): void {
    this.stage.fx.burst(this.air(x, y, v1), colour, count, speed * SCALE * 1.4, { size: 0.55, life: 0.5, gravity: 26 });
  }

  /** A blast of `radius` board pixels. `loud`: a real explosion. */
  blast(x: number, y: number, radius: number, colour: string, loud: boolean): void {
    this.air(x, y, v1);
    this.stage.fx.flash(v1, colour, radius * SCALE * 2.6, 0.3);
    if (loud) this.stage.fx.explosion(v1, Math.max(0.5, (radius * SCALE) / 9));
  }

  float(x: number, y: number, text: string, colour: string): void {
    this.stage.float(this.air(x, y, v1), text, colour);
  }

  /* ───────────────────────────────────────────────────────── step ─── */

  step(dt: number): void {
    const stage = this.stage;
    const input = this.input;
    this.time += dt;
    this.hurt = Math.max(0, this.hurt - dt * 1.4);

    // The view: the mouse turns it (captured), or leans it to the side it is on; the arrows too.
    input.takeLook(look);
    if (input.locked) {
      this.yaw -= look.x * 0.0028;
      this.pitch += look.y * 0.0022;
    } else {
      input.offset(look);
      if (Math.abs(look.x) > 0.12) this.yaw -= Math.sign(look.x) * Math.min(1, (Math.abs(look.x) - 0.12) / 0.5) * 2.6 * dt;
      this.pitch += (0.42 + look.y * 0.3 - this.pitch) * (1 - Math.exp(-3 * dt));
    }
    this.yaw -= input.arrowX * 2.4 * dt;
    this.pitch = Math.max(0.04, Math.min(0.95, this.pitch));

    const s = this.port.scene();
    const models = skyModels();

    // The pilot.
    const p = s.pilot;
    this.ground(p.x, p.y, this.at);
    this.pilot.position.copy(this.at);
    this.pilot.rotation.y = Math.atan2(p.aimX, p.aimY);
    this.pilot.visible = p.shown && !(p.blink && Math.floor(this.time * 14) % 2 === 1);
    const walking = p.stride > 0;
    const stepping = Math.floor(p.stride * 9) % 2 === 1;
    this.pilotFrames.stand.visible = !walking;
    this.pilotFrames.walkA.visible = walking && stepping;
    this.pilotFrames.walkB.visible = walking && !stepping;
    (this.gun.material as MeshBasicMaterial).color.set(p.flash ? '#fff3c9' : p.gun);
    this.shield.visible = p.shield > 0;
    if (this.hp >= 0 && p.hp < this.hp) { this.hurt = 1; stage.shake(0.5); }
    this.hp = p.hp;

    // The robots: each faces the pilot, and walks.
    const seen = new Set<object>();
    let crowd = 0;
    for (const foe of s.foes) {
      seen.add(foe);
      if (foe.sleep <= 0) crowd += Math.max(0, 1 - Math.hypot(foe.x - p.x, foe.y - p.y) / CROWD);
      let view = this.foes.get(foe);
      if (!view) {
        const kind = this.port.look(foe.type);
        const group = new Group();
        let frames: Group[] | null = null;
        if (kind.art === 'drone') {
          const body = instance(models.drone);
          body.scale.setScalar(0.62 / SCALE);
          group.add(body);
        } else {
          const set = models.walker[kind.red ? 'red' : kind.art as RobotKind];
          frames = [instance(set.walkA), instance(set.walkB)];
          group.add(...frames);
        }
        group.scale.setScalar(SCALE * kind.scale);
        stage.scene.add(group);
        view = { group, frames, look: kind };
        this.foes.set(foe, view);
      }
      const big = view.look.scale > 1;
      // On the board a robot at the pilot's throat is drawn over it; here it would stand IN it: it is shown at arm's length.
      const dx = foe.x - p.x;
      const dy = foe.y - p.y;
      const d = Math.hypot(dx, dy);
      const reach = view.look.fly ? 0 : 7 + 5 * view.look.scale;
      if (d >= reach) this.ground(foe.x, foe.y, view.group.position);
      else {
        const a = d > 0.5 ? Math.atan2(dy, dx) : foe.seed;
        this.ground(p.x + Math.cos(a) * reach, p.y + Math.sin(a) * reach, view.group.position);
      }
      if (view.look.fly) view.group.position.y += (11 + Math.sin(s.clock * 9 + foe.seed) * 1.5) * SCALE;
      // A dasher winding up shakes where it stands.
      if (foe.type === 'dasher' && foe.state === 1) view.group.position.x += Math.sin(this.time * 70) * 0.25;
      if (d > 0.5) view.group.rotation.y = Math.atan2(-dx, -dy);
      view.group.scale.setScalar(SCALE * view.look.scale * (foe.flash > 0 ? 1.12 : 1));
      if (view.frames) {
        const second = Math.floor((s.clock + foe.seed) * (big ? 4 : 8)) % 2 === 1;
        view.frames[0].visible = !second;
        view.frames[1].visible = second;
      }
    }
    for (const [foe, view] of this.foes) if (!seen.has(foe)) { stage.scene.remove(view.group); this.foes.delete(foe); }
    this.press += (Math.min(1, crowd * 0.8) - this.press) * (1 - Math.exp(-2.4 * dt));

    // The pods on their way down.
    for (const pod of s.pods) {
      seen.add(pod);
      let group = this.pods.get(pod);
      if (!group) {
        group = instance(models.pod);
        group.scale.setScalar(SCALE * (pod.type === 'boss' ? 2.6 : 1));
        stage.scene.add(group);
        this.pods.set(pod, group);
      }
      this.ground(pod.x, pod.y, group.position);
      const k = Math.min(1, pod.t / pod.max);
      group.position.y += (1 - k) * (1 - k) * 150 * SCALE;
      if (Math.random() < 0.6) stage.fx.puff(v1.copy(group.position).setY(group.position.y + 6 * SCALE), '#ffb86b', 0.7, 0.3, 0, 4, 0, false);
    }
    for (const [pod, group] of this.pods) if (!seen.has(pod)) { stage.scene.remove(group); this.pods.delete(pod); }

    // What lies there to be picked up, or comes down under a parachute.
    for (const pick of s.pickups) {
      seen.add(pick);
      let view = this.pickups.get(pick);
      if (!view) {
        const group = new Group();
        group.add(instance(models.pickup[pick.kind]));
        const chute = instance(models.chute);
        chute.position.y = 13;
        group.add(chute);
        group.scale.setScalar(SCALE * 0.62);
        stage.scene.add(group);
        view = { group, chute };
        this.pickups.set(pick, view);
      }
      this.ground(pick.x, pick.y, view.group.position);
      const falling = pick.fall > 0;
      view.chute.visible = falling;
      if (falling) view.group.position.y += pick.fall * 90 * SCALE;
      else {
        view.group.position.y += (1.2 + Math.abs(Math.sin(s.clock * 3 + pick.x)) * 1.6) * SCALE;
        view.group.rotation.y = s.clock * 1.4 + pick.x;
      }
      // About to go: it flickers.
      view.group.visible = falling || pick.age < 11 || Math.floor(s.clock * 8) % 2 === 0;
    }
    for (const [pick, view] of this.pickups) if (!seen.has(pick)) { stage.scene.remove(view.group); this.pickups.delete(pick); }

    // The helicopter of the drops: the 2D game draws it up the screen from the ground it flies over.
    if (s.heli) {
      if (!this.heli) {
        this.heli = instance(models.heli);
        this.heli.scale.setScalar(SCALE * 1.5);
        this.heli.rotation.y = Math.PI / 2;
        stage.scene.add(this.heli);
      }
      this.ground(s.heli.x, s.heli.y + 150, this.heli.position);
      this.heli.position.y += 70 * SCALE + Math.sin(s.clock * 5) * 0.3;
    } else if (this.heli) { stage.scene.remove(this.heli); this.heli = null; }

    // The shots, as streaks.
    const streaks = this.streaks;
    this.pool.push(...streaks);
    streaks.length = 0;
    for (const shot of s.shots) {
      const streak = this.pool.pop() ?? { pos: new Vector3(), dir: new Vector3(), length: 1, width: 1, colour: new Color() };
      this.air(shot.x, shot.y, streak.pos);
      streak.dir.set(shot.vx, 0, shot.vy).normalize();
      let colour = this.colours.get(shot.colour);
      if (!colour) { colour = new Color(shot.colour); this.colours.set(shot.colour, colour); }
      streak.colour = colour;
      if (shot.kind === 'laser') { streak.length = 9; streak.width = 0.5; }
      else if (shot.kind === 'rocket') {
        streak.length = 2.6; streak.width = 1.3;
        if (Math.random() < 0.7) stage.fx.puff(streak.pos, '#9aa1b1', 0.8, 0.4);
      } else if (shot.kind === 'flame') { streak.length = 1.6; streak.width = 1.6; }
      else if (shot.kind === 'foe') { streak.length = 1.3; streak.width = 1.3; }
      else { streak.length = 2.4; streak.width = 0.42; }
      streaks.push(streak);
    }
    stage.fx.streaks(streaks);
  }

  /* ─────────────────────────────────────────────── the eye, the sight ─── */

  /** Behind the pilot and over its shoulder. */
  rig(dt: number, out: Rig): void {
    // The eye follows the pilot a hair late: it glides, the pilot does not drag it.
    this.centre.lerp(this.at, dt > 0 ? 1 - Math.exp(-14 * dt) : 1);
    // Robots right on the pilot would stand between it and the eye: the eye goes up and looks down on them.
    const pitch = this.pitch + 0.34 * this.press;
    const cp = Math.cos(pitch);
    v1.set(Math.sin(this.yaw) * cp, -Math.sin(pitch), Math.cos(this.yaw) * cp);
    v2.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    out.eye.copy(this.centre).addScaledVector(v1, -22 - 7 * this.press).addScaledVector(v2, 3);
    out.eye.y += 8.5 + 2 * this.press;
    out.look.copy(this.centre).addScaledVector(v1, 34).addScaledVector(v2, 3);
    out.look.y += 6.2;
    out.up.set(0, 1, 0);
    out.roll = 0;
    out.fov = 62;
  }

  /** What the instruments show this frame. `rides`: the vehicles waiting, to go to. */
  frame(rides: Array<{ kind: 'plane' | 'boat'; at: Vector3 }>): HudFrame {
    const stage = this.stage;
    const s = this.port.scene();
    const focal = stage.focal();
    const p: StagePoint = { x: 0, y: 0, shown: false, depth: 0 };
    const marks: Mark[] = [];
    const blips: HudFrame['radar']['blips'] = [];
    for (const foe of s.foes) {
      if (foe.sleep > 0) continue;
      const view = this.foes.get(foe);
      if (!view) continue;
      v1.copy(view.group.position);
      v1.y += 9 * SCALE * view.look.scale;
      stage.onStage(v1, p);
      const big = view.look.scale > 1;
      marks.push({
        x: p.x, y: p.y, shown: p.shown, r: (9 * SCALE * view.look.scale * focal) / Math.max(1, p.depth), dist: v1.distanceTo(this.at),
        kind: big ? 'big' : 'foe', hp: big ? foe.hp / foe.maxHp : null,
      });
      blips.push({ x: v1.x - this.at.x, z: v1.z - this.at.z, kind: big ? 'big' : 'foe' });
    }
    for (const ride of rides) {
      stage.onStage(v1.copy(ride.at).setY(ride.at.y + 4), p);
      marks.push({ x: p.x, y: p.y, shown: p.shown, r: 0, dist: ride.at.distanceTo(this.at), kind: ride.kind, hp: null });
      blips.push({ x: ride.at.x - this.at.x, z: ride.at.z - this.at.z, kind: 'ride' });
    }
    this.marks = marks;
    // Where the gun points, a good way off.
    this.air(s.pilot.x + s.pilot.aimX * 110, s.pilot.y + s.pilot.aimY * 110, v1);
    stage.onStage(v1, p);
    const sight = s.pilot.shown && p.depth > 1 ? { x: p.x, y: p.y } : null;
    const input = this.input;
    const key = (code: string) => input.label(code);
    const hints: HudFrame['hints'] = this.time < 9 ? [
      { keys: [key('KeyW'), key('KeyA'), key('KeyS'), key('KeyD')], word: 'MOVE' },
      { keys: [], mouse: 'move', word: 'LOOK' },
      { keys: [], mouse: 'left', word: 'FIRE' },
      { keys: ['SPACE'], word: 'AUTO' },
      { keys: ['SHIFT'], word: 'DASH' },
      { keys: [key('KeyE')], word: 'BOMB' },
    ] : null;
    return {
      time: this.time, live: s.pilot.shown, brackets: false, sight, hot: false, ring: null, marks, lock: null, threat: null, warn: null,
      dials: null, hurt: this.hurt, hurtFrom: null,
      radar: {
        yaw: this.yaw, range: 190, blips,
        isles: stage.world.isles.map((i) => ({ x: i.x - this.at.x, z: i.z - this.at.z, hw: i.hw, hd: i.hd })),
        homeX: -this.at.x, homeZ: -this.at.z,
      },
      floats: stage.floatsOnStage(), hints, rollKeys: [key('KeyQ'), key('KeyE')],
    };
  }
}
