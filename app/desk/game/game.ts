// The board: one low-resolution canvas scaled up in whole DEVICE pixels, and a
// layer of crisp DOM text on top. No React in here — Desk.tsx hands it a
// model and a scene, and listens to what gets picked.
//
// A scene is ONE island (the default: what the camera frames, the only thing
// drawn) or the map (every island at once). The canvas is CSS-pixel-size /
// zoom: a 1920×1080 window at zoom 3 is a 640×360 canvas, so the board costs
// the same on any screen. Scrolling stays smooth because the canvas itself is
// shifted by the sub-pixel remainder.
import { fmtSpanShort, sessionCacheReading, type CacheReading } from '@/lib/promptCache';
import { toolFamily, type SessionActivity, type ToolFamily } from '@/lib/sessionActivity';
import {
  BEACON_GLASS, T, WATER, art, drawFlame, drawIcon, drawRobot, makeCanvas, robotKind,
  type IconName, type RobotArt, type RobotPose,
} from './art';
import { Arcade } from './arcade';
import {
  CELL_H, CELL_W, buildWorld, sitePad, type Island, type Slot, type Station, type Team, type World,
} from './layout';
import {
  HEAT, MOOD_COLOR, agentName, ago, blend, hashStr, inTurn, levelOf, moodOf, ownColour,
  type DeskModel, type DeskSession, type Mood,
} from './model';
import { drawFoam, drawWater, glow, paintIsland, type IslandLayer } from './scenery';
import { publishArcade, readBest, writeBest } from '../arcadeStore';

/**
 * What a point of the stage is on. On an island only a robot and a "+" answer
 * (`spawn`: a deck's free console, or with `cwd` null the deck being built);
 * a deck or the ground is nothing to pick there — the map alone travels by
 * them.
 */
export type Pick =
  | { kind: 'agent'; id: string }
  | { kind: 'spawn'; vpsId: string; cwd: string | null }
  | { kind: 'plot'; vpsId: string; cwd: string }
  | { kind: 'vps'; id: string };

/** What the stage shows: one machine's island, or the whole archipelago. */
export type Scene = { kind: 'island'; id: string } | { kind: 'map' };

/** CSS pixels of the stage the HUD covers on each side. */
export type Insets = { left: number; top: number; right: number; bottom: number };

/** The key of the map's miniature (`attachThumb`). */
export const MAP_THUMB = '*';

export type GameHooks = {
  onPick: (pick: Pick | null, how: 'click' | 'double' | 'menu', clientX: number, clientY: number) => void;
  onZoom?: (zoom: number) => void;
  /** The mini-game asks for the sound switch, or has ended. */
};

export const FAMILY_COLOR: Record<ToolFamily | 'think' | 'say', string> = {
  shell: '#9be370',
  edit: '#ffb86b',
  read: '#7cc4ff',
  search: '#c9a7ff',
  web: '#5fe3d4',
  agent: '#ff8fb3',
  plan: '#ffe066',
  peer: '#ff8fb3',
  other: '#cfd6e6',
  think: '#b9c6de',
  say: '#e8eef9',
};

const FAMILY_WORD: Record<ToolFamily, string> = {
  shell: 'run', edit: 'edit', read: 'read', search: 'search', web: 'web',
  agent: 'agent', plan: 'plan', peer: 'message', other: 'tool',
};

type Actor = {
  id: string;
  session: DeskSession;
  station: Station;
  art: RobotArt;
  mood: Mood;
  busy: boolean;
  x: number; y: number;
  seed: number;
  level: number;
  chest: string;
  activity: SessionActivity | null;
  /** Its prompt cache as of the last second (null: none to show). */
  cache: CacheReading | null;
  /** Local clock of the last tool beat (fast typing right after it). */
  beatAt: number;
  popAt: number;
  hopAt: number;
  bornAt: number;
  zAt: number;
};

type Particle = {
  x: number; y: number; vx: number; vy: number; g: number;
  life: number; max: number; colour: string; size: number; kind: 'px' | 'z';
};
type Ring = { x: number; y: number; t: number; max: number; colour: string; r: number };
type Wisp = { ax: number; ay: number; bx: number; by: number; t: number; max: number; colour: string };
type Float = { el: HTMLElement; x: number; y: number; until: number };
/** `scope`: the island a label belongs to; '' = the map only. */
type Placard = { el: HTMLElement; x: number; y: number; minZoom: number; centred: boolean; scope: string };
type Tag = Placard & { name: HTMLElement; cap: HTMLElement; heat: HTMLElement; lv: HTMLElement; text: string; heatText: string };

const WALK = 30;          // pixels per second
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
/** Names stop being readable under this: an island never opens smaller. */
const READABLE_ZOOM = 1.5;
/** Framing a small island does not blow it up past this. */
const MAX_FRAME_ZOOM = 4;

export class Game {
  private host: HTMLElement;
  private hooks: GameHooks;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private labels: HTMLElement;
  private model: DeskModel | null = null;
  private world: World | null = null;
  private layers = new Map<string, IslandLayer>();
  private actors = new Map<string, Actor>();
  private islandMood = new Map<string, Mood>();
  /** Machines whose agent is unreachable: their beacon blinks red. */
  private offline = new Set<string>();
  private tags = new Map<string, Tag>();
  private placards: Placard[] = [];
  private floats: Float[] = [];
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private wisps: Wisp[] = [];

  private scene: Scene | null = null;
  private safe: Insets = { left: 0, top: 0, right: 0, bottom: 0 };
  /** The user moved or zoomed since the scene was framed: stop re-framing it. */
  private userMoved = false;
  private dpr = 1;
  /** The mini-game (game/arcade.ts), while a run lasts: it takes the stage. */
  private arcade: Arcade | null = null;
  private arcadeQuit = false;
  /** The board's zoom for a run (the right button brings it a step closer for as long as it is held). */
  private arcadeZoom = 3;
  /** The newest model that came in during a run (`setModel`). */
  private heldModel: DeskModel | null = null;
  private arcadeHudAt = 0;
  private shakeUntil = 0;
  private shakeBy = 0;
  private thumbs = new Map<string, HTMLCanvasElement>();
  private drafts: ReadonlySet<string> = new Set();
  private thumbAt = 0;

  private cam = { x: 0, y: 0, zoom: 2 };
  private goal: { x: number; y: number } | null = null;
  private goalRate = 9;
  private size = { w: 1, h: 1 };
  /** The first scene has been framed (effects only play after that). */
  private placed = false;
  private labelsDirty = true;
  private selected: Pick | null = null;
  private hovered: Pick | null = null;
  private time = 0;
  private last = 0;
  private raf = 0;
  private keys = new Set<string>();
  private inputEnabled = true;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; moved: boolean; pinch: number } | null = null;
  private lastClick = { at: 0, key: '' };
  private wheel = 0;
  private minimap: HTMLCanvasElement | null = null;
  private minimapAt = 0;
  private captionAt = 0;
  private cacheAt = 0;
  private observer: ResizeObserver;
  private disposers: Array<() => void> = [];

  constructor(host: HTMLElement, hooks: GameHooks) {
    this.host = host;
    this.hooks = hooks;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dk-canvas';
    this.g = this.canvas.getContext('2d', { alpha: false })!;
    this.labels = document.createElement('div');
    this.labels.className = 'dk-labels';
    this.labels.dataset.zoom = '2';
    this.dpr = window.devicePixelRatio || 1;
    host.append(this.canvas, this.labels);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.bindInput();
  }

  /* ─────────────────────────────────────────────────────── life cycle ─── */

  start(): void {
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
      this.last = now;
      this.time += dt * 1000;
      this.step(dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(tick);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    for (const off of this.disposers) off();
    this.canvas.remove();
    this.labels.remove();
  }

  setInputEnabled(on: boolean): void {
    this.inputEnabled = on;
    if (!on) this.keys.clear();
  }

  attachMinimap(canvas: HTMLCanvasElement | null): void {
    this.minimap = canvas;
    this.minimapAt = 0;
  }

  /** The machine a session's robot lives on. */
  islandOf(sessionId: string): string | null {
    return this.world?.stations.get(sessionId)?.plot.vpsId ?? null;
  }

  /** Test and console handle: where a session stands on screen (CSS px). */
  screenOf(id: string): { x: number; y: number } | null {
    const actor = this.actors.get(id);
    if (!actor) return null;
    const view = this.view();
    return { x: (actor.x - view.left) * this.cam.zoom, y: (actor.y - 10 - view.top) * this.cam.zoom };
  }

  /* ──────────────────────────────────────────────────────────── model ─── */

  setModel(model: DeskModel): void {
    // A run of the mini-game plays on the board as it was when it started: what
    // the fleet does meanwhile (a session comes, another goes) waits for its end.
    if (this.arcade) { this.heldModel = model; return; }
    this.model = model;
    const before = this.sceneBox();
    const world = buildWorld(model);
    const reshaped = !this.world || this.world.shape !== world.shape;
    this.world = world;
    if (reshaped) {
      this.rebuildScenery();
      // The scene's island may have moved in the world (its neighbours grew):
      // the camera follows it, so the view does not jump.
      const after = this.sceneBox();
      if (before && after && this.placed) {
        this.cam.x += after.x - before.x;
        this.cam.y += after.y - before.y;
        if (this.goal) { this.goal.x += after.x - before.x; this.goal.y += after.y - before.y; }
      }
    }

    const seen = new Set<string>();
    for (const session of model.sessions) {
      const station = world.stations.get(session.id);
      if (!station) continue;
      seen.add(session.id);
      const mood = moodOf(session);
      // Busy = a turn runs. Background tasks alone are not one (`inTurn`).
      const busy = inTurn(session);
      // The level is the context, by 100k tokens; -1 = no reading yet.
      const level = levelOf(session)?.level ?? -1;
      let actor = this.actors.get(session.id);
      if (!actor) {
        const atDesk = seated(mood, busy);
        actor = {
          id: session.id, session, station, art: art().robots[robotKind(session.kind)], mood, busy,
          x: atDesk ? station.seatX : station.restX, y: atDesk ? station.seatY : station.restY,
          seed: hashStr(session.id), level, chest: chestColour(session), activity: null,
          cache: sessionCacheReading(session, Date.now()),
          beatAt: -9999, popAt: -9999, hopAt: -9999, bornAt: this.placed ? this.time : -9999, zAt: 0,
        };
        this.actors.set(session.id, actor);
        if (this.placed && this.shown(session.vpsId)) {
          this.rings.push({ x: station.seatX, y: station.restY, t: 0, max: 700, colour: '#ffffff', r: 20 });
        }
      } else {
        if (actor.mood !== mood) this.onMood(actor, actor.mood, mood);
        // The turn ended: what it was doing is over. (Not "whenever idle":
        // a beat can land a moment before the summary that says it works.)
        if (actor.busy && !busy && mood !== 'blocked') actor.activity = null;
        if (level > actor.level && actor.level >= 0 && this.placed && this.shown(session.vpsId)) {
          this.float(actor.x, actor.y - 30, `LEVEL ${level}`, '#ffe066', 'big');
          this.rings.push({ x: actor.x, y: actor.y - 2, t: 0, max: 900, colour: '#ffe066', r: 26 });
        }
        actor.session = session;
        actor.station = station;
        actor.mood = mood;
        actor.busy = busy;
        actor.level = level;
        actor.chest = chestColour(session);
        actor.cache = sessionCacheReading(session, Date.now());
        if (reshaped && !this.placed) { actor.x = station.restX; actor.y = station.restY; }
      }
    }
    for (const [id, actor] of this.actors) {
      if (seen.has(id)) continue;
      if (this.shown(actor.session.vpsId)) this.puff(actor.x, actor.y - 8, '#cfd6e6', 10);
      this.actors.delete(id);
    }

    // What each island's beacon says.
    this.islandMood.clear();
    const rank: Mood[] = ['blocked', 'question', 'error', 'done', 'work', 'bg', 'idle', 'sleep'];
    for (const actor of this.actors.values()) {
      const vps = actor.session.vpsId;
      const before = this.islandMood.get(vps);
      if (before == null || rank.indexOf(actor.mood) < rank.indexOf(before)) {
        this.islandMood.set(vps, actor.mood);
      }
    }
    this.offline.clear();
    for (const v of model.vps) {
      if (v.agentStatus === 'error' || v.agentStatus === 'missing') this.offline.add(v.id);
    }

    this.syncTags();
    this.labelsDirty = true;
    this.thumbAt = 0;
    if (!this.placed) this.firstFrame();
    else if (reshaped && !this.userMoved) this.frame(0, true);
  }

  /** The snapshot: what every session is doing, all at once (no effects). */
  setActivities(map: Record<string, SessionActivity>): void {
    for (const actor of this.actors.values()) {
      const next = map[actor.id];
      if (next && (!actor.activity || next.at >= actor.activity.at)) actor.activity = next;
    }
    this.refreshCaptions();
  }

  /** One live beat: the state changes AND the board reacts. */
  beat(id: string, a: SessionActivity, fresh: boolean): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    const { station } = actor;
    // Off stage (another island is shown): the state moves, nothing plays.
    if (!this.shown(actor.session.vpsId)) fresh = false;
    switch (a.beat) {
      case 'tool': {
        actor.activity = a;
        if (!fresh) break;
        actor.beatAt = this.time;
        const family = toolFamily(a.tool);
        const colour = FAMILY_COLOR[family];
        this.burst(station.holoX + 5, station.holoY + 5, colour, 4, 26);
        if (this.time - actor.popAt > 420) {
          actor.popAt = this.time;
          this.float(station.holoX + 5, station.holoY - 2, FAMILY_WORD[family], colour, 'small');
        }
        break;
      }
      case 'think':
      case 'say':
      case 'compact':
        actor.activity = a;
        break;
      case 'prompt':
        if (!fresh) break;
        this.rings.push({ x: station.seatX, y: station.deskY - 2, t: 0, max: 800, colour: '#e8eef9', r: 24 });
        this.float(station.seatX, station.y + 8, '▼ order', '#e8eef9', 'small');
        break;
      case 'bg':
        if (fresh) this.float(station.holoX + 5, station.holoY - 2, '+ task', FAMILY_COLOR.agent, 'small');
        break;
      case 'peer_in':
      case 'peer_reply': {
        if (!fresh) break;
        const from = a.peerSessionId ? this.actors.get(a.peerSessionId) : null;
        if (from) {
          this.wisps.push({
            ax: from.x, ay: from.y - 16, bx: actor.x, by: actor.y - 16, t: 0,
            max: 500 + Math.min(1400, Math.hypot(from.x - actor.x, from.y - actor.y) * 6), colour: FAMILY_COLOR.peer,
          });
        }
        this.float(actor.x, actor.y - 30, a.peerHandle ? `✉ @${a.peerHandle}` : '✉ message', FAMILY_COLOR.peer, 'small');
        break;
      }
      case 'stop':
        actor.activity = null;
        break;
      default:
        break;
    }
    this.refreshCaption(actor);
  }

  private onMood(actor: Actor, from: Mood, to: Mood): void {
    if (!this.placed || !this.shown(actor.session.vpsId)) return;
    const { station } = actor;
    if (to === 'done') {
      actor.hopAt = this.time;
      this.confetti(station.restX, station.restY - 18);
      this.float(station.restX, station.y + 6, '✓ done', MOOD_COLOR.done, 'big');
    } else if (to === 'blocked' || to === 'question') {
      this.rings.push({ x: actor.x, y: actor.y - 2, t: 0, max: 900, colour: MOOD_COLOR.blocked, r: 30 });
      this.float(actor.x, station.y + 6, to === 'blocked' ? '! needs you' : '? asks', MOOD_COLOR.blocked, 'big');
    } else if (to === 'error') {
      this.burst(actor.x, actor.y - 12, MOOD_COLOR.error, 10, 40);
      this.float(actor.x, station.y + 6, '✖ failed', MOOD_COLOR.error, 'big');
    } else if (from === 'sleep') {
      this.rings.push({ x: actor.x, y: actor.y - 2, t: 0, max: 700, colour: '#e8eef9', r: 20 });
    }
  }

  /* ───────────────────────────────────────────────── scenery and text ─── */

  private rebuildScenery(): void {
    const world = this.world!;
    this.layers.clear();
    for (const island of world.islands) this.layers.set(island.vpsId, paintIsland(island));
    for (const p of this.placards) p.el.remove();
    this.placards = [];
    const add = (
      scope: string, cls: string, text: string, x: number, y: number, minZoom: number, centred = false, extra?: string,
    ) => {
      const el = document.createElement('div');
      el.className = `dk-label ${cls}`;
      el.textContent = text;
      if (extra) {
        const b = document.createElement('b');
        b.textContent = extra;
        el.append(b);
      }
      this.labels.append(el);
      this.placards.push({ el, x, y, minZoom, centred, scope });
    };
    for (const zone of world.zones) {
      if (zone.name && world.zones.length > 1) add('', 'dk-zone', zone.name, zone.x, zone.y - 2.6 * T, 1);
    }
    for (const island of world.islands) {
      const x = island.tx * T;
      const y = island.ty * T;
      if (island.small) {
        add(island.vpsId, 'dk-islet', island.name, x + (island.tw * T) / 2, y + island.th * T + 14, READABLE_ZOOM, true);
      } else {
        const count = island.plots.reduce((sum, p) => sum + p.stations.length, 0);
        add(island.vpsId, 'dk-isle', island.name, x + 3.6 * T, y + 0.55 * T, 1, false, `${count}`);
        for (const plot of island.plots) add(island.vpsId, 'dk-plot', plot.label, plot.x + 21, plot.y + 2, READABLE_ZOOM);
      }
    }
  }

  private syncTags(): void {
    for (const [id, tag] of this.tags) {
      if (this.actors.has(id)) continue;
      tag.el.remove();
      this.tags.delete(id);
    }
    for (const actor of this.actors.values()) {
      let tag = this.tags.get(actor.id);
      if (!tag) {
        const el = document.createElement('div');
        el.className = 'dk-label dk-tag';
        const name = document.createElement('span');
        name.className = 'dk-tag-name';
        const lv = document.createElement('i');
        const text = document.createElement('span');
        name.append(lv, text);
        const sub = document.createElement('span');
        sub.className = 'dk-tag-sub';
        const cap = document.createElement('span');
        cap.className = 'dk-tag-cap';
        const heat = document.createElement('span');
        heat.className = 'dk-tag-heat';
        sub.append(cap, heat);
        el.append(name, sub);
        this.labels.append(el);
        tag = {
          el, name: text, cap, heat, lv, x: 0, y: 0, minZoom: READABLE_ZOOM, centred: true, text: '', heatText: '', scope: '',
        };
        this.tags.set(actor.id, tag);
      }
      tag.x = actor.station.labelX;
      tag.y = actor.station.labelY;
      tag.scope = actor.session.vpsId;
      const label = agentName(actor.session);
      if (tag.name.textContent !== label) tag.name.textContent = label;
      const lv = actor.level < 0 ? '–' : String(actor.level);
      if (tag.lv.textContent !== lv) tag.lv.textContent = lv;
      tag.el.dataset.mood = actor.mood;
      tag.el.classList.toggle('has-draft', this.drafts.has(actor.id));
      // A robot that wants you keeps its name at every zoom.
      tag.minZoom = actor.mood === 'blocked' || actor.mood === 'question' || actor.mood === 'done' ? 1 : READABLE_ZOOM;
      this.refreshCaption(actor);
    }
    this.markSelection();
  }

  private refreshCaptions(): void {
    for (const actor of this.actors.values()) this.refreshCaption(actor);
  }

  private refreshCaption(actor: Actor): void {
    const tag = this.tags.get(actor.id);
    if (!tag) return;
    const text = captionOf(actor);
    if (tag.text !== text) {
      tag.text = text;
      tag.cap.textContent = text;
      const a = actor.activity;
      tag.cap.dataset.kind = a && actor.busy ? a.beat : '';
    }
    // The one thing worth a word about a cache: how long it stays warm. Cold
    // is the ice on the brazier (a deck of "cold" labels says nothing), and a
    // running turn keeps it alive: nothing to count.
    const c = actor.cache;
    const heat = c?.phase === 'warm' ? `${c.approx ? '≈' : ''}${fmtSpanShort(c.remainingMs)}` : '';
    if (tag.heatText !== heat) {
      tag.heatText = heat;
      tag.heat.textContent = heat;
    }
    const tint = c?.phase === 'warm' ? HEAT[c.level].core : '';
    if (tag.heat.style.color !== tint) tag.heat.style.color = tint;
  }

  private markSelection(): void {
    for (const [id, tag] of this.tags) {
      tag.el.classList.toggle('is-selected', this.selected?.kind === 'agent' && this.selected.id === id);
      tag.el.classList.toggle('is-hovered', this.hovered?.kind === 'agent' && this.hovered.id === id);
    }
  }

  /** Floating text that rises and fades (CSS runs the animation). */
  private float(x: number, y: number, text: string, colour: string, size: 'small' | 'big'): void {
    if (this.floats.length > 40) return;
    const el = document.createElement('div');
    el.className = `dk-label dk-float dk-float-${size}`;
    const inner = document.createElement('span');
    inner.textContent = text;
    inner.style.color = colour;
    el.append(inner);
    this.labels.append(el);
    this.floats.push({ el, x, y, until: this.time + (size === 'big' ? 1900 : 1100) });
  }

  /* ─────────────────────────────────────────────────────────── camera ─── */

  private view() {
    const { zoom } = this.cam;
    const left = this.cam.x - this.size.w / (2 * zoom);
    const top = this.cam.y - this.size.h / (2 * zoom);
    return { left, top, w: this.size.w / zoom, h: this.size.h / zoom };
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.size = { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
    // Another monitor, or the browser's own zoom: keep the pixels whole.
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.cam.zoom = this.snapZoom(this.cam.zoom, 'near');
      this.afterZoom();
    }
    this.labelsDirty = true;
    if (!this.placed) this.firstFrame();
    else if (!this.userMoved) this.frame();
  }

  /* ──────────────────────────────────────────────────────────── scene ─── */

  private shown(vpsId: string): boolean {
    const scene = this.scene;
    return scene != null && (scene.kind === 'map' || scene.id === vpsId);
  }

  /** What the camera frames: one island, cliff and beacon included, or every inhabited one. */
  private sceneBox(): { x: number; y: number; w: number; h: number } | null {
    const world = this.world;
    const scene = this.scene;
    if (!world || !scene) return null;
    if (scene.kind === 'map') return world.home;
    const island = world.islands.find((i) => i.vpsId === scene.id);
    if (!island) return null;
    return { x: island.tx * T + 8, y: island.ty * T - 6, w: island.tw * T - 16, h: island.th * T + 22 };
  }

  /**
   * Show one island, or the map. `slide` is where the new scene comes from
   * (-1 left, 1 right): the camera starts half a screen away and glides in.
   */
  setScene(scene: Scene, slide: -1 | 0 | 1 = 0): void {
    const now = this.scene;
    const same = now != null && now.kind === scene.kind && (scene.kind === 'map' || (now.kind === 'island' && now.id === scene.id));
    this.scene = scene;
    if (same && this.placed) return;
    if (this.arcade) this.stopArcade();
    // What was playing belongs to the scene that just left.
    this.particles = [];
    this.rings = [];
    this.wisps = [];
    for (const f of this.floats) f.el.remove();
    this.floats = [];
    this.hover(null);
    this.userMoved = false;
    this.labelsDirty = true;
    this.thumbAt = 0;
    this.minimapAt = 0;
    if (!this.placed) { this.firstFrame(); return; }
    this.frame(slide);
    this.labels.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }

  get currentScene(): Scene | null { return this.scene; }

  /** The HUD moved: keep the scene in what is left of the stage. */
  setSafeArea(safe: Insets): void {
    const s = this.safe;
    if (s.left === safe.left && s.top === safe.top && s.right === safe.right && s.bottom === safe.bottom) return;
    this.safe = { ...safe };
    if (this.placed && !this.userMoved) this.frame(0, true);
  }

  private safeRect() {
    const { left, top, right, bottom } = this.safe;
    return { x: left, y: top, w: Math.max(160, this.size.w - left - right), h: Math.max(120, this.size.h - top - bottom) };
  }

  private firstFrame(): void {
    if (!this.world || !this.scene || this.size.w <= 1 || !this.sceneBox()) return;
    this.frame();
    this.placed = true;
  }

  /**
   * Put the scene in the free part of the stage, at the largest crisp zoom
   * that holds it — but an island never opens below a readable zoom: one too
   * big for that shows its top-left corner instead of shrinking into dots.
   */
  private frame(slide: -1 | 0 | 1 = 0, glide = false): void {
    // A run of the mini-game owns the camera (the HUD moving must not zoom out).
    if (this.arcade) return;
    const box = this.sceneBox();
    if (!box) return;
    const safe = this.safeRect();
    const floor = this.scene?.kind === 'map' ? MIN_ZOOM : READABLE_ZOOM;
    let zoom = this.snapZoom(Math.min(MAX_FRAME_ZOOM, safe.w / box.w, safe.h / box.h), 'down');
    if (zoom < floor) zoom = this.snapZoom(floor, 'up');
    // Centre what fits; pin the start of what does not.
    const along = (start: number, length: number, from: number, room: number, half: number) => (length * zoom <= room
      ? start + length / 2 - (from + room / 2 - half) / zoom
      : start - (from + 8 - half) / zoom);
    const x = along(box.x, box.w, safe.x, safe.w, this.size.w / 2);
    const y = along(box.y, box.h, safe.y, safe.h, this.size.h / 2);
    const rezoomed = zoom !== this.cam.zoom;
    this.cam.zoom = zoom;
    if (slide) {
      this.cam.x = x + slide * (this.size.w / zoom) * 0.42;
      this.cam.y = y;
      this.goal = { x, y };
      this.goalRate = 13;
    } else if (glide && !rezoomed) {
      // A slide already under way keeps its pace: only its target is refreshed.
      if (!this.goal) this.goalRate = 9;
      this.goal = { x, y };
    } else {
      this.cam.x = x;
      this.cam.y = y;
      this.goal = null;
    }
    this.userMoved = false;
    this.afterZoom();
  }

  /** The scene as it opens: whole, in the free part of the stage. */
  fit(): void {
    if (this.placed) this.frame(0, true);
  }

  /** Back to the framed view — unless the user moved the camera themselves. */
  rest(): void {
    if (this.placed && !this.userMoved) this.frame(0, true);
  }

  /* ───────────────────────────────────────────────────────────── zoom ─── */

  get zoom(): number { return this.cam.zoom; }

  /** A zoom is crisp when one world pixel is a whole number of DEVICE pixels. */
  private snapZoom(zoom: number, how: 'down' | 'up' | 'near'): number {
    const k = zoom * this.dpr;
    const whole = how === 'down' ? Math.floor(k + 1e-6) : how === 'up' ? Math.ceil(k - 1e-6) : Math.round(k);
    const least = Math.ceil(MIN_ZOOM * this.dpr - 1e-6);
    return Math.max(least, Math.min(Math.floor(MAX_ZOOM * this.dpr), whole)) / this.dpr;
  }

  private afterZoom(): void {
    const { zoom } = this.cam;
    this.labels.dataset.zoom = zoom < READABLE_ZOOM ? '1' : zoom < 2.75 ? '2' : '3';
    this.labelsDirty = true;
    this.hooks.onZoom?.(zoom);
  }

  /** One step in or out (a device pixel, two on very dense screens), around a point of the stage. */
  zoomBy(dir: number, aroundX = this.size.w / 2, aroundY = this.size.h / 2): void {
    if (this.arcade) return;
    const step = Math.max(1, Math.round(this.dpr / 2)) / this.dpr;
    const next = this.snapZoom(this.cam.zoom + (dir > 0 ? step : -step), 'near');
    if (next === this.cam.zoom) return;
    // Keep the world point under the cursor where it is.
    const before = this.view();
    const wx = before.left + aroundX / this.cam.zoom;
    const wy = before.top + aroundY / this.cam.zoom;
    this.cam.zoom = next;
    this.cam.x = wx - aroundX / next + this.size.w / (2 * next);
    this.cam.y = wy - aroundY / next + this.size.h / (2 * next);
    this.goal = null;
    this.userMoved = true;
    this.clampCamera();
    this.afterZoom();
  }

  /**
   * Bring a session's station into the free part of the stage, moving as
   * little as possible (nothing at all when it already is). `cover`: CSS
   * pixels a panel hides at the right (the drawer) or at the foot of the stage.
   */
  reveal(id: string, cover: { right?: number; bottom?: number } = {}): void {
    const station = this.world?.stations.get(id);
    if (!station || this.arcade || !this.shown(station.plot.vpsId)) return;
    const { zoom } = this.cam;
    const cx = this.goal?.x ?? this.cam.x;
    const cy = this.goal?.y ?? this.cam.y;
    const safe = this.safeRect();
    const pad = 12;
    const x0 = (station.x - cx) * zoom + this.size.w / 2;
    const y0 = (station.y - cy) * zoom + this.size.h / 2;
    const x1 = x0 + CELL_W * T * zoom;
    const y1 = y0 + CELL_H * T * zoom;
    const floorY = this.size.h - Math.max(this.safe.bottom, cover.bottom ?? 0) - pad;
    const wallX = this.size.w - Math.max(this.safe.right, cover.right ?? 0) - pad;
    let dx = 0;
    let dy = 0;
    if (x0 < safe.x + pad) dx = x0 - (safe.x + pad);
    else if (x1 > wallX) dx = x1 - wallX;
    if (y0 < safe.y + pad) dy = y0 - (safe.y + pad);
    else if (y1 > floorY) dy = y1 - floorY;
    if (!dx && !dy) return;
    this.goal = { x: cx + dx / zoom, y: cy + dy / zoom };
    this.goalRate = 9;
  }

  select(pick: Pick | null): void {
    this.selected = pick;
    this.markSelection();
    this.labelsDirty = true;
  }

  private clampCamera(): void {
    const box = this.scene?.kind === 'map' ? this.world?.bounds : this.sceneBox();
    if (!box) return;
    const slackX = (this.size.w / this.cam.zoom) * 0.45;
    const slackY = (this.size.h / this.cam.zoom) * 0.45;
    this.cam.x = Math.max(box.x - slackX, Math.min(box.x + box.w + slackX, this.cam.x));
    this.cam.y = Math.max(box.y - slackY, Math.min(box.y + box.h + slackY, this.cam.y));
  }

  /* ───────────────────────────────────────────────────── the mini-game ─── */

  get arcadeOn(): boolean { return this.arcade != null; }

  /**
   * Start a run on the island on stage. The board's own robots, labels and
   * pointer are set aside until it ends; the sessions are never touched.
   * False when there is no island with robots to play on.
   */
  startArcade(from: 'ground' | 'tps' = 'ground'): boolean {
    const world = this.world;
    const scene = this.scene;
    if (this.arcade || !world || scene?.kind !== 'island') return false;
    const island = world.islands.find((i) => i.vpsId === scene.id);
    if (!island || island.small) return false;
    const robots = [...this.actors.values()]
      .filter((a) => a.session.vpsId === island.vpsId)
      .map((a) => ({ kind: robotKind(a.session.kind), x: a.x, y: a.y }));
    this.wipeEffects();
    this.hover(null);
    this.select(null);
    this.keys.clear();
    this.pointers.clear();
    this.drag = null;
    this.goal = null;
    this.cam.zoom = this.snapZoom(Math.min(4, Math.max(3, this.cam.zoom)), 'near');
    this.arcadeZoom = this.cam.zoom;
    this.afterZoom();
    this.labels.classList.add('is-arcade');
    this.host.classList.add('is-arcade');
    this.arcadeQuit = false;
    this.arcade = new Arcade({
      island, robots, best: readBest(), world, stage: this.host, from,
      view: () => ({ x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom }),
      at: (x, y) => ({ x: this.cam.x + (x - this.size.w / 2) / this.cam.zoom, y: this.cam.y + (y - this.size.h / 2) / this.cam.zoom }),
      zoom: (on) => {
        // A whole step closer: the board's pixels stay whole.
        this.cam.zoom = this.snapZoom(this.arcadeZoom * (on ? 1.3 : 1), on ? 'up' : 'near');
        this.afterZoom();
      },
      capture: (on) => this.capture(on),
      float: (x, y, text, colour, size) => this.float(x, y, text, colour, size),
      shake: (ms, px) => { this.shakeUntil = this.time + ms; this.shakeBy = px; },
      saveBest: writeBest,
      quit: () => { this.arcadeQuit = true; },
    });
    const at = this.arcade.focus();
    this.cam.x = at.x;
    this.cam.y = at.y;
    publishArcade(this.arcade.hud());
    return true;
  }

  /** End the run: the board is itself again, framed as before. */
  stopArcade(): void {
    if (!this.arcade) return;
    this.arcade.dispose();
    this.arcade = null;
    this.capture(false);
    this.arcadeQuit = false;
    this.shakeUntil = 0;
    this.wipeEffects();
    this.labels.classList.remove('is-arcade');
    this.host.classList.remove('is-arcade');
    publishArcade(null);
    this.userMoved = false;
    this.labelsDirty = true;
    // The fleet as it is now.
    const held = this.heldModel;
    this.heldModel = null;
    if (held) this.setModel(held);
    this.frame();
  }

  /**
   * Capture the mouse for a run (it turns the view and stays on the stage),
   * or let it go. A browser grants it on a gesture only, and refuses for a
   * moment after an Esc: a refusal is nothing, the run asks again.
   */
  private capture(on: boolean): void {
    try {
      if (on) {
        if (document.pointerLockElement === this.host) return;
        const asked = this.host.requestPointerLock?.() as Promise<void> | undefined;
        asked?.catch?.(() => { /* not this time */ });
      } else if (document.pointerLockElement === this.host) document.exitPointerLock?.();
    } catch { /* no capture here: the mouse points instead */ }
  }

  /** The 3D phase of a run, as a test sees it (null: no run, or still in 2D). */
  arcadeProbe(): ReturnType<Arcade['probe']> {
    return this.arcade ? this.arcade.probe() : null;
  }

  /** How loud the mini-game is right now (null: no run) — for a test. */
  arcadeLevel(): { peak: number; rms: number } | null {
    return this.arcade ? this.arcade.audioLevel() : null;
  }

  private wipeEffects(): void {
    this.particles = [];
    this.rings = [];
    this.wisps = [];
    for (const f of this.floats) f.el.remove();
    this.floats = [];
  }

  private stepArcade(dt: number): void {
    const arcade = this.arcade!;
    if (this.arcadeQuit) { this.stopArcade(); return; }
    arcade.step(dt);
    // On the 3D stage there is nothing of the board to move.
    if (arcade.staged) {
      if (this.floats.length) this.wipeEffects();
      if (this.time - this.arcadeHudAt > 90) { this.arcadeHudAt = this.time; publishArcade(arcade.hud()); }
      return;
    }
    // The camera follows the pilot, without leaving the island behind.
    const world = this.world;
    const island = world?.islands.find((i) => this.shown(i.vpsId));
    const at = arcade.focus();
    let tx = at.x;
    let ty = at.y;
    if (island) {
      const vw = this.size.w / this.cam.zoom;
      const vh = this.size.h / this.cam.zoom;
      const margin = 3 * T;
      const along = (target: number, start: number, length: number, room: number) => (length + margin * 2 <= room
        ? start + length / 2
        : Math.max(start - margin + room / 2, Math.min(start + length + margin - room / 2, target)));
      tx = along(tx, island.tx * T, island.tw * T, vw);
      ty = along(ty, island.ty * T, island.th * T, vh);
    }
    const k = 1 - Math.exp(-dt * 6);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    if (this.floats.length) {
      this.floats = this.floats.filter((f) => {
        if (this.time < f.until) return true;
        f.el.remove();
        return false;
      });
    }
    if (this.time - this.arcadeHudAt > 90) { this.arcadeHudAt = this.time; publishArcade(arcade.hud()); }
  }

  /** The stage during a run: the island as scenery, the game on it. */
  private drawArcade(g: CanvasRenderingContext2D, world: World, inView: (x: number, y: number, w: number, h: number) => boolean): void {
    const arcade = this.arcade!;
    const sprites = art();
    const t = this.time;
    const islands = world.islands.filter((i) => this.shown(i.vpsId));
    for (const island of islands) {
      const layer = this.layers.get(island.vpsId);
      if (!layer || !inView(layer.x, layer.y, layer.canvas.width, layer.canvas.height)) continue;
      g.drawImage(layer.canvas, layer.x, layer.y);
      drawFoam(g, layer.foam, t + island.seed % 1000);
    }
    g.globalCompositeOperation = 'lighter';
    for (const island of islands) {
      for (const light of this.layers.get(island.vpsId)?.lights ?? []) {
        g.globalAlpha = light.alpha * (0.85 + 0.15 * Math.sin(t * 0.004 + light.x));
        g.drawImage(glow(light.colour), light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    arcade.drawUnder(g);
    const items: Array<{ y: number; draw: () => void }> = [];
    for (const island of islands) {
      const sprite = sprites.beacon;
      const bx = Math.round(island.beaconX - sprite.width / 2);
      const by = Math.round(island.beaconY - sprite.height);
      items.push({ y: island.beaconY, draw: () => this.drawBeacon(g, island, bx, by, true) });
    }
    // The consoles stay where they are: something to fight around.
    for (const actor of this.actors.values()) {
      const s = actor.station;
      if (!this.shown(actor.session.vpsId)) continue;
      items.push({ y: s.deskY, draw: () => g.drawImage(sprites.desk, Math.round(s.deskX - sprites.desk.width / 2), Math.round(s.deskY - sprites.desk.height)) });
    }
    arcade.items((y, draw) => items.push({ y, draw }), g);
    items.sort((a, b) => a.y - b.y);
    for (const item of items) item.draw();
    arcade.drawOver(g);
  }

  /** The sessions holding an order typed and not sent: a pencil on their name. */
  setDrafts(ids: ReadonlySet<string>): void {
    this.drafts = ids;
    for (const [id, tag] of this.tags) tag.el.classList.toggle('has-draft', ids.has(id));
  }

  /** A selector card's miniature: the engine keeps it up to date. */
  attachThumb(key: string, canvas: HTMLCanvasElement | null): void {
    if (canvas) this.thumbs.set(key, canvas);
    else this.thumbs.delete(key);
    this.thumbAt = 0;
  }

  /* ──────────────────────────────────────────────────────────── input ─── */

  private bindInput(): void {
    const host = this.host;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    const local = (e: { clientX: number; clientY: number }) => {
      const rect = host.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    on(host, 'pointerdown', (e: PointerEvent) => {
      if (this.arcade) {
        const p = local(e);
        this.arcade.pointer('down', p.x, p.y, e.button, 0, 0, document.pointerLockElement === host);
        return;
      }
      if (e.button === 2) return;
      host.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, local(e));
      const p = local(e);
      this.drag = { x: p.x, y: p.y, moved: false, pinch: this.pinchSpan() };
      this.goal = null;
    });
    // A run on the 3D stage is played with the mouse, wherever it is on the page:
    // captured, it turns the view; free, it points.
    on(window, 'pointermove', (e: PointerEvent) => {
      if (!this.arcade) return;
      const p = local(e);
      this.arcade.pointer('move', p.x, p.y, e.button, e.movementX, e.movementY, document.pointerLockElement === host);
    });
    on(window, 'pointerup', (e: PointerEvent) => {
      if (!this.arcade) return;
      const p = local(e);
      this.arcade.pointer('up', p.x, p.y, e.button, 0, 0, document.pointerLockElement === host);
    });
    const onLock = () => this.arcade?.locked(document.pointerLockElement === host);
    document.addEventListener('pointerlockchange', onLock);
    this.disposers.push(() => document.removeEventListener('pointerlockchange', onLock));
    on(host, 'pointermove', (e: PointerEvent) => {
      if (this.arcade) return;
      const p = local(e);
      if (!this.pointers.has(e.pointerId)) {
        this.hover(this.pickAt(p.x, p.y));
        return;
      }
      const before = this.pointers.get(e.pointerId)!;
      this.pointers.set(e.pointerId, p);
      const drag = this.drag;
      if (!drag) return;
      if (this.pointers.size >= 2) {
        // Pinch: a whole zoom step each time the fingers span 1.35× more/less.
        const span = this.pinchSpan();
        drag.moved = true;
        if (drag.pinch > 0 && span > 0) {
          const ratio = span / drag.pinch;
          if (ratio > 1.3) { this.zoomBy(1, p.x, p.y); drag.pinch = span; }
          else if (ratio < 0.77) { this.zoomBy(-1, p.x, p.y); drag.pinch = span; }
        } else drag.pinch = span;
        return;
      }
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < 5) return;
      drag.moved = true;
      host.classList.add('is-dragging');
      this.cam.x -= (p.x - before.x) / this.cam.zoom;
      this.cam.y -= (p.y - before.y) / this.cam.zoom;
      this.userMoved = true;
      this.clampCamera();
      this.labelsDirty = true;
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const drag = this.drag;
      if (this.pointers.size > 0) { if (drag) drag.pinch = 0; return; }
      this.drag = null;
      host.classList.remove('is-dragging');
      if (!drag || drag.moved || e.type === 'pointercancel') return;
      const p = local(e);
      const pick = this.pickAt(p.x, p.y);
      const key = pick ? JSON.stringify(pick) : '';
      const double = key !== '' && key === this.lastClick.key && performance.now() - this.lastClick.at < 380;
      this.lastClick = { at: performance.now(), key };
      this.hooks.onPick(pick, double ? 'double' : 'click', e.clientX, e.clientY);
    };
    on(host, 'pointerup', up);
    on(host, 'pointercancel', up);
    on(host, 'pointerleave', () => { if (!this.drag) this.hover(null); });
    on(host, 'contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      if (this.arcade) return;
      const p = local(e);
      this.hooks.onPick(this.pickAt(p.x, p.y), 'menu', e.clientX, e.clientY);
    });
    on(host, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      if (this.arcade) return;
      // A wheel notch is ~100; a trackpad pinch (ctrl) sends small deltas.
      this.wheel += e.deltaY * (e.ctrlKey ? 4 : 1);
      const p = local(e);
      while (this.wheel <= -90) { this.zoomBy(1, p.x, p.y); this.wheel += 90; }
      while (this.wheel >= 90) { this.zoomBy(-1, p.x, p.y); this.wheel -= 90; }
    }, { passive: false });

    on(window, 'keydown', (e: KeyboardEvent) => {
      // A run owns the keyboard (it is played with nothing else).
      if (this.arcade) {
        if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
        if (this.arcade.key(e, true)) e.preventDefault();
        return;
      }
      if (!this.inputEnabled || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (PAN_KEYS.has(key)) { this.keys.add(key); this.goal = null; e.preventDefault(); }
      else if (key === '+' || key === '=') this.zoomBy(1);
      else if (key === '-' || key === '_') this.zoomBy(-1);
    });
    on(window, 'keyup', (e: KeyboardEvent) => {
      if (this.arcade) { this.arcade.key(e, false); return; }
      this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    });
    on(window, 'blur', () => { this.keys.clear(); this.arcade?.release(); });
  }

  private pinchSpan(): number {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private hover(pick: Pick | null): void {
    const same = JSON.stringify(pick) === JSON.stringify(this.hovered);
    if (same) return;
    this.hovered = pick;
    // On an island only a robot or a "+" answers a click; on the map, any island.
    this.host.classList.toggle('is-pointing',
      pick != null && (pick.kind === 'agent' || pick.kind === 'spawn' || this.scene?.kind === 'map'));
    this.markSelection();
    this.labelsDirty = true;
  }

  /** What is under a point of the stage (CSS pixels). */
  pickAt(sx: number, sy: number): Pick | null {
    const world = this.world;
    if (!world) return null;
    const view = this.view();
    const wx = view.left + sx / this.cam.zoom;
    const wy = view.top + sy / this.cam.zoom;
    // The "+" spots are an island's: on the map they are specks.
    const spots = this.scene?.kind === 'island';
    for (const island of world.islands) {
      if (!this.shown(island.vpsId)) continue;
      const x = island.tx * T;
      const y = island.ty * T;
      if (wx < x || wy < y - 30 || wx > x + island.tw * T || wy > y + island.th * T + 12) continue;
      for (const plot of island.plots) {
        if (wx < plot.x || wy < plot.y || wx > plot.x + plot.w || wy > plot.y + plot.h) continue;
        for (const station of plot.stations) {
          if (wx >= station.x && wy >= station.y && wx < station.x + CELL_W * T && wy < station.y + CELL_H * T) {
            return { kind: 'agent', id: station.id };
          }
        }
        const { slot } = plot;
        if (spots && wx >= slot.x && wy >= slot.y && wx < slot.x + CELL_W * T && wy < slot.y + CELL_H * T) {
          return { kind: 'spawn', vpsId: plot.vpsId, cwd: plot.cwd };
        }
        return { kind: 'plot', vpsId: plot.vpsId, cwd: plot.cwd };
      }
      const box = spots ? spawnBox(island, null) : null;
      if (box && wx >= box.x && wy >= box.y && wx < box.x + box.w && wy < box.y + box.h) {
        return { kind: 'spawn', vpsId: island.vpsId, cwd: null };
      }
      return { kind: 'vps', id: island.vpsId };
    }
    return null;
  }

  /* ───────────────────────────────────────────────────────────── step ─── */

  private step(dt: number): void {
    if (this.arcade) { this.stepArcade(dt); return; }
    // Keyboard pan.
    if (this.inputEnabled && this.keys.size) {
      const speed = (520 / this.cam.zoom) * dt;
      let dx = 0; let dy = 0;
      if (this.keys.has('ArrowLeft') || this.keys.has('a') || this.keys.has('q')) dx -= 1;
      if (this.keys.has('ArrowRight') || this.keys.has('d')) dx += 1;
      if (this.keys.has('ArrowUp') || this.keys.has('w') || this.keys.has('z')) dy -= 1;
      if (this.keys.has('ArrowDown') || this.keys.has('s')) dy += 1;
      if (dx || dy) {
        this.cam.x += dx * speed;
        this.cam.y += dy * speed;
        this.userMoved = true;
        this.clampCamera();
        this.labelsDirty = true;
      }
    }
    if (this.goal) {
      const k = 1 - Math.exp(-dt * this.goalRate);
      this.cam.x += (this.goal.x - this.cam.x) * k;
      this.cam.y += (this.goal.y - this.cam.y) * k;
      if (Math.hypot(this.goal.x - this.cam.x, this.goal.y - this.cam.y) < 0.3) this.goal = null;
      this.labelsDirty = true;
    }

    for (const actor of this.actors.values()) {
      const s = actor.station;
      const atDesk = seated(actor.mood, actor.busy);
      const tx = atDesk ? s.seatX : s.restX;
      const ty = atDesk ? s.seatY : s.restY;
      const dx = tx - actor.x;
      const dy = ty - actor.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 200) { actor.x = tx; actor.y = ty; }
      else if (dist > 0.4) {
        const stepLen = Math.min(dist, WALK * dt);
        actor.x += (dx / dist) * stepLen;
        actor.y += (dy / dist) * stepLen;
      } else { actor.x = tx; actor.y = ty; }
      if (actor.mood === 'sleep' && this.time - actor.zAt > 1500) {
        actor.zAt = this.time + (actor.seed % 700);
        this.particles.push({
          x: actor.x + 4, y: actor.y - 18, vx: 3, vy: -7, g: 0, life: 0, max: 1700, colour: '#aab6cf', size: 1, kind: 'z',
        });
      }
      if (actor.mood === 'error' && Math.random() < dt * 2.2) {
        this.particles.push({
          x: actor.x + (Math.random() * 8 - 4), y: actor.y - 18, vx: Math.random() * 6 - 3, vy: -10, g: -2,
          life: 0, max: 1100, colour: Math.random() < 0.3 ? MOOD_COLOR.error : '#5a6172', size: 2, kind: 'px',
        });
      }
    }

    const ms = dt * 1000;
    this.particles = this.particles.filter((p) => {
      p.life += ms;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      return p.life < p.max;
    });
    this.rings = this.rings.filter((r) => { r.t += ms; return r.t < r.max; });
    this.wisps = this.wisps.filter((w) => { w.t += ms; return w.t < w.max; });
    if (this.floats.length) {
      this.floats = this.floats.filter((f) => {
        if (this.time < f.until) return true;
        f.el.remove();
        return false;
      });
    }
    if (this.time - this.captionAt > 15_000) {
      this.captionAt = this.time;
      this.refreshCaptions();
    }
    // The caches age on the wall clock: read them again each second.
    if (this.time - this.cacheAt > 1_000) {
      this.cacheAt = this.time;
      const now = Date.now();
      for (const actor of this.actors.values()) {
        actor.cache = sessionCacheReading(actor.session, now);
        this.refreshCaption(actor);
      }
    }
  }

  private burst(x: number, y: number, colour: string, count: number, speed: number): void {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.particles.push({
        x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v - 10, g: 60,
        life: 0, max: 380 + Math.random() * 260, colour, size: 1, kind: 'px',
      });
    }
  }

  private puff(x: number, y: number, colour: string, count: number): void {
    this.burst(x, y, colour, count, 22);
  }

  private confetti(x: number, y: number): void {
    const colours = ['#4ade80', '#ffe066', '#7cc4ff', '#ff8fb3', '#ffffff'];
    for (let i = 0; i < 22; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const v = 45 + Math.random() * 55;
      this.particles.push({
        x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, g: 150,
        life: 0, max: 900 + Math.random() * 600, colour: colours[i % colours.length], size: i % 3 === 0 ? 2 : 1, kind: 'px',
      });
    }
  }

  /* ───────────────────────────────────────────────────────────── draw ─── */

  private draw(): void {
    // A run on the 3D stage: it is drawn over a board left as it was — still
    // drawn for the instant the stage takes to fade in over it.
    if (this.arcade?.staged) {
      this.arcade.drawStage();
      if (!this.arcade.stageFresh) return;
    }
    const g = this.g;
    const { zoom } = this.cam;
    const view = this.view();
    const bw = Math.ceil(view.w) + 2;
    const bh = Math.ceil(view.h) + 2;
    if (this.canvas.width !== bw || this.canvas.height !== bh || this.styledZoom !== zoom) {
      if (this.canvas.width !== bw) this.canvas.width = bw;
      if (this.canvas.height !== bh) this.canvas.height = bh;
      this.canvas.style.width = `${bw * zoom}px`;
      this.canvas.style.height = `${bh * zoom}px`;
      this.styledZoom = zoom;
    }
    const vx = Math.floor(view.left);
    const vy = Math.floor(view.top);
    // A blast shakes the stage: whole world pixels, so it stays crisp.
    const shake = this.time < this.shakeUntil ? this.shakeBy : 0;
    const jx = shake ? Math.round((Math.random() * 2 - 1) * shake) : 0;
    const jy = shake ? Math.round((Math.random() * 2 - 1) * shake) : 0;
    this.canvas.style.transform = `translate(${(jx - (view.left - vx)) * zoom}px, ${(jy - (view.top - vy)) * zoom}px)`;
    g.setTransform(1, 0, 0, 1, -vx, -vy);
    g.imageSmoothingEnabled = false;

    drawWater(g, vx, vy, bw, bh, this.time);
    const world = this.world;
    if (!world) return;
    const sprites = art();
    const t = this.time;
    const inView = (x: number, y: number, w: number, h: number) => x + w > vx && y + h > vy && x < vx + bw && y < vy + bh;

    // A run of the mini-game takes the stage: its own drawing, its floats.
    if (this.arcade) {
      this.drawArcade(g, world, inView);
      this.labelsDirty = false;
      this.placeLabels(view);
      return;
    }

    // Only what the scene shows: one island, or all of them.
    const islands = world.islands.filter((i) => this.shown(i.vpsId));
    const actors: Actor[] = [];
    for (const actor of this.actors.values()) {
      const s = actor.station;
      if (this.shown(actor.session.vpsId) && inView(s.x - 8, s.y - 8, CELL_W * T + 16, CELL_H * T + 16)) actors.push(actor);
    }

    // Islands, their surf, and Charon's boat going round.
    for (const island of islands) {
      const layer = this.layers.get(island.vpsId);
      if (!layer || !inView(layer.x, layer.y, layer.canvas.width, layer.canvas.height)) continue;
      g.drawImage(layer.canvas, layer.x, layer.y);
      drawFoam(g, layer.foam, t + island.seed % 1000);
    }
    this.drawFerry(g, islands, t);

    // Light pools, under everything that stands.
    g.globalCompositeOperation = 'lighter';
    for (const island of islands) {
      const layer = this.layers.get(island.vpsId);
      if (!layer || !inView(layer.x, layer.y, layer.canvas.width, layer.canvas.height)) continue;
      for (const light of layer.lights) {
        g.globalAlpha = light.alpha * (0.85 + 0.15 * Math.sin(t * 0.004 + light.x));
        g.drawImage(glow(light.colour), light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
      }
    }
    for (const actor of actors) {
      const s = actor.station;
      const mood = actor.mood;
      if (mood === 'idle' || mood === 'sleep') continue;
      const pulse = mood === 'work' || mood === 'bg' ? 0.2 + 0.05 * Math.sin(t * 0.005 + actor.seed)
        : 0.22 + 0.16 * (0.5 + 0.5 * Math.sin(t * 0.006));
      g.globalAlpha = pulse;
      const r = 30;
      g.drawImage(glow(MOOD_COLOR[mood]), s.x + (CELL_W * T) / 2 - r, s.deskY - 8 - r, r * 2, r * 2);
    }
    // The fires: a warm cache lights its corner of the deck, less and less.
    for (const actor of actors) {
      const c = actor.cache;
      if (!c || (c.phase !== 'warm' && c.phase !== 'live')) continue;
      const s = actor.station;
      const r = 9 + 12 * c.frac;
      g.globalAlpha = (0.12 + 0.26 * c.frac) * (0.85 + 0.15 * Math.sin(t * 0.011 + actor.seed));
      g.drawImage(glow(HEAT[c.level].ember), s.deskX + 9 - r, s.deskY - 17 - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // A team's rug answers when one of its own is pointed at or selected.
    for (const [pick, strength] of [[this.hovered, 0.4], [this.selected, 0.85]] as const) {
      if (pick?.kind !== 'agent') continue;
      const station = world.stations.get(pick.id);
      const team = station?.team;
      if (!station || !team || !this.shown(station.plot.vpsId)) continue;
      g.globalAlpha = strength * (0.75 + 0.25 * Math.sin(t * 0.005));
      g.strokeStyle = blend(team.tint, '#ffffff', 0.4);
      g.lineWidth = 1;
      g.strokeRect(team.x + 1.5, team.y + 24.5, team.w - 3, team.h - 26);
    }
    g.globalAlpha = 1;

    // Selection and hover: brackets around the station — or around a "+".
    if (this.hovered?.kind === 'agent') this.drawBrackets(g, this.hovered.id, 'rgba(232,238,249,0.45)', 0);
    if (this.selected?.kind === 'agent') this.drawBrackets(g, this.selected.id, '#ffffff', 1 + Math.round(Math.sin(t * 0.008)));
    const spots = this.scene?.kind === 'island';
    const hot = spots && this.hovered?.kind === 'spawn' ? this.hovered : null;
    if (hot) {
      const island = islands.find((i) => i.vpsId === hot.vpsId);
      const box = island ? spawnBox(island, hot.cwd) : null;
      if (box) corners(g, box.x, box.y + 2, box.x + box.w - 1, box.y + box.h - 3, 'rgba(255,224,102,0.8)');
    }

    // Everything that stands, back to front.
    type Item = { y: number; draw: () => void };
    const items: Item[] = [];
    for (const island of islands) {
      const tall = !island.small;
      const sprite = tall ? sprites.beacon : sprites.beaconSmall;
      const bx = Math.round(island.beaconX - sprite.width / 2);
      const by = Math.round(island.beaconY - sprite.height);
      if (!inView(bx - 40, by - 40, sprite.width + 80, sprite.height + 80)) continue;
      items.push({ y: island.beaconY, draw: () => this.drawBeacon(g, island, bx, by, tall) });
    }
    for (const actor of actors) {
      const s = actor.station;
      // A lead's mast stands at the back of its dais.
      if (s.lead && s.team) { const team = s.team; items.push({ y: s.deskY - 13, draw: () => this.drawMast(g, s, team) }); }
      items.push({ y: s.deskY, draw: () => this.drawDesk(g, actor) });
      items.push({ y: actor.y, draw: () => this.drawActor(g, actor) });
    }
    // The free console of each deck: dim, nobody at it.
    const slots: Array<{ slot: Slot; hot: boolean }> = [];
    if (spots) {
      for (const island of islands) {
        for (const plot of island.plots) {
          const { slot } = plot;
          if (!inView(slot.x - 8, slot.y - 8, CELL_W * T + 16, CELL_H * T + 16)) continue;
          slots.push({ slot, hot: hot?.vpsId === plot.vpsId && hot.cwd === plot.cwd });
          items.push({ y: slot.deskY, draw: () => {
            const desk = sprites.desk;
            g.globalAlpha = 0.5;
            g.drawImage(desk, Math.round(slot.deskX - desk.width / 2), Math.round(slot.deskY - desk.height));
            g.globalAlpha = 1;
          } });
        }
      }
    }
    items.sort((a, b) => a.y - b.y);
    for (const item of items) item.draw();

    // Above the heads: holo screens, markers, drones.
    for (const actor of actors) this.drawOverhead(g, actor);
    // The "+" of every place a new robot can appear at: free consoles, the deck being built.
    for (const { slot, hot: lit } of slots) this.drawPlus(g, slot.holoX, slot.holoY, slot.deskY - 23 - slot.holoY, lit, slot.x);
    if (spots) {
      for (const island of islands) {
        const pad = sitePad(island.site);
        if (!inView(pad.x - 8, pad.y - 24, 24, 32)) continue;
        this.drawPlus(g, pad.x - 1, pad.y - 16, 5, hot?.vpsId === island.vpsId && hot.cwd == null, island.seed);
      }
    }

    // Effects.
    for (const r of this.rings) {
      const k = r.t / r.max;
      g.globalAlpha = (1 - k) * 0.9;
      g.strokeStyle = r.colour;
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, 3 + r.r * k, (3 + r.r * k) * 0.5, 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    for (const w of this.wisps) {
      const k = w.t / w.max;
      for (let i = 0; i < 6; i += 1) {
        const kk = Math.max(0, k - i * 0.03);
        const e = kk * kk * (3 - 2 * kk);
        const x = w.ax + (w.bx - w.ax) * e;
        const y = w.ay + (w.by - w.ay) * e - Math.sin(e * Math.PI) * 26;
        g.globalAlpha = (1 - i / 6) * 0.95;
        g.fillStyle = i === 0 ? '#ffffff' : w.colour;
        const sz = i < 2 ? 2 : 1;
        g.fillRect(Math.round(x), Math.round(y), sz, sz);
      }
    }
    g.globalAlpha = 1;
    for (const p of this.particles) {
      const k = p.life / p.max;
      g.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      if (p.kind === 'z') {
        g.fillStyle = p.colour;
        const x = Math.round(p.x); const y = Math.round(p.y);
        g.fillRect(x, y, 3, 1); g.fillRect(x + 1, y + 1, 1, 1); g.fillRect(x, y + 2, 3, 1);
      } else {
        g.fillStyle = p.colour;
        g.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
    }
    g.globalAlpha = 1;

    this.placeLabels(view);
    if (this.minimap && t - this.minimapAt > 180) { this.minimapAt = t; this.drawMinimap(view); }
    if (this.thumbs.size && t - this.thumbAt > 450) { this.thumbAt = t; this.paintThumbs(); }
  }

  private drawBrackets(g: CanvasRenderingContext2D, id: string, colour: string, inset: number): void {
    const s = this.world?.stations.get(id);
    if (!s || !this.shown(s.plot.vpsId)) return;
    corners(g, s.x + inset, s.y + 2 + inset, s.x + CELL_W * T - 1 - inset, s.y + CELL_H * T - 3 - inset, colour);
  }

  /**
   * The mast at the corner of a lead's dais: a pennant in its team's colour,
   * in the wind. It flies to the LEFT, off the cell: the lead's own marker
   * (over its head, at rest or at its console) never hides it.
   */
  private drawMast(g: CanvasRenderingContext2D, s: Station, team: Team): void {
    const x = s.x + 1;
    const top = s.y - 2;
    const foot = s.deskY - 8;
    g.fillStyle = '#10131b';
    g.fillRect(x, top, 2, foot - top);
    g.fillStyle = '#6b7590';
    g.fillRect(x, top, 1, foot - top);
    g.fillStyle = '#ffe066';
    g.fillRect(x, top - 1, 2, 1);
    const t = this.time + (hashStr(team.leadId) % 1000);
    const light = blend(team.tint, '#ffffff', 0.18);
    const dark = blend(team.tint, '#10131b', 0.35);
    for (let c = 0; c < 10; c += 1) {
      const swell = Math.sin(t * 0.007 - c * 0.8);
      const h = Math.max(1, 6 - Math.floor((c * 6) / 10));
      const y = top + 1 + Math.floor((6 - h) / 2) + (c < 2 ? 0 : Math.round(swell * (c < 5 ? 0.6 : 1.1)));
      g.fillStyle = swell > 0.35 ? light : swell < -0.5 ? dark : team.tint;
      g.fillRect(x - 1 - c, y, 1, h);
    }
  }

  /** "A new robot, here": a holo screen with a plus, over a free console or a deck being built. */
  private drawPlus(g: CanvasRenderingContext2D, x: number, y: number, beam: number, hot: boolean, seed: number): void {
    const t = this.time + (seed % 1000);
    const colour = hot ? '#ffe066' : '#b9c6de';
    const breathe = hot ? 1 : 0.5 + 0.18 * Math.sin(t * 0.003);
    const hy = y + (Math.floor(t / 700) % 2);
    g.globalAlpha = 0.45 * breathe;
    g.fillStyle = colour;
    g.fillRect(x + 5, hy + 11, 1, Math.max(0, beam - (hy - y)));
    g.globalAlpha = 0.6 + 0.3 * breathe;
    g.fillStyle = '#0b1220';
    g.fillRect(x, hy, 11, 11);
    g.globalAlpha = breathe;
    g.fillStyle = colour;
    g.fillRect(x, hy, 11, 1); g.fillRect(x, hy + 10, 11, 1);
    g.fillRect(x, hy, 1, 11); g.fillRect(x + 10, hy, 1, 11);
    g.globalAlpha = Math.min(1, breathe + 0.3);
    g.fillRect(x + 3, hy + 5, 5, 1); g.fillRect(x + 5, hy + 3, 1, 5);
    g.globalAlpha = 1;
  }

  private drawBeacon(g: CanvasRenderingContext2D, island: Island, bx: number, by: number, tall: boolean): void {
    const sprites = art();
    const state: Mood | 'off' = this.offline.has(island.vpsId) ? 'off' : this.islandMood.get(island.vpsId) ?? 'idle';
    const t = this.time;
    const glass = tall ? BEACON_GLASS.tall : BEACON_GLASS.small;
    let colour = '#ffd98a';
    let level = 0.55;
    if (state === 'off') { colour = '#ff5d5d'; level = Math.floor(t / 600) % 2 ? 0.9 : 0.15; }
    else if (state === 'blocked' || state === 'question') { colour = MOOD_COLOR.blocked; level = 0.6 + 0.4 * Math.sin(t * 0.007); }
    else if (state === 'error') { colour = MOOD_COLOR.error; level = 0.9; }
    else if (state === 'done') { colour = MOOD_COLOR.done; level = 0.9; }
    else if (state === 'work' || state === 'bg') { colour = MOOD_COLOR.work; level = 0.85; }
    else if (state === 'sleep') level = 0.2;
    g.fillStyle = '#10131b';
    g.fillRect(bx + glass.x, by + glass.y, glass.w, glass.h);
    g.globalAlpha = Math.max(0.1, level);
    g.fillStyle = colour;
    g.fillRect(bx + glass.x, by + glass.y, glass.w, glass.h);
    g.globalAlpha = 1;
    g.drawImage(tall ? sprites.beacon : sprites.beaconSmall, bx, by);
    // The lamp's halo, and on the big islands its turning beam.
    const lx = bx + glass.x + glass.w / 2;
    const ly = by + glass.y + glass.h / 2;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.5 * level;
    const r = tall ? 22 : 12;
    g.drawImage(glow(colour), lx - r, ly - r, r * 2, r * 2);
    if (tall && state !== 'off' && state !== 'sleep') {
      const angle = t * 0.0005 + (island.seed % 628) / 100;
      g.globalAlpha = 0.07 + 0.05 * level;
      g.fillStyle = colour;
      for (const side of [0, Math.PI]) {
        const a = angle + side;
        const reach = 90;
        g.beginPath();
        g.moveTo(lx, ly);
        g.lineTo(lx + Math.cos(a - 0.13) * reach, ly + Math.sin(a - 0.13) * reach * 0.55);
        g.lineTo(lx + Math.cos(a + 0.13) * reach, ly + Math.sin(a + 0.13) * reach * 0.55);
        g.closePath();
        g.fill();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  private drawDesk(g: CanvasRenderingContext2D, actor: Actor): void {
    const s = actor.station;
    const desk = art().desk;
    const x = Math.round(s.deskX - desk.width / 2);
    const y = Math.round(s.deskY - desk.height);
    g.drawImage(desk, x, y);
    // Two status lights on its front.
    const lit = actor.mood !== 'idle' && actor.mood !== 'sleep';
    g.fillStyle = lit ? MOOD_COLOR[actor.mood] : '#232a39';
    const blink = actor.busy ? Math.floor((this.time + actor.seed) / 260) % 2 : 0;
    g.fillRect(x + 4, y + 6, 1, 1);
    if (!blink) g.fillRect(x + 15, y + 6, 1, 1);
  }

  private drawActor(g: CanvasRenderingContext2D, actor: Actor): void {
    const t = this.time + actor.seed % 1000;
    const s = actor.station;
    const moving = Math.hypot(actor.x - (seated(actor.mood, actor.busy) ? s.seatX : s.restX),
      actor.y - (seated(actor.mood, actor.busy) ? s.seatY : s.restY)) > 0.5;
    const colour = MOOD_COLOR[actor.mood];
    const pose: RobotPose = {
      bob: 0, legs: 'stand', armL: 'down', armR: 'down', armLdy: 0, armRdy: 0,
      eye: '#dce9ff', lamp: null, chest: actor.chest, scan: 0.5, alpha: 1,
    };
    let lift = 0;
    const blinkCycle = (t + actor.seed % 3000) % 4200;
    const blinking = blinkCycle < 130;
    if (moving) {
      const f = Math.floor(t / 130) % 2;
      pose.legs = f ? 'walkA' : 'walkB';
      pose.bob = f;
      pose.eye = colour;
    } else {
      switch (actor.mood) {
        case 'bg': {
          // Its turn is over: it stands by, lit, while its drones work on.
          pose.bob = Math.floor(t / 900) % 2;
          pose.eye = blinking ? null : colour;
          pose.lamp = Math.floor(t / 700) % 2 ? colour : '#1c2433';
          break;
        }
        case 'work': {
          const beat = actor.activity?.beat;
          const hot = this.time - actor.beatAt < 1300;
          const rate = hot ? 85 : beat === 'think' ? 0 : 240;
          if (rate) {
            const f = Math.floor(t / rate) % 2;
            pose.armLdy = f ? 0 : 1;
            pose.armRdy = f ? 1 : 0;
          }
          pose.bob = Math.floor(t / 520) % 2;
          pose.eye = colour;
          pose.lamp = Math.floor(t / 300) % 2 ? colour : '#1c2433';
          pose.scan = 0.5 + 0.5 * Math.sin(t * 0.006);
          break;
        }
        case 'blocked':
        case 'question': {
          pose.armR = 'up';
          pose.armRdy = Math.floor(t / 280) % 2 ? -1 : 0;
          pose.eye = colour;
          pose.lamp = Math.floor(t / 280) % 2 ? colour : '#3a2a10';
          pose.bob = Math.floor(t / 560) % 2;
          break;
        }
        case 'done': {
          pose.armL = 'up';
          pose.armR = 'up';
          pose.eye = colour;
          pose.lamp = colour;
          // A hop when it finishes, then a small one now and then.
          const since = this.time - actor.hopAt;
          const cycle = since < 900 ? since : (t % 2600) - 2200;
          if (cycle > 0 && cycle < 380) lift = Math.round(Math.sin((cycle / 380) * Math.PI) * (since < 900 ? 6 : 3));
          pose.armLdy = lift ? -1 : 0;
          pose.armRdy = lift ? -1 : 0;
          break;
        }
        case 'error': {
          pose.eye = Math.floor(t / 400) % 2 ? colour : null;
          pose.lamp = colour;
          pose.bob = 1;
          break;
        }
        case 'sleep':
          pose.legs = 'sit';
          pose.eye = null;
          pose.chest = '#2a3142';
          pose.alpha = 0.82;
          pose.bob = Math.floor(t / 1400) % 2;
          break;
        default: {
          pose.bob = Math.floor(t / 900) % 2;
          pose.eye = blinking ? null : '#cfe0fb';
          pose.lamp = '#55607a';
          break;
        }
      }
    }
    const born = this.time - actor.bornAt;
    if (born < 500) pose.alpha = Math.max(0.15, born / 500);
    // A shadow under the feet.
    g.fillStyle = 'rgba(8, 10, 16, 0.4)';
    g.fillRect(Math.round(actor.x) - 6, Math.round(actor.y) - 1, 12, 2);
    drawRobot(g, actor.art, actor.x, actor.y - lift, pose);
  }

  private drawOverhead(g: CanvasRenderingContext2D, actor: Actor): void {
    const s = actor.station;
    const t = this.time + actor.seed % 1000;
    const sprites = art();
    const mood = actor.mood;
    const atDesk = seated(mood, actor.busy);
    // The brazier at the end of the console: its prompt cache. A flame as
    // tall as the cache has life left (full while a turn keeps it alive), and
    // a dark bowl once it is cold — nothing else: cold is the absence of fire.
    const cache = actor.cache;
    if (cache) {
      const bx = s.deskX + 6;
      const by = s.deskY - 14;
      g.drawImage(sprites.brazier, bx, by);
      if (cache.phase === 'live' || cache.phase === 'warm') {
        const heat = HEAT[cache.level];
        drawFlame(g, bx + 3, by, cache.frac, t, heat.ember, heat.core, cache.phase === 'live');
      }
    }
    // The holo screen: what it is doing, as an icon in the tool's colour.
    if (atDesk && actor.busy && mood !== 'blocked') {
      const a = actor.activity;
      let icon: IconName = 'think';
      let colour = FAMILY_COLOR.think;
      if (a?.beat === 'tool') { const f = toolFamily(a.tool); icon = f; colour = FAMILY_COLOR[f]; }
      else if (a?.beat === 'say') { icon = 'say'; colour = FAMILY_COLOR.say; }
      else if (a?.beat === 'compact') { icon = 'compact'; colour = FAMILY_COLOR.plan; }
      const hx = s.holoX;
      const hy = s.holoY + (Math.floor(t / 700) % 2);
      const flicker = (Math.floor(t / 90) % 23 === 0) ? 0.55 : 1;
      // Its beam rises from the console — unless a fire is there to carry it.
      if (!cache || (cache.phase !== 'warm' && cache.phase !== 'live')) {
        g.globalAlpha = 0.5 * flicker;
        g.fillStyle = colour;
        g.fillRect(hx + 5, hy + 11, 1, s.deskY - 12 - hy - 11);
      }
      g.globalAlpha = 0.9 * flicker;
      g.fillStyle = '#0b1220';
      g.fillRect(hx, hy, 11, 11);
      g.globalAlpha = flicker;
      g.fillStyle = colour;
      g.fillRect(hx, hy, 11, 1); g.fillRect(hx, hy + 10, 11, 1);
      g.fillRect(hx, hy, 1, 11); g.fillRect(hx + 10, hy, 1, 11);
      if (icon === 'think') {
        const dot = Math.floor(t / 260) % 4;
        for (let i = 0; i < 3; i += 1) {
          g.globalAlpha = (i === dot ? 1 : 0.35) * flicker;
          g.fillRect(hx + 2 + i * 3, hy + 5 - (i === dot ? 1 : 0), 1, 1);
          g.fillRect(hx + 2 + i * 3, hy + 5, 1, 1);
        }
      } else drawIcon(g, icon, hx + 2, hy + 2, colour);
      g.globalAlpha = 1;
    }
    // The marker over its head.
    let marker: 'bang' | 'ask' | 'check' | 'cross' | null = null;
    if (mood === 'blocked') marker = 'bang';
    else if (mood === 'question') marker = 'ask';
    else if (mood === 'error') marker = 'cross';
    else if (mood === 'done') marker = 'check';
    if (marker) {
      const bounce = Math.round(Math.abs(Math.sin(t * 0.006)) * 3);
      const sprite = sprites.marker[marker];
      g.drawImage(sprite, Math.round(actor.x - sprite.width / 2), Math.round(actor.y - 37 - bounce));
    }
    // Helpers: one drone per running background task (up to six).
    const drones = Math.min(6, actor.session.runningBgTasks ?? 0);
    for (let i = 0; i < drones; i += 1) {
      const angle = t * 0.0022 + (i * Math.PI * 2) / Math.max(1, drones);
      const dx = Math.cos(angle) * 17;
      const dy = Math.sin(angle) * 6;
      const x = Math.round(s.x + (CELL_W * T) / 2 + dx - 2);
      const y = Math.round(s.y + 22 + dy + Math.sin(t * 0.008 + i) * 1.5);
      g.drawImage(sprites.drone, x, y);
      if (Math.floor((t + i * 170) / 240) % 2) {
        g.fillStyle = '#eafffb';
        g.fillRect(x + 2, y + 2, 1, 1);
      }
    }
  }

  /** Charon's ferry: one small boat that never stops — round the island on
   *  stage, or from island to island on the map. */
  private drawFerry(g: CanvasRenderingContext2D, islands: Island[], t: number): void {
    const big = islands.filter((i) => !i.small);
    const first = big[0] ?? islands[0];
    if (!first) return;
    let x: number;
    let y: number;
    if (big.length <= 1) {
      const angle = t * 0.00007 + (first.seed % 628) / 100;
      x = Math.round((first.tx + first.tw / 2) * T + Math.cos(angle) * (first.tw * T * 0.5 + 44));
      y = Math.round((first.ty + first.th / 2) * T + 8 + Math.sin(angle) * (first.th * T * 0.5 + 40) + Math.sin(t * 0.002) * 1.5);
    } else {
      const stops = big.map((i) => ({ x: (i.tx + i.tw / 2) * T, y: (i.ty + i.th) * T + 26 }));
      const at = t / 16_000;
      const i = Math.floor(at) % stops.length;
      const a = stops[i];
      const b = stops[(i + 1) % stops.length];
      const k = at - Math.floor(at);
      const e = k * k * (3 - 2 * k);
      x = Math.round(a.x + (b.x - a.x) * e);
      y = Math.round(a.y + (b.y - a.y) * e + Math.sin(t * 0.002) * 1.5);
    }
    const boat = art().boat;
    g.fillStyle = 'rgba(4, 8, 16, 0.4)';
    g.fillRect(x - 9, y + 3, 18, 2);
    g.drawImage(boat, x - 11, y - 5);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.35;
    g.drawImage(glow('#ffc763'), x - 15, y - 19, 30, 30);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /* ─────────────────────────────────────────────────── labels, minimap ─── */

  private placeLabels(view: { left: number; top: number; w: number; h: number }): void {
    const { zoom } = this.cam;
    const map = this.scene?.kind === 'map';
    const put = (p: Placard) => {
      const sx = Math.round((p.x - view.left) * zoom);
      const sy = Math.round((p.y - view.top) * zoom);
      const off = sx < -260 || sy < -60 || sx > this.size.w + 260 || sy > this.size.h + 60;
      const hide = off || zoom < p.minZoom || (p.scope === '' ? !map : !this.shown(p.scope));
      if (hide) {
        if (p.el.style.display !== 'none') p.el.style.display = 'none';
        return;
      }
      if (p.el.style.display === 'none') p.el.style.display = '';
      p.el.style.transform = p.centred ? `translate(${sx}px, ${sy}px) translateX(-50%)` : `translate(${sx}px, ${sy}px)`;
    };
    for (const f of this.floats) {
      const sx = Math.round((f.x - view.left) * zoom);
      const sy = Math.round((f.y - view.top) * zoom);
      f.el.style.transform = `translate(${sx}px, ${sy}px) translateX(-50%)`;
    }
    if (!this.labelsDirty) return;
    this.labelsDirty = false;
    const cell = CELL_W * T * zoom;
    this.labels.style.setProperty('--dk-cell', `${cell}px`);
    for (const p of this.placards) put(p);
    for (const [id, tag] of this.tags) {
      const forced = (this.selected?.kind === 'agent' && this.selected.id === id)
        || (this.hovered?.kind === 'agent' && this.hovered.id === id);
      const min = tag.minZoom;
      if (forced) tag.minZoom = 1;
      put(tag);
      tag.minZoom = min;
    }
  }

  private drawMinimap(view: { left: number; top: number; w: number; h: number }): void {
    const canvas = this.minimap;
    const world = this.world;
    const scene = this.scene;
    if (!canvas || !world || !scene) return;
    const b = scene.kind === 'map' ? world.bounds : this.sceneBox();
    // Nothing to find one's way in when the whole island is on screen.
    const whole = !b || (scene.kind === 'island'
      && view.left <= b.x + 4 && view.top <= b.y + 4 && view.left + view.w >= b.x + b.w - 4 && view.top + view.h >= b.y + b.h - 4);
    const visibility = whole ? 'hidden' : 'visible';
    if (canvas.style.visibility !== visibility) canvas.style.visibility = visibility;
    if (whole || !b) return;
    const w = canvas.clientWidth || 180;
    const h = canvas.clientHeight || 120;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d')!;
    const pad = 8;
    const scale = Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h);
    const ox = (w - b.w * scale) / 2 - b.x * scale;
    const oy = (h - b.h * scale) / 2 - b.y * scale;
    g.fillStyle = WATER.deep;
    g.fillRect(0, 0, w, h);
    for (const island of world.islands) {
      if (!this.shown(island.vpsId)) continue;
      g.fillStyle = island.small ? '#1c2f27' : '#2c4a3a';
      g.fillRect(Math.round(ox + island.tx * T * scale), Math.round(oy + island.ty * T * scale),
        Math.max(2, Math.round(island.tw * T * scale)), Math.max(2, Math.round(island.th * T * scale)));
      g.fillStyle = '#5d4a3b';
      for (const plot of island.plots) {
        g.fillRect(Math.round(ox + plot.x * scale), Math.round(oy + plot.y * scale),
          Math.max(1, Math.round(plot.w * scale)), Math.max(1, Math.round(plot.h * scale)));
      }
    }
    const blink = Math.floor(this.time / 350) % 2 === 0;
    for (const actor of this.actors.values()) {
      if (!this.shown(actor.session.vpsId)) continue;
      const s = actor.station;
      const loud = actor.mood === 'blocked' || actor.mood === 'question' || actor.mood === 'done' || actor.mood === 'error';
      if (loud && !blink) continue;
      g.fillStyle = MOOD_COLOR[actor.mood];
      const size = loud ? 4 : 3;
      g.fillRect(Math.round(ox + (s.x + 24) * scale - size / 2), Math.round(oy + (s.y + 32) * scale - size / 2), size, size);
    }
    g.strokeStyle = '#e8eef9';
    g.lineWidth = 1;
    g.strokeRect(Math.round(ox + view.left * scale) + 0.5, Math.round(oy + view.top * scale) + 0.5,
      Math.round(view.w * scale), Math.round(view.h * scale));
    this.minimapScale = { scale, ox, oy };
  }

  /** The selector's miniatures: each island as it is, its robots as dots. */
  private paintThumbs(): void {
    const world = this.world;
    if (!world) return;
    const blink = Math.floor(this.time / 450) % 2 === 0;
    for (const [key, canvas] of this.thumbs) {
      const w = Math.round((canvas.clientWidth || 54) * this.dpr);
      const h = Math.round((canvas.clientHeight || 36) * this.dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const g = canvas.getContext('2d');
      if (!g) continue;
      g.fillStyle = WATER.deep;
      g.fillRect(0, 0, w, h);
      const all = key === MAP_THUMB;
      const islands = all ? world.islands.filter((i) => !i.small) : world.islands.filter((i) => i.vpsId === key);
      if (!islands.length) continue;
      const only = islands[0];
      const box = all ? world.home : { x: only.tx * T, y: only.ty * T, w: only.tw * T, h: only.th * T + 11 };
      const pad = 2 * this.dpr;
      const scale = Math.min((w - pad * 2) / box.w, (h - pad * 2) / box.h);
      const ox = (w - box.w * scale) / 2 - box.x * scale;
      const oy = (h - box.h * scale) / 2 - box.y * scale;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      for (const island of islands) {
        const layer = this.layers.get(island.vpsId);
        if (layer) g.drawImage(layer.canvas, ox + layer.x * scale, oy + layer.y * scale, layer.canvas.width * scale, layer.canvas.height * scale);
      }
      const dot = Math.max(2, Math.round(1.5 * this.dpr));
      for (const actor of this.actors.values()) {
        if (!all && actor.session.vpsId !== key) continue;
        const mood = actor.mood;
        if (mood === 'idle' || mood === 'sleep') continue;
        const loud = mood === 'blocked' || mood === 'question' || mood === 'done' || mood === 'error';
        if (loud && !blink) continue;
        const s = actor.station;
        g.fillStyle = MOOD_COLOR[mood];
        g.fillRect(Math.round(ox + (s.x + 24) * scale - dot / 2), Math.round(oy + (s.y + 34) * scale - dot / 2), dot, dot);
      }
    }
  }

  private minimapScale = { scale: 1, ox: 0, oy: 0 };
  private styledZoom = 0;

  /** A click on the minimap (its own CSS pixels) moves the camera there. */
  jumpFromMinimap(mx: number, my: number): void {
    const { scale, ox, oy } = this.minimapScale;
    this.goal = null;
    this.cam.x = (mx - ox) / scale;
    this.cam.y = (my - oy) / scale;
    this.userMoved = true;
    this.clampCamera();
    this.labelsDirty = true;
  }
}

/* ───────────────────────────────────────────────────────── helpers ───── */

const PAN_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd', 'q', 'z']);

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * At its console (a turn runs, or it is parked on you) or standing beside it.
 * A turn that ended with background tasks still running is over: beside it,
 * like any robot that finished (the owner's call — it is not actively working).
 */
function seated(mood: Mood, busy: boolean): boolean {
  return busy || mood === 'blocked' || mood === 'work';
}

function chestColour(s: DeskSession): string {
  return ownColour(s) ?? '#ffd98a';
}

/** The corners of a box, as brackets. */
function corners(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, colour: string): void {
  const k = 5;
  g.fillStyle = colour;
  for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
    g.fillRect(dx > 0 ? x : x - k + 1, y, k, 1);
    g.fillRect(x, dy > 0 ? y : y - k + 1, 1, k);
  }
}

/** What a "+" answers on (world pixels): a deck's free console, or with `cwd` null the deck being built. */
function spawnBox(island: Island, cwd: string | null): { x: number; y: number; w: number; h: number } | null {
  if (cwd == null) {
    const s = island.site;
    return { x: s.x - 3, y: s.y - 8, w: s.w + 6, h: s.h + 13 };
  }
  const plot = island.plots.find((p) => p.cwd === cwd);
  return plot ? { x: plot.slot.x, y: plot.slot.y, w: CELL_W * T, h: CELL_H * T } : null;
}

function captionOf(actor: Actor): string {
  const s = actor.session as DeskSession & {
    gates?: Array<{ title: string; kind: string }>; lastActivityMs?: number | null;
  };
  const gate = s.gates?.[0];
  switch (actor.mood) {
    case 'blocked':
      return gate ? (gate.kind === 'permission' ? `allow ${gate.title}?` : gate.title) : 'waiting for you';
    case 'question':
      return gate?.title ?? 'has a question';
    case 'done':
      return s.lastActivityMs ? `done ${ago(Date.now() - s.lastActivityMs).replace(' ago', '')}` : 'done';
    case 'error':
      return 'failed';
    case 'sleep':
      return 'asleep';
    case 'bg': {
      const n = s.runningBgTasks ?? 0;
      return n ? `${n} bg task${n > 1 ? 's' : ''}` : 'bg work';
    }
    // A running turn says nothing here: the holo screen's icon tells the kind
    // of action, the unit panel the detail. (Command lines under every robot
    // made the deck unreadable.)
    default:
      return '';
  }
}

export { makeCanvas };
