'use client';

const KEYS: Array<[string, string]> = [
  ['1 … 9', 'go to that island'],
  ['PageUp · PageDown', 'previous / next island'],
  ['M', 'the map of every island, and back'],
  ['Tab · Space', 'jump to the next robot that wants you, on any island'],
  ['drag · WASD · arrows', 'move over the island'],
  ['wheel · + −', 'zoom'],
  ['F', 'frame the island again'],
  ['click', 'select a robot'],
  ['double-click · Enter', 'open its session'],
  ['select a robot', 'the caret is in its order: type, Enter sends (empty: opens it)'],
  ['Esc', 'leave the order — the keys below work again'],
  ['Y · N', 'allow / deny the selected robot’s request'],
  ['R', 'mark its finished turn as read'],
  ['X', 'stop its turn'],
  ['right-click', 'rename, sleep, delete'],
  ['G · PLAY', 'the mini-game: defend the island (its own keys are shown there)'],
  ['Esc again', 'deselect'],
];

const LEGEND: Array<[string, string, string]> = [
  ['work', 'at its console, screen lit', 'a turn is running — the screen shows what it is doing'],
  ['ask', '! or ? over its head', 'it waits on you: a permission, a question, a plan'],
  ['done', '✓ over its head', 'the turn finished and nobody has read it'],
  ['fail', '✖ and smoke', 'the turn failed'],
  ['idle', 'standing beside its console', 'connected, nothing to do'],
  ['bg', 'small drones around it', 'background tasks still running'],
];

export default function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="dk-modal" role="dialog" aria-modal="true" aria-label="help">
      <div className="dk-veil" onClick={onClose} />
      <div className="dk-help">
        <h2>The desk</h2>
        <p>
          Your fleet as a board. Every island is a machine, every wooden deck a working directory,
          every robot a session — clay for Claude, white for Codex, slate for Cursor. The board shows
          one island at a time: the cards at the top travel between them, and say what goes on where
          you are not. Nothing here is simulated: the board draws what Charon knows, as it happens.
        </p>
        <div className="dk-help-cols">
          <div>
            <h3>Reading a robot</h3>
            <ul className="dk-help-legend">
              {LEGEND.map(([tone, sign, meaning]) => (
                <li key={sign}><i data-tone={tone} aria-hidden="true" /><b>{sign}</b><span>{meaning}</span></li>
              ))}
            </ul>
            <p className="dk-help-fine">
              The number before a name is its level: the size of its context, one level per 100k tokens
              (hover the level under a selected robot for its numbers).
              The island’s beacon takes the colour of what its machine most needs.
            </p>
          </div>
          <div>
            <h3>Keys</h3>
            <dl className="dk-help-keys">
              {KEYS.map(([key, what]) => (
                <div key={key}><dt>{key}</dt><dd>{what}</dd></div>
              ))}
            </dl>
          </div>
        </div>
        <button type="button" className="dk-btn dk-btn-yes" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
