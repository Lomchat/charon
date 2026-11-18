'use client';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps } from '@/lib/types/api';
import { agentName, ago, folderOf } from '../game/model';
import { gateLine, type Quest } from '../quests';

type Props = {
  quests: Quest[];
  sessions: Map<string, SessionSummary>;
  vps: Map<string, Vps>;
  selectedId: string | null;
  busy: ReadonlySet<string>;
  open: boolean;
  onToggle: () => void;
  onVisit: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onPermission: (quest: Quest, allow: boolean) => void;
  onRead: (sessionId: string) => void;
};

const GLYPH: Record<Quest['kind'], string> = { permission: '!', plan: '!', question: '?', ask: '?', error: '✖', done: '✓' };
const TONE: Record<Quest['kind'], string> = { permission: 'ask', plan: 'ask', question: 'ask', ask: 'ask', error: 'fail', done: 'done' };

function headline(quest: Quest): string {
  const title = quest.gate?.title ?? '';
  switch (quest.kind) {
    case 'permission': return `wants to use ${title || 'a tool'}`;
    case 'plan': return 'has a plan to review';
    case 'question':
    case 'ask': return title || 'asks a question';
    case 'error': return 'the turn failed';
    default: return 'finished its turn';
  }
}

export default function QuestLog({
  quests, sessions, vps, selectedId, busy, open, onToggle, onVisit, onOpen, onPermission, onRead,
}: Props) {
  // Ages and deadlines tick on their own, without the fleet re-rendering.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <aside className="dk-quests" data-open={open || undefined} aria-label="quests">
      <button type="button" className="dk-quests-head" onClick={onToggle} aria-expanded={open}>
        <span className="dk-quests-title">QUESTS</span>
        <b data-zero={quests.length === 0 || undefined}>{quests.length}</b>
        <span className="dk-spacer" />
        <i aria-hidden="true">{open ? '▾' : '▸'}</i>
      </button>
      {open && (
        <div className="dk-quests-list">
          {quests.length === 0 && (
            <p className="dk-quests-empty">All clear.</p>
          )}
          {quests.map((quest) => {
            const session = sessions.get(quest.sessionId);
            if (!session) return null;
            const machine = vps.get(session.vpsId)?.name ?? '';
            const gate = quest.gate;
            // Gate clocks are epoch seconds.
            const left = gate?.expiresAt ? Math.max(0, gate.expiresAt * 1000 - now) : null;
            const total = gate?.expiresAt && gate.createdAt ? Math.max(1, (gate.expiresAt - gate.createdAt) * 1000) : null;
            const line = gate && quest.kind === 'permission' ? gateLine(gate) : '';
            const waiting = busy.has(quest.key);
            const recap = quest.kind === 'done' ? session.recap?.text : null;
            return (
              <article
                key={quest.key}
                className="dk-quest"
                data-tone={TONE[quest.kind]}
                data-selected={selectedId === quest.sessionId || undefined}
                onClick={() => onVisit(quest.sessionId)}
              >
                <header>
                  <i className="dk-quest-glyph" aria-hidden="true">{GLYPH[quest.kind]}</i>
                  <b>{agentName(session)}</b>
                  {quest.since ? <time>{ago(now - quest.since)}</time> : null}
                </header>
                <p className="dk-quest-where">{machine} · {folderOf(session.cwd)}</p>
                <p className="dk-quest-what">{headline(quest)}</p>
                {line ? <pre className="dk-quest-preview">{line}</pre> : null}
                {gate?.reason ? <p className="dk-quest-note">{gate.reason}</p> : null}
                {recap ? <p className="dk-quest-note">{recap}</p> : null}
                {left != null && total != null && (
                  <span className="dk-quest-fuse" title={`expires in ${Math.ceil(left / 1000)}s`}>
                    <span style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
                  </span>
                )}
                <footer onClick={(e) => e.stopPropagation()}>
                  {quest.kind === 'permission' && (
                    <>
                      <button type="button" className="dk-btn dk-btn-yes" disabled={waiting} onClick={() => onPermission(quest, true)}>
                        Allow
                      </button>
                      <button type="button" className="dk-btn dk-btn-no" disabled={waiting} onClick={() => onPermission(quest, false)}>
                        Deny
                      </button>
                    </>
                  )}
                  {(quest.kind === 'done' || quest.kind === 'error') && (
                    <button type="button" className="dk-btn dk-btn-yes" disabled={waiting} onClick={() => onRead(quest.sessionId)}>
                      Got it
                    </button>
                  )}
                  <button type="button" className="dk-btn" onClick={() => onOpen(quest.sessionId)}>
                    {quest.kind === 'permission' || quest.kind === 'done' || quest.kind === 'error' ? 'Open' : 'Answer'}
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
}
