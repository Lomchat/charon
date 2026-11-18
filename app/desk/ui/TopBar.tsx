'use client';
import { MOOD_WORD, type Mood } from '../game/model';
import { FlameMark } from './HeatIcon';

export type Tally = Record<Mood, number>;

type Props = {
  tally: Tally;
  total: number;
  /** Sessions whose prompt cache is still warm. */
  warm: number;
  /** The mini-game: its best score, whether a run is on. */
  best: number;
  playing: boolean;
  zoom: number;
  live: boolean;
  sound: boolean;
  showSleeping: boolean;
  onCycle: (mood: Mood) => void;
  onWarm: () => void;
  onPlay: () => void;
  onZoom: (delta: number) => void;
  onFit: () => void;
  onSound: () => void;
  onSleeping: () => void;
  onHelp: () => void;
  /** Charon's hidden-sessions switch (§14.118), the hub sidebar's eye: on = only hidden. */
  hiddenShown?: boolean;
  onHidden?: () => void;
};

/** The moods the bar counts, loudest first; `question` rides with `blocked`. */
const CHIPS: Array<{ mood: Mood; glyph: string; word: string }> = [
  { mood: 'blocked', glyph: '!', word: 'need you' },
  { mood: 'done', glyph: '✓', word: 'done' },
  { mood: 'error', glyph: '✖', word: 'failed' },
  { mood: 'work', glyph: '▶', word: 'working' },
  { mood: 'idle', glyph: '●', word: 'idle' },
  { mood: 'sleep', glyph: 'z', word: 'asleep' },
];

export default function TopBar({
  tally, total, warm, best, playing, zoom, live, sound, showSleeping,
  onCycle, onWarm, onPlay, onZoom, onFit, onSound, onSleeping, onHelp, hiddenShown, onHidden,
}: Props) {
  const count = (mood: Mood) => (mood === 'blocked' ? tally.blocked + tally.question
    : mood === 'work' ? tally.work + tally.bg : tally[mood]);
  return (
    <header className="dk-top">
      <a className="dk-brand" href="/" title="back to Charon">
        <span className="dk-brand-mark" aria-hidden="true" />
        <span>CHARON</span>
        <em>desk</em>
      </a>

      <div className="dk-chips" role="group" aria-label="fleet">
        {CHIPS.map(({ mood, glyph, word }) => {
          const n = count(mood);
          return (
            <button
              key={mood}
              type="button"
              className="dk-chip"
              data-mood={mood}
              data-zero={n === 0 || undefined}
              disabled={n === 0}
              onClick={() => onCycle(mood)}
              title={n ? `${n} ${word} — click to visit the next one` : `nobody is ${MOOD_WORD[mood]}`}
            >
              <i aria-hidden="true">{glyph}</i>
              <b>{n}</b>
              <span>{word}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="dk-chip dk-chip-warm"
          data-zero={warm === 0 || undefined}
          disabled={warm === 0}
          onClick={onWarm}
          title={warm ? `${warm} warm prompt cache${warm === 1 ? '' : 's'} — click to visit the one that goes cold first` : 'no warm prompt cache'}
        >
          <FlameMark size={1.5} />
          <b>{warm}</b>
          <span>warm</span>
        </button>
      </div>

      <span className="dk-spacer" />

      {/* The mini-game: its button, and the best score, always there. */}
      <div className="dk-arcade">
        <button type="button" className="dk-play" onClick={onPlay} data-on={playing || undefined} aria-label={playing ? 'stop the game' : 'play'}>
          {playing ? '■ STOP' : '▶ PLAY'}
        </button>
        <span className="dk-best">BEST<b>{best.toLocaleString('en-US')}</b></span>
      </div>

      <div className="dk-tools">
        <span className="dk-live" data-live={live || undefined} title={live ? `live — ${total} agents` : 'reconnecting…'} />
        <button type="button" onClick={() => onZoom(-1)} title="zoom out (−)" aria-label="zoom out">−</button>
        <span className="dk-zoom" title="zoom">{Number(zoom.toFixed(2))}×</span>
        <button type="button" onClick={() => onZoom(1)} title="zoom in (+)" aria-label="zoom in">+</button>
        <button type="button" onClick={onFit} title="frame the island again (F)" aria-label="frame the island again">⌖</button>
        <button type="button" data-on={showSleeping || undefined} onClick={onSleeping} title="show sleeping agents">z</button>
        {onHidden && (
          <button type="button" className="dk-eye" data-on={hiddenShown || undefined} aria-pressed={!!hiddenShown} onClick={onHidden} title="only hidden sessions" aria-label="only hidden sessions">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" />
              <circle cx="8" cy="8" r="2" />
              {!hiddenShown && <path d="M2.5 13.5l11-11" />}
            </svg>
          </button>
        )}
        <button type="button" data-on={sound || undefined} onClick={onSound} title={sound ? 'sound on' : 'sound off'} aria-label="sound">♪</button>
        <button type="button" onClick={onHelp} title="help (?)" aria-label="help">?</button>
      </div>
    </header>
  );
}
