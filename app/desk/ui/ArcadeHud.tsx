'use client';
// The mini-game's overlay (game/arcade.ts): score, wave, health and weapon,
// what is announced, and the end of a run. It only reads what the board
// publishes (arcadeStore.ts); every key belongs to the board.
import { useArcade } from '../arcadeStore';

const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];

function Heart({ full }: { full: boolean }) {
  return (
    <svg className="dk-heart" viewBox="0 0 7 6" width={14} height={12} shapeRendering="crispEdges" data-full={full || undefined} aria-hidden="true">
      {HEART.flatMap((row, y) => [...row].map((ch, x) => (ch === '#' ? <rect key={`${x}.${y}`} x={x} y={y} width={1} height={1} /> : null)))}
    </svg>
  );
}

const KEYS = 'MOVE WASD / ZQSD   FIRE ARROWS or SPACE   DASH SHIFT   BOMB E   PAUSE P   LEAVE ESC';

export default function ArcadeHud() {
  const a = useArcade();
  if (!a.on) return null;
  const over = a.phase === 'over';
  return (
    <div className="dk-game" aria-live="polite">
      <div className="dk-game-top">
        <span className="dk-game-wave">WAVE {Math.max(1, a.wave)}</span>
        <b className="dk-game-score" data-record={a.record || undefined}>{a.score.toLocaleString('en-US')}</b>
        <span className="dk-game-mult" data-hot={a.mult > 1 || undefined}>×{a.mult}</span>
        {a.boss != null && (
          <span className="dk-game-boss" title="the boss"><span style={{ width: `${a.boss * 100}%` }} /></span>
        )}
      </div>

      {/* What was just announced; `key` restarts its animation each time. */}
      {a.banner && !over && <div key={a.bannerAt} className="dk-game-banner">{a.banner}</div>}
      {a.phase === 'intro' && <div className="dk-game-keys">{KEYS}</div>}
      {a.paused && !over && <div className="dk-game-banner dk-game-still">PAUSED<small>any key to go on</small></div>}

      {over && (
        <div className="dk-game-over" role="dialog" aria-label="game over">
          <strong>{a.record ? 'NEW RECORD' : 'GAME OVER'}</strong>
          <dl>
            <div><dt>SCORE</dt><dd>{a.score.toLocaleString('en-US')}</dd></div>
            <div><dt>BEST</dt><dd>{a.best.toLocaleString('en-US')}</dd></div>
            <div><dt>WAVE</dt><dd>{a.wave}</dd></div>
          </dl>
          <p>ENTER to go again · ESC back to work</p>
        </div>
      )}

      <div className="dk-game-foot">
        <span className="dk-game-hp" aria-label={`${a.hp} of ${a.maxHp} health`}>
          {Array.from({ length: a.maxHp }, (_, i) => <Heart key={i} full={i < a.hp} />)}
          {a.shield > 0 && <em title="shield">+{a.shield}</em>}
        </span>
        <span className="dk-game-gun">{a.weapon}<b>{a.ammo == null ? '∞' : a.ammo}</b></span>
        <span className="dk-game-bombs" title="bombs (E)">BOMB<b>{a.bombs}</b></span>
        <span className="dk-game-foes" title="robots left in this wave">ROBOTS<b>{a.foes}</b></span>
      </div>
    </div>
  );
}
