// The three shapes of the machine the pilot boards (game/tps): it flies, it
// sails, it drives — and turns from one into the other. Shared by the 3D
// phase's instruments and by the React overlay: nothing here needs three.js.

export type Form = 'plane' | 'boat' | 'tank';

/** Each shape in a few pixels (rows of `#`). */
export const FORM_GLYPH: Record<Form, string[]> = {
  plane: ['.....#.....', '.....#.....', '....###....', '###########', '.#########.', '.....#.....', '....###....', '...#####...'],
  boat: ['.....#.....', '.....##....', '.....###...', '.....#.....', '###########', '.#########.', '..#######..'],
  tank: ['...........', '....####...', '....#######', '....####...', '.#########.', '###########', '#.#.#.#.#.#', '.#########.'],
};

/** A key or a gesture, and what it does: one row of the keys panel. */
export type KeyHint = {
  /** What is printed on the keys, as this keyboard names them. */
  caps: string[];
  /** What the mouse does for the same: it is moved, or one of its buttons. */
  mouse?: 'move' | 'left' | 'right';
  word: string;
  /** The shapes it turns the machine into. */
  gives?: Form[];
  /** Not a move of the game: pause, sound, leave. */
  meta?: boolean;
};

/* What is printed on a key, by its POSITION (`event.code`): asked once from
   the browser (Chromium only; elsewhere the QWERTY names). */
let labels: Map<string, string> | null = null;
let asked = false;
let version = 0;

/** Changes when the names of the keys become known: a cache of hints is stale then. */
export function keyLabelsVersion(): number {
  return version;
}

export function keyLabel(code: string): string {
  if (!asked && typeof navigator !== 'undefined') {
    asked = true;
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    void keyboard?.getLayoutMap?.().then((map) => { labels = map; version += 1; }, () => undefined);
  }
  return (labels?.get(code) ?? code.replace(/^Key/, '')).toUpperCase();
}

const k = keyLabel;
const META: KeyHint[] = [
  { caps: ['P'], word: 'PAUSE', meta: true },
  { caps: ['M'], word: 'SOUND', meta: true },
  { caps: ['ESC'], word: 'LEAVE', meta: true },
];

/** The keys of a way of playing: on the board, on foot in 3D, in each shape of the machine. */
export function keyHints(mode: 'board' | 'foot' | Form): KeyHint[] {
  const wasd = [k('KeyW'), k('KeyA'), k('KeyS'), k('KeyD')];
  // The mouse does the shooting everywhere: left fires, right looks closer; F is the special weapon.
  const zoom: KeyHint = { caps: [], mouse: 'right', word: 'ZOOM' };
  const cannon: KeyHint = { caps: [], mouse: 'left', word: 'CANNON' };
  const missile: KeyHint = { caps: [k('KeyF')], word: 'MISSILE' };
  const boost: KeyHint = { caps: ['SHIFT'], word: 'BOOST' };
  const fly: KeyHint = { caps: [k('KeyT')], word: '', gives: ['plane'] };
  let rows: KeyHint[];
  if (mode === 'board' || mode === 'foot') {
    rows = [
      { caps: wasd, word: 'MOVE' },
      { caps: [], mouse: 'move', word: mode === 'board' ? 'AIM' : 'LOOK' },
      { caps: [], mouse: 'left', word: 'FIRE' },
      zoom,
      { caps: ['SHIFT'], word: 'DASH' },
      { caps: [k('KeyF')], word: 'BOMB' },
    ];
  } else if (mode === 'plane') {
    rows = [
      { caps: [], mouse: 'move', word: 'FLY' },
      { caps: [k('KeyW'), k('KeyS')], word: 'SPEED' },
      { caps: [k('KeyA'), k('KeyD')], word: 'TURN' },
      cannon, zoom, missile,
      { caps: [k('KeyQ'), k('KeyE')], word: 'ROLL' },
      boost,
      { caps: [], word: 'LAND', gives: ['boat', 'tank'] },
    ];
  } else if (mode === 'boat') {
    rows = [
      { caps: [k('KeyW'), k('KeyS')], word: 'SPEED' },
      { caps: [k('KeyA'), k('KeyD')], word: 'TURN' },
      { caps: [], mouse: 'move', word: 'AIM' },
      cannon, zoom, missile,
      { caps: [k('KeyQ'), k('KeyE')], word: 'FLARES' },
      boost, fly,
      { caps: [], word: 'SHORE', gives: ['tank'] },
    ];
  } else {
    rows = [
      { caps: [k('KeyW'), k('KeyS')], word: 'DRIVE' },
      { caps: [k('KeyA'), k('KeyD')], word: 'TURN' },
      { caps: [], mouse: 'move', word: 'AIM' },
      cannon, zoom, missile, boost, fly,
      { caps: [], word: 'SEA', gives: ['boat'] },
    ];
  }
  return [...rows, ...META];
}
