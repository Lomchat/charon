'use client';
// The island selector: one card per inhabited machine (its live miniature,
// its name, what its robots are up to), the map, and the empty machines
// behind a "+N". The board shows ONE island at a time; this is how you travel.
import { Fragment, useEffect, useRef, useState } from 'react';
import { MAP_THUMB, type Game, type Scene } from '../game/game';
import type { IslandInfo } from '../islands';

type Props = {
  islands: IslandInfo[];
  scene: Scene | null;
  game: Game | null;
  onScene: (scene: Scene) => void;
  onStep: (dir: -1 | 1) => void;
};

/** A miniature the board keeps painted (`Game.attachThumb`). */
function Thumb({ game, id }: { game: Game | null; id: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!game) return undefined;
    game.attachThumb(id, ref.current);
    return () => game.attachThumb(id, null);
  }, [game, id]);
  return <canvas ref={ref} className="dk-isle-thumb" aria-hidden="true" />;
}

function pips(island: IslandInfo): Array<{ tone: string; glyph: string; n: number; word: string }> {
  const t = island.tally;
  return [
    { tone: 'ask', glyph: '!', n: t.blocked + t.question, word: 'need you' },
    { tone: 'done', glyph: '✓', n: t.done, word: 'done' },
    { tone: 'fail', glyph: '✖', n: t.error, word: 'failed' },
    { tone: 'work', glyph: '▶', n: t.work + t.bg, word: 'working' },
  ].filter((p) => p.n > 0);
}

export default function IslandBar({ islands, scene, game, onScene, onStep }: Props) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const inhabited = islands.filter((i) => i.total > 0);
  const empty = islands.filter((i) => i.total === 0);
  const currentId = scene?.kind === 'island' ? scene.id : null;
  const onEmpty = currentId != null ? empty.find((i) => i.id === currentId) ?? null : null;
  const folders = new Set(inhabited.map((i) => i.folderId)).size;

  // The current card stays in sight, however many islands there are.
  useEffect(() => {
    strip.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentId, scene?.kind]);

  // The "+N" list closes on a click anywhere else, and on Escape.
  useEffect(() => {
    if (!more) return undefined;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as HTMLElement).closest?.('.dk-isle-more')) setMore(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [more]);

  return (
    <nav className="dk-isles" aria-label="islands">
      <button type="button" className="dk-isles-step" onClick={() => onStep(-1)} title="previous island (PageUp)" aria-label="previous island">‹</button>
      <div
        className="dk-isles-strip"
        ref={strip}
        onWheel={(e) => { if (strip.current && e.deltaY) strip.current.scrollLeft += e.deltaY; }}
      >
        <button
          type="button"
          className="dk-isle-card dk-isle-map"
          data-current={scene?.kind === 'map' || undefined}
          onClick={() => onScene({ kind: 'map' })}
          title="the whole archipelago (M)"
        >
          <Thumb game={game} id={MAP_THUMB} />
          <span className="dk-isle-text"><b>Map</b><span className="dk-isle-pips"><em>{inhabited.length} islands</em></span></span>
          <kbd>M</kbd>
        </button>

        {inhabited.map((island, i) => {
          const list = pips(island);
          const alert = island.tally.blocked + island.tally.question > 0;
          // A folder of the sidebar starts here: a wider gap, its name in the tooltip.
          const head = folders > 1 && i > 0 && inhabited[i - 1].folderId !== island.folderId;
          return (
            <Fragment key={island.id}>
              {head && <span className="dk-isles-gap" aria-hidden="true" />}
              <button
                type="button"
                className="dk-isle-card"
                data-current={currentId === island.id || undefined}
                data-top={island.top ?? undefined}
                data-alert={alert || undefined}
                data-offline={island.offline || undefined}
                onClick={() => onScene({ kind: 'island', id: island.id })}
                title={`${folders > 1 && island.folderName ? `${island.folderName} › ` : ''}${island.name} — ${island.total} agent${island.total === 1 ? '' : 's'}${island.offline ? ' · agent unreachable' : ''}${i < 9 ? ` (${i + 1})` : ''}`}
              >
                <Thumb game={game} id={island.id} />
                <span className="dk-isle-text">
                  <b>{island.name}</b>
                  <span className="dk-isle-pips">
                    {list.map((p) => (
                      <span key={p.tone} data-tone={p.tone} title={`${p.n} ${p.word}`}><i aria-hidden="true">{p.glyph}</i>{p.n}</span>
                    ))}
                    {list.length === 0 && <em>{island.tally.sleep === island.total ? 'asleep' : `${island.total} idle`}</em>}
                  </span>
                </span>
                {i < 9 && <kbd>{i + 1}</kbd>}
              </button>
            </Fragment>
          );
        })}

      </div>
      {empty.length > 0 && (
        <span className="dk-isle-more">
          <button
            type="button"
            className="dk-isle-card dk-isle-plus"
            data-current={onEmpty != null || undefined}
            aria-expanded={more}
            onClick={() => setMore((on) => !on)}
            title="machines without an agent"
          >
            <span className="dk-isle-text">
              <b>{onEmpty ? onEmpty.name : `+${empty.length}`}</b>
              <span className="dk-isle-pips"><em>{onEmpty ? 'no agent' : 'empty'}</em></span>
            </span>
          </button>
          {more && (
            <span className="dk-isle-list" role="menu">
              {empty.map((island) => (
                <button
                  key={island.id}
                  type="button"
                  role="menuitem"
                  data-current={currentId === island.id || undefined}
                  data-offline={island.offline || undefined}
                  onClick={() => { setMore(false); onScene({ kind: 'island', id: island.id }); }}
                >
                  <i aria-hidden="true" />{island.name}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      <button type="button" className="dk-isles-step" onClick={() => onStep(1)} title="next island (PageDown)" aria-label="next island">›</button>
    </nav>
  );
}
