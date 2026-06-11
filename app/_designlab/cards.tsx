'use client';
import { STATUS_DOT, STATUS_LABEL, cwdTail, type MockSession, type MockShell } from './mock';
import { IconRobot, IconTerminal } from '../icons';

// Shared v2-style preview cards. The three explorations now agree on the
// card itself (preview + status + path); they only differ in toolbar /
// per-VPS header chrome. Styles live in lab.css as `.dl-card*`.

export function SessionCard({ s }: { s: MockSession }) {
  const sleeping = s.status === 'sleeping';
  return (
    <button
      className={`dl-card${sleeping ? ' sleeping' : ''}${s.status === 'waiting' ? ' attention' : ''}`}
      style={s.color ? { ['--c' as any]: s.color } : undefined}
    >
      <span className="dl-card-stripe" />
      <div className="dl-card-top">
        <span className="dl-card-glyph"><IconRobot /></span>
        <span className="dl-card-name">{s.name}</span>
        <span className={`dl-status ${s.status}`}>
          <span className={`dot ${STATUS_DOT[s.status]}`} />
          {STATUS_LABEL[s.status]}
        </span>
      </div>
      <div className="dl-card-preview">{s.preview}</div>
      <div className="dl-card-foot">
        <span className="dl-card-cwd">{cwdTail(s.cwd, 30)}</span>
        <span className="dl-card-age">{s.age}</span>
      </div>
    </button>
  );
}

export function ShellCard({ s }: { s: MockShell }) {
  return (
    <button
      className={`dl-card shell${s.exited ? ' sleeping' : ''}`}
      style={s.color ? { ['--c' as any]: s.color } : undefined}
    >
      <span className="dl-card-stripe" />
      <div className="dl-card-top">
        <span className="dl-card-glyph shell"><IconTerminal /></span>
        <span className="dl-card-name">{s.name ?? `shell · ${cwdTail(s.cwd, 16)}`}</span>
        <span className={`dl-status ${s.exited ? 'sleeping' : s.busy ? 'thinking' : 'active'}`}>
          <span className={`dot ${s.exited ? 'dot-gray' : s.busy ? 'dot-amber-pulse' : 'dot-green'}`} />
          {s.exited ? 'ended' : s.busy ? 'busy' : 'idle'}
        </span>
      </div>
      <div className="dl-card-foot">
        <span className="dl-card-cwd">{cwdTail(s.cwd, 30)}</span>
        <span className="dl-card-age">{s.age}</span>
      </div>
    </button>
  );
}
