'use client';
// The drawer's head: who the robot is, where it runs, its team, and the
// commands that act on it. Every action goes through the drawer host.
import { useEffect, useState, type CSSProperties } from 'react';
import { canResumeSession, canSleepSession } from '@/app/sessionBulkActions';
import { fmtTokens } from '@/lib/promptCache';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps } from '@/lib/types/api';
import { useActivity } from '../activityStore';
import { LEVEL_TOKENS, MOOD_WORD, agentName, clock, levelOf, moodOf, ownColour } from '../game/model';
import AccountSwitch from './AccountSwitch';
import { useDrawerHost } from './drawerHost';
import Portrait from './Portrait';

type Props = {
  session: SessionSummary;
  vps: Vps | null;
  /** Its team (sub-sessions): the session it works for, the ones that work
   *  for it, and the colour of their rug on the board. */
  lead: SessionSummary | null;
  crew: SessionSummary[];
  teamTint: string | null;
  /** "Got it" applies (finished or failed, unread). */
  canRead: boolean;
  /** The read receipt is on its way. */
  reading: boolean;
  /** A low screen: a smaller portrait. */
  low: boolean;
};

export default function UnitHead({ session, vps, lead, crew, teamTint, canRead, reading, low }: Props) {
  const host = useDrawerHost();
  const id = session.id;
  const activity = useActivity(id);
  const mood = moodOf(session);
  const lv = levelOf(session);
  const working = mood === 'work' || mood === 'bg' || (mood === 'blocked' && activity != null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const name = agentName(session);
  const turn = working && activity?.turnStartedAt ? clock(now - activity.turnStartedAt) : null;
  const stoppable = mood === 'work' || (mood === 'blocked' && session.liveStatus === 'thinking');

  return (
    <>
      <header className="dk-unit-head">
        <div className="dk-unit-face">
          <Portrait kind={session.kind} mood={mood} chest={ownColour(session)} scale={low ? 2 : 3} />
          {/* The level is the context: one per 100k tokens. Its tip gives the
              number, nothing more. */}
          <div className="dk-unit-level" tabIndex={0} aria-describedby="dk-level-tip">
            <b>LV {lv ? lv.level : '–'}</b>
            <span><span style={{ width: `${lv ? (lv.into / LEVEL_TOKENS) * 100 : 0}%` }} /></span>
            <div className="dk-tip" id="dk-level-tip" role="tooltip">
              {lv ? <><b>{fmtTokens(lv.tokens)}</b> context · LV {lv.level + 1} at {fmtTokens((lv.level + 1) * LEVEL_TOKENS)}</> : 'no context yet'}
            </div>
          </div>
        </div>
        <div className="dk-unit-title">
          <h2 title={name}>{name}</h2>
          <span className="dk-unit-state">
            <i aria-hidden="true" />
            {MOOD_WORD[mood]}
            {turn ? <b>{turn}</b> : null}
            {working && activity?.turnTools ? <em title="tool calls this turn">×{activity.turnTools}</em> : null}
          </span>
          {session.handle ? <span className="dk-unit-handle">@{session.handle}</span> : null}
        </div>
        <button type="button" className="dk-unit-close" onClick={host.deselect} aria-label="deselect" title="deselect (Esc)">×</button>
      </header>

      {/* What it is and where it runs: stays put above the conversation. */}
      <div className="dk-unit-info">
        <div className="dk-unit-where">
          {/* Its account — and the way to move it to another one. */}
          <AccountSwitch session={session} />
          <span>{vps?.name ?? 'unknown machine'}</span>
          <span className="dk-unit-cwd" title={session.cwd}>{session.cwd}</span>
        </div>
        {/* Its team: up to the one it works for, down to the ones that work for it. */}
        {(lead || crew.length > 0) && (
          <div className="dk-unit-team" style={teamTint ? { '--dk-team': teamTint } as CSSProperties : undefined}>
            {lead && (
              <>
                <span aria-hidden="true" title="works for">▲</span>
                <Mate session={lead} onVisit={host.goTo} />
              </>
            )}
            {crew.length > 0 && <span aria-hidden="true" title="its sub-sessions">▼</span>}
            {crew.map((mate) => <Mate key={mate.id} session={mate} onVisit={host.goTo} />)}
          </div>
        )}
      </div>
      {/* The commands: the desk's words, one row, last. */}
      <div className="dk-unit-cmdrow">
        <button type="button" className="dk-cmd dk-cmd-main" onClick={() => host.openFull(id)}>Open<kbd>⏎</kbd></button>
        {canRead && (
          <button type="button" className="dk-cmd dk-cmd-yes" disabled={reading} onClick={() => host.read(id)}>Got it<kbd>R</kbd></button>
        )}
        {stoppable && (
          <button type="button" className="dk-cmd dk-cmd-no" onClick={() => host.lifecycle('stop', id)}>Stop<kbd>X</kbd></button>
        )}
        {canSleepSession(session) && <button type="button" className="dk-cmd" onClick={() => host.lifecycle('sleep', id)}>Sleep</button>}
        {canResumeSession(session) && <button type="button" className="dk-cmd" onClick={() => host.lifecycle('resume', id)}>Wake</button>}
        <button
          type="button"
          className="dk-cmd"
          aria-label="more actions"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); host.openMenu(id, r.left, r.top); }}
        >
          ⋯
        </button>
      </div>
    </>
  );
}

/** A robot of the same team: its state, its name — a click goes to it. */
function Mate({ session, onVisit }: { session: SessionSummary; onVisit: (id: string) => void }) {
  const name = agentName(session);
  return (
    <button type="button" className="dk-mate" data-mood={moodOf(session)} onClick={() => onVisit(session.id)} title={name}>
      <i aria-hidden="true" /><span>{name}</span>
    </button>
  );
}
