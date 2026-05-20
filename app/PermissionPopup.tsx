'use client';
import { useEffect, useState } from 'react';

// Shared desktop/mobile type defined in `./sessionTypes`. Re-exported here
// to preserve historical imports.
export type { PermissionRequest } from './sessionTypes';
import type { PermissionRequest } from './sessionTypes';

type Props = {
  queue: PermissionRequest[];
  currentSessionId: string | null;
  onRespond: (sessionId: string, permId: string, allow: boolean, always: boolean) => void;
  onSwitchSession: (sessionId: string) => void;
};

export default function PermissionPopup({ queue, currentSessionId, onRespond, onSwitchSession }: Props) {
  if (queue.length === 0) return null;
  // Show first request for the current session, or first overall
  const top = queue.find((q) => q.sessionId === currentSessionId) ?? queue[0];
  const isCurrent = top.sessionId === currentSessionId;
  return (
    <div className="perm-popup">
      <div className="perm-card">
        <header>
          <span className="badge">{queue.length}</span>
          <span className="title">permission requested</span>
          {!isCurrent && (
            <button className="switch" onClick={() => onSwitchSession(top.sessionId)} title="open this session">
              ↗ session {top.sessionId.slice(0, 6)}
            </button>
          )}
        </header>
        <div className="tool-name">{top.tool}</div>
        <pre className="input-preview">{JSON.stringify(top.input, null, 2).slice(0, 600)}</pre>
        <div className="actions">
          <button className="allow" onClick={() => onRespond(top.sessionId, top.id, true, false)}>allow once</button>
          <button className="always" onClick={() => onRespond(top.sessionId, top.id, true, true)}>allow always (session)</button>
          <button className="deny" onClick={() => onRespond(top.sessionId, top.id, false, false)}>deny</button>
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
