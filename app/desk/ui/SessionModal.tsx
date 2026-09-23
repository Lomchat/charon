'use client';

// Le robot ouvert : sa session, telle quelle.
//
// Ce fichier est volontairement mince. Il ne reconstruit pas un transcript, il
// ne réimplémente pas un composer, il ne redessine pas un explorateur : il
// monte `<ClaudeSessionView>`, le composant que Charon utilise pour sa propre
// zone de session, et `<ToolPanel>` avec lui. Une correction apportée à la
// zone de session de Charon — un nouveau bouton, une permission, un mode —
// apparaît ici sans que personne ne touche au desk. C'est tout l'intérêt de
// la dépendance à sens unique : le desk regarde Charon, Charon ignore le desk.

import { useEffect } from 'react';
import ClaudeSessionView from '@/app/ClaudeSessionView';
import type { Vps } from '@/lib/types/api';
import type { DeskAction, DeskSession } from '../hall/palette';
import { actionWord, beaconOf, robotName, stateOf, statusWord } from '../hall/palette';

type Sibling = { id: string; name: string | null; handle: string; confirmed?: boolean; status: string };

type Props = {
  session: DeskSession;
  vps: Vps | null;
  siblings: Sibling[];
  action: DeskAction | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onSessionsChanged: () => void;
};

export default function SessionModal({
  session, vps, siblings, action, onClose, onOpenSession, onSessionsChanged
}: Props) {
  // La session ouverte est, par définition, une session qu'on regarde : elle
  // n'a donc jamais la pastille verte. C'est la règle de Charon, appliquée.
  const state = stateOf(session, { selected: true });
  const beacon = beaconOf(session, { selected: true });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const field = event.target as HTMLElement | null;
      const tag = field?.tagName;
      // Échap dans un champ, c'est « annuler ce que je tape », pas « fermer ».
      // Mais un champ vide n'a rien à annuler : sans ça, Échap ne fermerait
      // jamais le modal, puisque le composer d'une session ouverte a le focus.
      if (tag === 'INPUT') return;
      if (tag === 'TEXTAREA' && (field as HTMLTextAreaElement).value.trim()) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dsk-modal" role="dialog" aria-modal="true" aria-label={`session ${session.id}`}>
      <div className="dsk-veil" onClick={onClose} />

      <div className="dsk-frame">
        <header className="dsk-frame-head">
          {/* Le nom du robot, le même que sur son étiquette dans la salle : on
              suit le robot du regard jusqu'ici sans se demander si c'est lui. */}
          <span className="who">{robotName(session)}</span>
          {/* Le titre est le handle quand il y en a un ; on n'ajoute donc le nom
              que s'il dit autre chose — sinon l'en-tête affichait deux fois le
              même mot. */}
          {session.name && `@${session.handle ?? ''}` !== session.name && (
            <span className="where">{session.name}</span>
          )}
          <span className="where">{vps ? vps.name : 'unknown machine'}</span>
          <span className="where">{session.cwd || vps?.defaultPath || ''}</span>

          <span className="state" style={{ color: beacon.css }}>
            <i
              style={state.speed ? { animationDuration: `${(1 / state.speed).toFixed(2)}s` } : { animation: 'none' }}
            />
            {statusWord(session)}
          </span>
          {action && <span className="where">{actionWord(action)}</span>}

          <span className="spacer" />

          <a href="/" target="_blank" rel="noreferrer">Open in Charon</a>
          <button type="button" onClick={onClose} aria-label="Close">Close</button>
        </header>

        <div className="dsk-embed claude-root">
          {/* Les accessoires que Charon passe à sa propre vue. `selected` est
              la ligne de la session — celle que le desk tient à jour en direct,
              pas une copie figée. */}
          <ClaudeSessionView
            sessionId={session.id}
            selected={session}
            showTools
            handle={session.handle ?? null}
            siblings={siblings}
            selectedVps={vps}
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
