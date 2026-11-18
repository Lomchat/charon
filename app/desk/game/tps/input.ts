// The player's hands in the 3D phase: the keyboard and the mouse, turned into
// what each way of playing reads — a stick for the seaplane, a helm for the
// boat, a look for the pilot on foot, a trigger and a few buttons for all.
//
// Keys are read by POSITION (`event.code`): the same fingers on any layout;
// what is printed on them is asked once, for the on-screen hints.
//
// The mouse: captured (pointer lock), it gives MOVEMENT — the look on foot and
// on the boat, and a cursor of our own for the seaplane, whose nose follows
// it. Not captured, its position does both jobs as well as it can.
const PULL = ['KeyS', 'ArrowDown'];
const PUSH = ['KeyW', 'ArrowUp'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const USED = new Set([
  ...PULL, ...PUSH, ...LEFT, ...RIGHT, 'Space', 'KeyF', 'KeyQ', 'KeyE', 'KeyX', 'KeyC', 'KeyI', 'ShiftLeft', 'ShiftRight', 'Tab',
]);

const INVERT_KEY = 'desk.arcade.invert';
/** Pixels in ONE mouse event: more is a glitch of the capture, not a hand. */
const LEAP = 320;

export class Input {
  /** What the keys ask of the seaplane's stick, eased: -1..1 each way. */
  readonly keys = { x: 0, y: 0 };
  /** The cursor, in stage pixels (our own while the mouse is captured); null until the mouse moves. */
  pointer: { x: number; y: number } | null = null;
  /** Which of the two flies the seaplane: the last one touched. */
  device: 'keys' | 'pointer' = 'keys';
  /** The mouse is captured: it turns the view instead of pointing. */
  locked = false;
  invert = false;
  private held = new Set<string>();
  private buttons = new Set<number>();
  private missile = false;
  private roll = 0;
  /** The capture just began: its first event is not to be trusted. */
  private fresh = false;
  private lookX = 0;
  private lookY = 0;
  private size = { w: 1, h: 1 };
  private labels = new Map<string, string>();

  constructor() {
    try { this.invert = localStorage.getItem(INVERT_KEY) === '1'; } catch { /* private mode */ }
    // What is printed on the keys of this keyboard (Chromium only; elsewhere: QWERTY names).
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    void keyboard?.getLayoutMap?.().then((map) => { this.labels = map; }, () => undefined);
  }

  resize(w: number, h: number): void {
    this.size = { w, h };
  }

  /** A key by its position, as this keyboard names it. */
  label(code: string): string {
    return (this.labels.get(code) ?? code.replace(/^Key/, '')).toUpperCase();
  }

  /** True: the game used the key (the page must not). */
  key(e: KeyboardEvent, down: boolean): boolean {
    const code = e.code;
    if (!USED.has(code)) return false;
    if (!down) { this.held.delete(code); return true; }
    if (e.repeat) return true;
    this.held.add(code);
    if (this.steering()) this.device = 'keys';
    if (code === 'KeyF') this.missile = true;
    else if (code === 'KeyQ') this.roll = -1;
    else if (code === 'KeyE') this.roll = 1;
    else if (code === 'KeyI') {
      this.invert = !this.invert;
      try { localStorage.setItem(INVERT_KEY, this.invert ? '1' : '0'); } catch { /* private mode */ }
    }
    return true;
  }

  /** The mouse moved: where it is, how far it went, whether it is captured. */
  pointerMove(x: number, y: number, dx: number, dy: number, locked: boolean): void {
    this.locked = locked;
    if (locked) {
      // A capture that just began, or a mouse that glitches, reports a leap no hand made: not a look.
      if (this.fresh) { this.fresh = false; return; }
      if (Math.abs(dx) > LEAP || Math.abs(dy) > LEAP) return;
      this.lookX += dx;
      this.lookY += dy;
      // Our own cursor, kept on the stage.
      const p = this.pointer ?? (this.pointer = { x: this.size.w / 2, y: this.size.h / 2 });
      p.x = Math.max(0, Math.min(this.size.w, p.x + dx));
      p.y = Math.max(0, Math.min(this.size.h, p.y + dy));
      if ((dx || dy) && !this.steering()) this.device = 'pointer';
      return;
    }
    const p = this.pointer;
    if (!p) { this.pointer = { x, y }; return; }
    // A nudge of the desk is not a hand on the mouse.
    if (Math.hypot(x - p.x, y - p.y) > 3 && !this.steering()) this.device = 'pointer';
    p.x = x; p.y = y;
  }

  /** The capture came or went (Esc, a click). */
  setLocked(locked: boolean): void {
    this.locked = locked;
    this.fresh = locked;
    this.lookX = 0;
    this.lookY = 0;
  }

  pointerDown(button: number): void {
    this.buttons.add(button);
    if (button === 2) this.missile = true;
  }

  pointerUp(button: number): void {
    this.buttons.delete(button);
  }

  /** The window lost the keyboard: nothing is held any more. */
  release(): void {
    this.held.clear();
    this.buttons.clear();
    this.lookX = 0;
    this.lookY = 0;
  }

  private any(codes: string[]): boolean {
    for (const code of codes) if (this.held.has(code)) return true;
    return false;
  }

  private steering(): boolean {
    return this.any(PULL) || this.any(PUSH) || this.any(LEFT) || this.any(RIGHT);
  }

  update(dt: number): void {
    const tx = (this.any(RIGHT) ? 1 : 0) - (this.any(LEFT) ? 1 : 0);
    const ty = ((this.any(PULL) ? 1 : 0) - (this.any(PUSH) ? 1 : 0)) * (this.invert ? -1 : 1);
    // A key is all or nothing; the stick it moves is not.
    const k = 1 - Math.exp(-9 * dt);
    this.keys.x += (tx - this.keys.x) * k;
    this.keys.y += (ty - this.keys.y) * k;
  }

  /** The mouse's travel since the last call, in pixels (captured mouse only). */
  takeLook(out: { x: number; y: number }): void {
    out.x = this.lookX; out.y = this.lookY;
    this.lookX = 0; this.lookY = 0;
  }

  /** The cursor's offset from the middle of the stage, -1..1 each way; 0 while there is none. */
  offset(out: { x: number; y: number }): void {
    const p = this.pointer;
    out.x = p ? (p.x / this.size.w) * 2 - 1 : 0;
    out.y = p ? (p.y / this.size.h) * 2 - 1 : 0;
  }

  /** The helm: W / S and A / D alone, raw. */
  get ahead(): number { return (this.held.has('KeyW') ? 1 : 0) - (this.held.has('KeyS') ? 1 : 0); }
  get side(): number { return (this.held.has('KeyD') ? 1 : 0) - (this.held.has('KeyA') ? 1 : 0); }
  /** The arrows alone, raw: they turn the view where the mouse does not. */
  get arrowX(): number { return (this.held.has('ArrowRight') ? 1 : 0) - (this.held.has('ArrowLeft') ? 1 : 0); }
  get arrowY(): number { return (this.held.has('ArrowUp') ? 1 : 0) - (this.held.has('ArrowDown') ? 1 : 0); }

  get firing(): boolean { return this.held.has('Space') || this.buttons.has(0); }
  /** The left button alone (on foot, Space is the ground fight's own key). */
  get trigger(): boolean { return this.buttons.has(0); }
  get boost(): boolean { return this.held.has('ShiftLeft') || this.held.has('ShiftRight'); }
  get brake(): boolean { return this.held.has('KeyX') || this.held.has('KeyC'); }

  /** A missile was asked for since the last call. */
  takeMissile(): boolean {
    const asked = this.missile;
    this.missile = false;
    return asked;
  }

  /** A barrel roll was asked for since the last call: its side, or 0. */
  takeRoll(): number {
    const side = this.roll;
    this.roll = 0;
    return side;
  }
}
