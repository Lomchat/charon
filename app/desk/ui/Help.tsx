'use client';

const KEYS: Array<[string, string]> = [
  ['1 … 9', 'that island'],
  ['PageUp · PageDown', 'previous / next island'],
  ['M', 'the map'],
  ['Tab · Space', 'next robot that wants you'],
  ['drag · WASD · arrows', 'move'],
  ['wheel · + −', 'zoom'],
  ['F', 'frame the island'],
  ['click', 'select a robot'],
  ['double-click · Enter', 'open the session'],
  ['/', 'the order (or the card shown)'],
  ['Enter · Alt+Enter', 'send · aside'],
  ['Enter · Tab, order empty', 'open · next robot'],
  ['Q', 'quote the selected text'],
  ['Esc', 'leave the order, then deselect'],
  ['Y · N', 'allow / deny the permission shown'],
  ['R', 'mark as read'],
  ['X', 'stop the turn'],
  ['right-click · ⋯', 'rename, @handle, colour, hide, sleep, delete'],
  ['N · click a +', 'new agent'],
  ['G', 'the mini-game'],
];

const LEGEND: Array<[string, string, string]> = [
  ['work', 'at its console', 'working'],
  ['ask', '! or ?', 'waits on you'],
  ['done', '✓', 'finished, unread'],
  ['fail', '✖', 'failed'],
  ['idle', 'beside its console', 'idle'],
  ['bg', 'drones around it', 'background tasks'],
];

export default function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="dk-modal" role="dialog" aria-modal="true" aria-label="help">
      <div className="dk-veil" onClick={onClose} />
      <div className="dk-help">
        <h2>The desk</h2>
        <div className="dk-help-cols">
          <div>
            <h3>Reading a robot</h3>
            <ul className="dk-help-legend">
              {LEGEND.map(([tone, sign, meaning]) => (
                <li key={sign}><i data-tone={tone} aria-hidden="true" /><b>{sign}</b><span>{meaning}</span></li>
              ))}
            </ul>
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
