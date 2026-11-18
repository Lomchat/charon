'use client';
// The prompt cache as a HUD glyph: the board's fire, as tall as the cache has
// life left, in the board's colours (game/model.ts § HEAT). A cold cache has
// no glyph: cold is the absence of fire.
import type { CacheReading } from '@/lib/promptCache';
import { HEAT } from '../game/model';

const FLAME = [
  '...o...',
  '..oo...',
  '..ooo..',
  '.ooioo.',
  '.oiiio.',
  'ooiiioo',
  'oiiiiio',
  '.ooooo.',
];

function Pixels({ rows, ember, core, size }: { rows: string[]; ember: string; core: string; size: number }) {
  const w = rows[0].length;
  return (
    <svg
      className="dk-heat-icon"
      viewBox={`0 0 ${w} ${rows.length}`}
      width={w * size}
      height={rows.length * size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rows.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? null : (
        <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} fill={ch === 'i' ? core : ember} />
      ))))}
    </svg>
  );
}

/** A full flame, whatever the reading (the counter's emblem). */
export function FlameMark({ size = 2 }: { size?: number }) {
  return <Pixels rows={FLAME} ember={HEAT[4].ember} core={HEAT[4].core} size={size} />;
}

/** The flame of a warm cache, cut from the foot up to what is left of it. */
export default function HeatIcon({ reading, size = 2 }: { reading: CacheReading; size?: number }) {
  if (reading.phase !== 'warm' && reading.phase !== 'live') return null;
  const heat = HEAT[reading.level];
  const keep = Math.max(2, Math.round(2 + 6 * reading.frac));
  return <Pixels rows={FLAME.slice(FLAME.length - keep)} ember={heat.ember} core={heat.core} size={size} />;
}
