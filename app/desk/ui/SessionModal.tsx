'use client';

// The robot, opened: its session as it is in Charon.
//
// Deliberately thin. It mounts `<SessionView>` — the component Charon uses for
// its own session area — so a fix to the transcript, the composer or a
// permission card shows up here without anyone touching the desk.
import { useEffect } from 'react';
import SessionView from '@/app/SessionView';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps } from '@/lib/types/api';
import { MOOD_COLOR, MOOD_WORD, agentName, moodOf } from '../game/model';
import Portrait from './Portrait';

type Sibling = { id: string; name: string | null; handle: string; confirmed?: boolean; status: string };

type Props = {
  session: SessionSummary;
  vps: Vps | null;
  siblings: Sibling[];
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onSessionsChanged: () => void;
};

export default function SessionModal({ session, vps, siblings, onClose, onOpenSession, onSessionsChanged }: Props) {
  const mood = moodOf(session);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const field = event.target as HTMLElement | null;
      const tag = field?.tagName;
      // Escape in a field means "cancel what I type", not "close" — but an
      // empty composer has nothing to cancel, and it holds the focus.
      if (tag === 'INPUT') return;
      if (tag === 'TEXTAREA' && (field as HTMLTextAreaElement).value.trim()) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dk-modal" role="dialog" aria-modal="true" aria-label={`session ${agentName(session)}`}>
      <div className="dk-veil" onClick={onClose} />
      <div className="dk-frame">
        <header className="dk-frame-head">
          <Portrait kind={session.kind} mood={mood} chest={session.color} scale={1.5} />
          <b>{agentName(session)}</b>
          <span>{vps ? vps.name : 'unknown machine'}</span>
          <span className="dk-frame-cwd">{session.cwd}</span>
          <em style={{ color: MOOD_COLOR[mood] }}>{MOOD_WORD[mood]}</em>
          <span className="dk-spacer" />
          <a href={`/?session=${encodeURIComponent(session.id)}`} target="_blank" rel="noreferrer">Open in Charon</a>
          <button type="button" onClick={onClose} aria-label="close">Close<kbd>Esc</kbd></button>
        </header>
        <div className="dk-embed app-root">
          {/* `key`: another session (an @handle link) remounts the view — the
              transcript state never crosses from one session to the next. */}
          <SessionView
            key={session.id}
            sessionId={session.id}
            selected={session}
            showTools
            showToolsReady
            handle={session.handle ?? null}
            siblings={siblings}
            selectedVps={vps}
            usageAccountLabel={null}
            onKilled={() => { onClose(); onSessionsChanged(); }}
            onAfterRevert={onSessionsChanged}
            onOpenSession={(id) => onOpenSession(id)}
            onImportError={() => onSessionsChanged()}
          />
        </div>
      </div>
    </div>
  );
}
