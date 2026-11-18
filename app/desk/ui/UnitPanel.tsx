'use client';
import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { cacheTipLines, fmtTokens, sessionCacheReading } from '@/lib/promptCache';
import { toolFamily } from '@/lib/sessionActivity';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps } from '@/lib/types/api';
import { useActivity } from '../activityStore';
import { FAMILY_COLOR } from '../game/game';
import { HEAT, LEVEL_TOKENS, MOOD_COLOR, MOOD_WORD, agentName, clock, levelOf, moodOf } from '../game/model';
import { gateLine, type Quest } from '../quests';
import AccountSwitch from './AccountSwitch';
import HeatIcon from './HeatIcon';
import Portrait from './Portrait';
import UnitOrder from './UnitOrder';
import UnitTalk from './UnitTalk';

type Props = {
  session: SessionSummary;
  vps: Vps | null;
  /** Its first permission request, if one waits. */
  permission: Quest | null;
  /** Its team (sub-sessions): the session it works for, the ones that work
   *  for it, and the colour of their rug on the board. */
  lead: SessionSummary | null;
  crew: SessionSummary[];
  teamTint: string | null;
  /** Go to another robot (its island comes on stage). */
  onVisit: (id: string) => void;
  busy: boolean;
  orderRef: RefObject<HTMLTextAreaElement | null>;
  /** Put the caret in the order as soon as this robot is selected. */
  autoFocus: boolean;
  onOpen: () => void;
  /** Tab in an EMPTY order: on to the next robot that wants you. */
  onNext: (back: boolean) => void;
  onOrder: (text: string) => Promise<void>;
  onStop: () => void;
  onSleep?: () => void;
  onResume?: () => void;
  onRead?: () => void;
  onPermission: (quest: Quest, allow: boolean) => void;
  onMore: (x: number, y: number) => void;
  onClose: () => void;
};

const FAMILY_VERB: Record<string, string> = {
  shell: 'running', edit: 'editing', read: 'reading', search: 'searching', web: 'on the web',
  agent: 'delegating', plan: 'planning', peer: 'messaging', other: 'using',
};

export default function UnitPanel({
  session, vps, permission, lead, crew, teamTint, busy, orderRef, autoFocus, onOpen, onNext, onOrder, onStop, onSleep,
  onResume, onRead, onPermission, onVisit, onMore, onClose,
}: Props) {
  const activity = useActivity(session.id);
  const mood = moodOf(session);
  const lv = levelOf(session);
  const working = mood === 'work' || mood === 'bg' || (mood === 'blocked' && activity != null);
  const [now, setNow] = useState(() => Date.now());
  // A low screen (a laptop): a smaller portrait, the height goes to the
  // conversation. Read at each tick of the clock below — no listener needed.
  const low = typeof window !== 'undefined' && window.innerHeight < 820;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const name = agentName(session);
  const turn = working && activity?.turnStartedAt ? clock(now - activity.turnStartedAt) : null;
  // Its prompt cache, by Charon's own rule and in Charon's own words.
  const cache = sessionCacheReading(session, now);
  const cacheWarm = cache != null && (cache.phase === 'warm' || cache.phase === 'live');

  let doing: { tint: string; verb: string; detail: string } | null = null;
  if (mood === 'work' || mood === 'bg') {
    if (activity?.beat === 'tool') {
      const family = toolFamily(activity.tool);
      doing = { tint: FAMILY_COLOR[family], verb: `${FAMILY_VERB[family]}${family === 'other' ? ` ${activity.tool}` : ''}`, detail: activity.detail ?? '' };
    } else if (activity?.beat === 'think') doing = { tint: FAMILY_COLOR.think, verb: 'thinking', detail: activity.detail ?? '' };
    else if (activity?.beat === 'say') doing = { tint: FAMILY_COLOR.say, verb: 'writing', detail: activity.detail ?? '' };
    else if (activity?.beat === 'compact') doing = { tint: FAMILY_COLOR.plan, verb: 'compacting its memory', detail: '' };
    else if (mood === 'bg') {
      const n = session.runningBgTasks ?? 0;
      doing = { tint: MOOD_COLOR.bg, verb: n ? `${n} background task${n > 1 ? 's' : ''} running` : 'background work running', detail: '' };
    }
    else doing = { tint: MOOD_COLOR.work, verb: 'working', detail: '' };
  }

  return (
    <aside className="dk-unit" data-mood={mood} data-low={low || undefined} aria-label={`agent ${name}`}>
      <header className="dk-unit-head">
        <div className="dk-unit-face">
          <Portrait kind={session.kind} mood={mood} chest={session.color} scale={low ? 3 : 4} />
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
        <button type="button" className="dk-unit-close" onClick={onClose} aria-label="deselect" title="deselect (Esc)">×</button>
      </header>

      {/* What it is and where it runs: stays put above the conversation. */}
      <div className="dk-unit-info">
        <div className="dk-unit-where">
          {/* Its account — and the way to move it to another one. */}
          <AccountSwitch session={session} />
          {session.model ? <span>{session.model}</span> : null}
          <span>{vps?.name ?? 'unknown machine'}</span>
          <span className="dk-unit-cwd" title={session.cwd}>{session.cwd}</span>
        </div>
        {/* Its team: up to the one it works for, down to the ones that work for it. */}
        {(lead || crew.length > 0) && (
          <div className="dk-unit-team" style={teamTint ? { '--dk-team': teamTint } as CSSProperties : undefined}>
            {lead && (
              <>
                <span aria-hidden="true" title="works for">▲</span>
                <Mate session={lead} onVisit={onVisit} />
              </>
            )}
            {crew.length > 0 && <span aria-hidden="true" title="its sub-sessions">▼</span>}
            {crew.map((mate) => <Mate key={mate.id} session={mate} onVisit={onVisit} />)}
          </div>
        )}
        {cache && (
          <p
            className="dk-unit-cache"
            data-cold={!cacheWarm || undefined}
            style={cacheWarm ? { color: HEAT[cache.level].core } : undefined}
            title={cacheTipLines(cache).join(' · ')}
          >
            <HeatIcon reading={cache} />
            <b>{cacheTipLines(cache)[0].replace(/^Prompt cache /, 'cache ')}</b>
            <span>{fmtTokens(cache.promptTokens)} tokens of context</span>
          </p>
        )}
        {session.goal?.objective && (
          <p className="dk-unit-goal" title={`goal: ${session.goal.objective}`}><i aria-hidden="true">◎</i>{session.goal.objective}</p>
        )}
      </div>

      {/* Its conversation — the messages, no tools; this part scrolls, the
          last message at the foot. `key`: one transcript per robot. */}
      <UnitTalk key={session.id} session={session} />

      {/* What it is doing right now, and what it waits for. */}
      {(doing || permission?.gate || mood === 'blocked' || mood === 'question') && (
        <div className="dk-unit-now">
          {doing && (
            <p className="dk-unit-doing" style={{ color: doing.tint }}>
              <b>{doing.verb}</b>
              {doing.detail ? <code>{doing.detail}</code> : null}
            </p>
          )}
          {permission?.gate && (
            <div className="dk-unit-gate">
              <p><b>Allow {permission.gate.title}?</b>{permission.gate.reason ? ` ${permission.gate.reason}` : ''}</p>
              {gateLine(permission.gate) ? <pre>{gateLine(permission.gate)}</pre> : null}
            </div>
          )}
          {!permission && mood === 'blocked' && <p className="dk-unit-note">Waiting for your answer.</p>}
          {mood === 'question' && <p className="dk-unit-note">{session.gates?.[0]?.title ?? 'A question for you.'}</p>}
        </div>
      )}

      <div className="dk-unit-cmds">
          {permission && (
            <>
              <button type="button" className="dk-cmd dk-cmd-yes" disabled={busy} onClick={() => onPermission(permission, true)}>
                Allow<kbd>Y</kbd>
              </button>
              <button type="button" className="dk-cmd dk-cmd-no" disabled={busy} onClick={() => onPermission(permission, false)}>
                Deny<kbd>N</kbd>
              </button>
            </>
          )}
          <button type="button" className="dk-cmd dk-cmd-main" onClick={onOpen}>Open<kbd>⏎</kbd></button>
          {onRead && <button type="button" className="dk-cmd dk-cmd-yes" disabled={busy} onClick={onRead}>Got it<kbd>R</kbd></button>}
          {(mood === 'work' || (mood === 'blocked' && session.liveStatus === 'thinking')) && (
            <button type="button" className="dk-cmd dk-cmd-no" onClick={onStop}>Stop<kbd>X</kbd></button>
          )}
          {onSleep && <button type="button" className="dk-cmd" onClick={onSleep}>Sleep</button>}
          {onResume && <button type="button" className="dk-cmd" onClick={onResume}>Wake</button>}
          <button
            type="button"
            className="dk-cmd"
            aria-label="more actions"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onMore(r.left, r.top); }}
          >
            ⋯
          </button>
      </div>

      {/* Its order — `key`: one draft, one set of uploads per robot. */}
      <UnitOrder
        key={session.id}
        sessionId={session.id}
        name={name}
        orderRef={orderRef}
        autoFocus={autoFocus}
        onOpen={onOpen}
        onNext={onNext}
        onOrder={onOrder}
      />
    </aside>
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
