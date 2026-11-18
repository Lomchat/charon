// Models made of boxes: every 3D thing of the flight phase is a list of
// coloured boxes turned into one mesh — no model file to ship, as the board's
// sprites are rows of characters (art.ts).
import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial } from 'three';

/** A box: its low corner, its size, its colour. A colour that starts with `!`
 *  glows: it is drawn unlit, at full strength, whatever the light. */
export type Box = [x: number, y: number, z: number, w: number, h: number, d: number, colour: string];

export type Model = {
  lit: BufferGeometry | null;
  glow: BufferGeometry | null;
  /** The radius of the sphere around it (from its origin). */
  radius: number;
};

// One material each for everything box-made: the colours live in the vertices.
let litMaterial: MeshLambertMaterial | null = null;
let glowMaterial: MeshBasicMaterial | null = null;
export function materials(): { lit: MeshLambertMaterial; glow: MeshBasicMaterial } {
  litMaterial ??= new MeshLambertMaterial({ vertexColors: true });
  glowMaterial ??= new MeshBasicMaterial({ vertexColors: true, fog: false });
  return { lit: litMaterial, glow: glowMaterial };
}

// The six faces of a unit box: its normal, and its four corners (counter-clockwise from outside).
const FACES: Array<{ n: [number, number, number]; c: Array<[number, number, number]> }> = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];

const colour = new Color();

function geometryOf(boxes: Box[], scale: number): BufferGeometry | null {
  if (!boxes.length) return null;
  const position: number[] = [];
  const normal: number[] = [];
  const colours: number[] = [];
  for (const [x, y, z, w, h, d, c] of boxes) {
    colour.set(c.startsWith('!') ? c.slice(1) : c);
    for (const face of FACES) {
      // Two triangles per face.
      for (const i of [0, 1, 2, 0, 2, 3]) {
        const [cx, cy, cz] = face.c[i];
        position.push((x + cx * w) * scale, (y + cy * h) * scale, (z + cz * d) * scale);
        normal.push(face.n[0], face.n[1], face.n[2]);
        colours.push(colour.r, colour.g, colour.b);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(position, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  g.setAttribute('color', new Float32BufferAttribute(colours, 3));
  return g;
}

export function buildModel(boxes: Box[], scale = 1): Model {
  let far = 0;
  for (const [x, y, z, w, h, d] of boxes) {
    far = Math.max(far, Math.hypot(Math.max(Math.abs(x), Math.abs(x + w)), Math.max(Math.abs(y), Math.abs(y + h)), Math.max(Math.abs(z), Math.abs(z + d))));
  }
  return {
    lit: geometryOf(boxes.filter((b) => !b[6].startsWith('!')), scale),
    glow: geometryOf(boxes.filter((b) => b[6].startsWith('!')), scale),
    radius: far * scale,
  };
}

/** A model, standing in the scene. */
export function instance(model: Model): Group {
  const group = new Group();
  const { lit, glow } = materials();
  if (model.lit) group.add(new Mesh(model.lit, lit));
  if (model.glow) group.add(new Mesh(model.glow, glow));
  return group;
}

/**
 * A sprite given a depth: each row of palette keys becomes a row of boxes, the
 * front of the sprite facing +Z, its feet on y = 0, centred on x and z.
 * `depth` says how thick a pixel is (0 = not there); `glow` re-colours a pixel
 * with a light.
 */
export function extrude(
  rows: string[],
  pal: Record<string, string>,
  depth: (key: string, x: number, y: number) => number,
  glow?: (x: number, y: number) => string | null,
): Box[] {
  const boxes: Box[] = [];
  const width = Math.max(...rows.map((r) => r.length));
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const key = row[x];
      const lit = glow?.(x, y) ?? null;
      const c = lit ?? pal[key];
      const d = c ? depth(key, x, y) : 0;
      if (!c || d <= 0) { x += 1; continue; }
      // A run of the same pixel is one box.
      let end = x + 1;
      while (end < row.length && row[end] === key && (glow?.(end, y) ?? null) === lit && depth(key, end, y) === d) end += 1;
      boxes.push([x - width / 2, rows.length - 1 - y, -d / 2, end - x, 1, d, c]);
      x = end;
    }
  });
  return boxes;
}

/** Boxes moved and scaled, to assemble a model from parts. */
export function place(boxes: Box[], dx: number, dy: number, dz: number, scale = 1): Box[] {
  return boxes.map(([x, y, z, w, h, d, c]) => [x * scale + dx, y * scale + dy, z * scale + dz, w * scale, h * scale, d * scale, c]);
}

/** Boxes turned a quarter about the vertical: what faced −X now faces +Z (a side-view sprite, nose first). */
export function turn(boxes: Box[]): Box[] {
  return boxes.map(([x, y, z, w, h, d, c]) => [z, y, -x - w, d, h, w, c]);
}
