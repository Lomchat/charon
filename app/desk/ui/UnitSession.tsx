'use client';
// The drawer's session: Charon's own SessionView, compact. One stream, one
// composer, one set of gate cards — Charon's, never a desk copy. Its look is
// desk.css § the drawer's session pane (Charon's classes, scoped `.desk .dk-sv`).
import { memo, useCallback } from 'react';
import SessionView from '@/app/SessionView';
import type { SessionSummary } from '@/lib/sessionSummary';
import type { Vps } from '@/lib/types/api';
import { useDrawerHost, type DrawerSibling } from './drawerHost';

export default memo(function UnitSession({ session, vps, siblings }:
  { session: SessionSummary; vps: Vps | null; siblings: DrawerSibling[] }) {
  const host = useDrawerHost();
  const id = session.id;
  // An empty order: Enter opens the full view, Tab goes on to the next robot.
  const onEmptyComposerKey = useCallback((key: 'Enter' | 'Tab', shift: boolean) => {
    if (key === 'Enter') host.openFull(id); else host.next(shift);
    return true;
  }, [host, id]);
  return (
    <div className="dk-sv" data-theme="nordic">
      {/* SessionView stabilizes its inline callbacks itself (§14.38). */}
      <SessionView compact sessionId={id} selected={session} showTools={false} showToolsReady
        handle={session.handle ?? null} siblings={siblings} selectedVps={vps} usageAccountLabel={null}
        composerRef={host.composerRef} onEmptyComposerKey={onEmptyComposerKey}
        onOpenSession={host.goTo} onReauth={() => host.reauth(id)} onOpenTools={(tab) => host.openTools(id, tab)}
        onNewSessionIn={host.newSessionIn} onNewRoutine={host.newRoutine}
        onKilled={() => host.killed(id)} onAfterRevert={host.sessionsChanged}
        onImportError={() => host.sessionsChanged()} />
    </div>
  );
});
