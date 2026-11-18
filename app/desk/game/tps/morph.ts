// The machine turns from one shape into another: its own parts fold into
// the state common to all three, then unfold into the next shape
// (machine.ts § blend) — wings sweep back and stand up as a hull's sides,
// floats let their soles down as tracks, guns run in and out — while the
// machine goes on its way (a plane that touched the sea runs on as a boat, a
// boat asked to fly climbs away).
//
// It only says where the machine is (`state`) and moves its root between
// where the old shape had it and where the next one wants it; combat.ts owns
// the shapes themselves.
import { Quaternion, Vector3 } from 'three';
import type { Form } from '../forms';
import type { CraftState } from './craft';
import { TUNE } from './flight';
import type { Machine } from './machine';
import type { Stage } from './stage';

/** Seconds a turn takes. */
export const MORPH_TIME = 1.5;

const ease = (k: number): number => k * k * (3 - 2 * k);
const p1 = new Vector3();

export class Morph {
  /** Where the turning machine is and how it goes, this frame: the next shape is held there. */
  readonly state: CraftState;
  private t = 0;
  private y0: number;
  private q0: Quaternion;

  constructor(private machine: Machine, readonly from: Form, readonly to: Form, state: CraftState) {
    this.state = { ...state, pos: state.pos.clone() };
    this.y0 = machine.root.position.y;
    this.q0 = machine.root.quaternion.clone();
    machine.begin();
  }

  get progress(): number {
    return Math.min(1, this.t / MORPH_TIME);
  }

  /** The machine goes on its way while it turns. True: the turn is over. */
  step(dt: number, stage: Stage): boolean {
    this.t += dt;
    const s = this.state;
    const k = 1 - Math.exp(-2.2 * dt);
    // Toward the pace of what it becomes: a plane needs its speed, a hull runs its way off.
    const pace = this.to === 'plane' ? TUNE.cruise * 0.96 : this.to === 'boat' ? Math.max(12, Math.min(58, s.speed)) : Math.max(14, Math.min(40, s.speed));
    s.speed += (pace - s.speed) * k;
    s.pos.x += Math.sin(s.yaw) * s.speed * dt;
    s.pos.z += Math.cos(s.yaw) * s.speed * dt;
    // What flies leaves the surface behind — once its wings are out.
    if (this.to === 'plane' && this.progress > 0.45) s.pos.y += (stage.world.groundAt(s.pos.x, s.pos.z) + 34 - s.pos.y) * k * 0.8;
    // A spark where something seats, now and then.
    if (Math.random() < 0.35) {
      const root = this.machine.root;
      p1.set((Math.random() - 0.5) * 8, 1 + Math.random() * 3, (Math.random() - 0.5) * 12).applyQuaternion(root.quaternion).add(root.position);
      stage.fx.burst(p1, Math.random() < 0.5 ? '#ffb86b' : '#fff3c9', 1, 22, { size: 0.5, life: 0.3, gravity: 40, drag: 2 });
    }
    return this.t >= MORPH_TIME;
  }

  /** Move the machine: its root from where the old shape had it to where the next one wants it, its parts on their way. */
  place(pos: Vector3, quat: Quaternion): void {
    const k = this.progress;
    const root = this.machine.root;
    root.position.set(pos.x, this.y0 + (pos.y - this.y0) * ease(k), pos.z);
    root.quaternion.slerpQuaternions(this.q0, quat, ease(Math.min(1, k * 1.4)));
    this.machine.blend(this.from, this.to, k);
  }
}
