'use client';
// The drawer: the desk's head over Charon's session view. The board lends it
// its actions through ONE stable host (drawerHost.ts).
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps } from '@/lib/types/api';
import { agentName, moodOf } from '../game/model';
import { DrawerHostContext, type DrawerHost, type DrawerSibling } from './drawerHost';
import UnitHead from './UnitHead';
import UnitSession from './UnitSession';

type Props = {
  session: SessionSummary;
  vps: Vps | null;
  /** Its team (sub-sessions): the session it works for, the ones that work
   *  for it, and the colour of their rug on the board. */
  lead: SessionSummary | null;
  crew: SessionSummary[];
  teamTint: string | null;
  /** The `@` menu: the sessions on its machine. */
  siblings: DrawerSibling[];
  /** "Got it" applies (Desk's canRead). */
  canRead: boolean;
  /** The read receipt is on its way. */
  reading: boolean;
  host: DrawerHost;
};

export default function UnitPanel({ session, vps, lead, crew, teamTint, siblings, canRead, reading, host }: Props) {
  // A low screen (a laptop): a smaller head, the height goes to the conversation.
  const low = typeof window !== 'undefined' && window.innerHeight < 820;
  return (
    <DrawerHostContext.Provider value={host}>
      <aside className="dk-unit" data-mood={moodOf(session)} data-low={low || undefined} aria-label={`agent ${agentName(session)}`}>
        <UnitHead session={session} vps={vps} lead={lead} crew={crew} teamTint={teamTint}
          canRead={canRead} reading={reading} low={low} />
        {/* `key`: one SessionView (one stream, one draft) per robot. */}
        <UnitSession key={session.id} session={session} vps={vps} siblings={siblings} />
      </aside>
    </DrawerHostContext.Provider>
  );
}
