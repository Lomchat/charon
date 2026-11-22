'use client';
import { useEffect, useState } from 'react';

// Shared desktop/mobile type defined in `./sessionTypes`. Re-exported here
// to preserve historical imports.
export type { PermissionRequest } from './sessionTypes';
import type { PermissionRequest } from './sessionTypes';
import ApprovalDeadline from './ApprovalDeadline';
import PermissionActions from './PermissionActions';
import type { FeedPermission } from './useCrossSessionInteractionFeed';

/** `preview`: the hub's bounded rendering of the tool input (≤600 chars,
 *  computed once per gate — session summaries, §14.108); `input` is absent
 *  from summary-derived entries. */
type Props = {
  queue: FeedPermission[];
  currentSessionId: string | null;
  onRespond: (sessionId: string, permId: string, allow: boolean, always: boolean, suggestion?: number) => void;
  onSwitchSession: (sessionId: string) => void;
};

export default function PermissionPopup({ queue: fullQueue, currentSessionId, onRespond, onSwitchSession }: Props) {
  // The session open in this tab already shows its request inline (PendingZone
  // card): a second copy here is noise (R5 D-15). `currentSessionId` is only
  // set while the main pane shows a session.
  const queue = currentSessionId ? fullQueue.filter((q) => q.sessionId !== currentSessionId) : fullQueue;
  if (queue.length === 0) return null;
  const top = queue[0];
  return (
    <div className="perm-popup">
      <div className="perm-card">
        <header>
          <span className="badge">{queue.length}</span>
          <span className="title">permission requested</span>
          <button className="switch" onClick={() => onSwitchSession(top.sessionId)} title="open this session">
            ↗ session {top.sessionId.slice(0, 6)}
          </button>
        </header>
        <div className="tool-name">
          {top.tool}{top.prompt?.agentId && <span className="pp-chip" title={top.prompt.agentId}>sub-agent</span>}
        </div>
        <ApprovalDeadline expiresAt={top.expiresAt} />
        {top.prompt?.title && <p className="reason">{top.prompt.title}</p>}
        {top.prompt?.blockedPath && <p className="reason"><span aria-hidden>📁</span> <code>{top.prompt.blockedPath}</code></p>}
        {top.reason && <p className="reason">{top.reason}</p>}
        <pre className="input-preview">{top.preview ?? (top.input === undefined ? '' : JSON.stringify(top.input, null, 2) ?? '').slice(0, 600)}</pre>
        <div className="actions">
          <PermissionActions
            kind={top.kind} suggestions={top.suggestions}
            onRespond={(allow, always, suggestion) => onRespond(top.sessionId, top.id, allow, always, suggestion)}
          />
        </div>
        {queue.length > 1 && (
          <ul className="queue">
            {queue.filter((q) => q.id !== top.id).slice(0, 5).map((q) => (
              <li key={q.id}>
                <span className="t">{q.tool}</span>
                <button onClick={() => onSwitchSession(q.sessionId)}>session {q.sessionId.slice(0, 6)}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
