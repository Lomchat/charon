'use client';
import PickerControl from './PickerControl';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { providerName, providerText } from '@/lib/providerText';
import { SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import { backendAvailability } from './vpsHealth';
import type { AgentKind } from '@/lib/types/api';
import AgentLogo from './AgentLogo';
import { useAccountProfiles } from './accountProfileStore';
import { profileLabel } from '@/lib/accountProfiles';
import { providerLoginPatch } from '@/lib/sessionCapabilities';

/** A branch point: the branch ends just BEFORE this user message (§14.94). */
export type ForkPoint = { messageId: number; prompt: string; createdAt: number };

export type ForkChoice = {
  targetProfile: string;
  beforeMessageId?: number;
  /** Sent in the branch as its first message. */
  prompt?: string;
  /** Left in the branch's composer (client-side only, never posted). */
  draft?: string;
};

type Props = {
  sourceKind: AgentKind;
  sessionId: string;
  sourceName: string;
  vpsName?: string | null;
  /** The VPS row, so availability is read per provider from the registry
   *  (§14.102) instead of one boolean per backend added by hand. */
  vps?: { id?: string; agentStatus?: string | null } | null;
  /** Opened from a message's fork button: that message is the branch point. */
  initialPoint?: ForkPoint | null;
  busy: AgentKind | null;
  error: string | null;
  onChoose: (kind: AgentKind, choice: ForkChoice) => void;
  onClose: () => void;
};

export default function ForkModal({
  sourceKind, sessionId, sourceName, vpsName, vps, initialPoint, busy, error, onChoose, onClose,
}: Props) {
  const profiles = useAccountProfiles(vps?.id);
  const destinations = SESSION_PROVIDERS.flatMap((target) => {
    const found = profiles.filter((p) => p.provider === target && p.vpsId === vps?.id);
    const choices = found.length ? found : [{ id: 'default', vpsId: vps?.id ?? '', provider: target, number: 1, name: '', loggedIn: null }];
    return choices.map((profile) => ({ target, profile }));
  });
  const [loaded, setLoaded] = useState<ForkPoint[] | null>(null);
  const [pointId, setPointId] = useState<number | null>(initialPoint?.messageId ?? null);
  const [send, setSend] = useState(false);
  const [text, setText] = useState(initialPoint?.prompt ?? '');
  useEffect(() => {
    let live = true;
    fetch(`/api/sessions/${sessionId}/fork`).then((r) => r.json()).then((data) => {
      if (live) setLoaded(Array.isArray(data?.points) ? data.points : []);
    }).catch(() => { if (live) setLoaded([]); });
    return () => { live = false; };
  }, [sessionId]);
  // The clicked message is a point before the list arrives: the choice never
  // waits on the GET (a click on a destination meanwhile keeps the cut).
  const points = loaded ?? (initialPoint ? [initialPoint] : []);
  const selected = pointId == null ? null : points.find((p) => p.messageId === pointId) ?? null;
  const choose = (kind: AgentKind, targetProfile: string) => {
    if (pointId == null) return onChoose(kind, { targetProfile });
    const message = selected?.prompt ?? text;
    onChoose(kind, {
      targetProfile, beforeMessageId: pointId,
      ...(send ? (text.trim() ? { prompt: text.trim() } : {}) : (message.trim() ? { draft: message } : {})),
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const body = (
    <div className="app-modal-bg" onClick={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="app-modal fork-modal" role="dialog" aria-modal="true" aria-labelledby="fork-title">
        <div className="fork-head">
          <div>
            <h2 id="fork-title">Fork conversation</h2>
            <p>{sourceName}</p>
          </div>
          <button type="button" className="modal-close" aria-label="close" disabled={!!busy} onClick={onClose}>×</button>
        </div>
        <p className="fork-intro">Choose the exact context, then the agent that should continue it.</p>
        <label className="nw-field"><span>Branch point</span>
          <PickerControl value={pointId ?? -1} disabled={!!busy} onValueChange={(nextValue) => {
            const id = Number(nextValue);
            const point = id >= 0 ? points.find((p) => p.messageId === id) : null;
            setPointId(point ? point.messageId : null); setSend(false);
            setText(point?.prompt ?? '');
          }}>
            <option value={-1}>End of conversation</option>
            {points.map((point) => <option value={point.messageId} key={point.messageId}>
              Before · {new Date(point.createdAt * 1000).toLocaleString()} · {point.prompt.slice(0, 90)}
            </option>)}
          </PickerControl>
        </label>
        {selected && <>
          <label className="fork-edit-toggle"><input type="checkbox" checked={send} disabled={!!busy}
            onChange={(e) => setSend(e.target.checked)} /> Send this message in the branch</label>
          {send && <textarea className="fork-edit-prompt" rows={5} value={text} disabled={!!busy}
            onChange={(e) => setText(e.target.value)} />}
        </>}
        {/* One choice per declared backend (§14.102): the transports table
            already covers every pair, so the modal must offer every target or
            a backend silently becomes un-forkable-to. */}
        <div className="fork-choices">
          {destinations.map(({ target, profile }, i) => {
            const row = profile.id !== 'default' ? { ...vps, ...providerLoginPatch(target, profile.loggedIn ? 1 : 0) } : vps;
            const av = row ? backendAvailability(row as any, target) : { ok: true, reason: '' };
            const unavailable = !av.ok;
            return (
              <button
                key={`${target}:${profile.id}`}
                type="button"
                className="fork-choice"
                autoFocus={i === 0}
                disabled={!!busy || unavailable}
                onClick={() => choose(target, profile.id)}
              >
                <AgentLogo kind={target} profileNumber={profile.number} size={28} />
                <span className="fork-choice-copy">
                  <b>{profileLabel(providerName(target), profile)}</b>
                  <small>{unavailable
                    ? `${av.reason}${vpsName ? ` on ${vpsName}` : ' on this VPS'}`
                    : providerText.forkChoice(sourceKind, target)}</small>
                </span>
                <span className="fork-choice-go">{busy === target ? '…' : '→'}</span>
              </button>
            );
          })}
        </div>
        <p className="fork-note">The current session keeps running untouched. The branch inherits its
          notification rules, plus the model and effort the chosen agent can still honour.</p>
        {error && <p className="confirm-err">{error}</p>}
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(body, document.body);
}
