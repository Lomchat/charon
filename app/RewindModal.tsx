'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Msg } from './sessionTypes';

export type RewindChoice = {
  id: string;
  user: string;
  assistant: string;
  createdAt: number;
  /** Number expected by Codex thread/rollback for this point. */
  turns: number;
};

/** Build newest-first, human-readable turn anchors from the visible replay. */
export function buildRewindChoices(messages: Msg[]): RewindChoice[] {
  const chronological: Omit<RewindChoice, 'turns'>[] = [];
  let current: Omit<RewindChoice, 'turns'> | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      current = {
        id: message.id,
        user: message.content.trim() || '(empty message)',
        assistant: '',
        createdAt: message.createdAt,
      };
      chronological.push(current);
    } else if (message.role === 'assistant' && current && message.content.trim()) {
      current.assistant = current.assistant
        ? `${current.assistant}\n${message.content.trim()}`
        : message.content.trim();
    }
  }
  return chronological.slice(-100).reverse().map((turn, index) => ({ ...turn, turns: index + 1 }));
}

export default function RewindModal({ messages, busy, error, onConfirm, onClose }: {
  messages: Msg[];
  busy: boolean;
  error: string | null;
  onConfirm: (turns: number) => void;
  onClose: () => void;
}) {
  const choices = useMemo(() => buildRewindChoices(messages), [messages]);
  const [selectedId, setSelectedId] = useState(() => choices[0]?.id ?? '');
  const selected = choices.find((choice) => choice.id === selectedId) ?? choices[0] ?? null;
  useEffect(() => {
    if (!selectedId && choices[0]) setSelectedId(choices[0].id);
  }, [choices, selectedId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);
  const body = (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="claude-modal fork-modal" role="dialog" aria-modal="true" aria-labelledby="rewind-title">
        <div className="fork-head">
          <div><h2 id="rewind-title">Rewind Codex history</h2><p>Choose the first message to remove</p></div>
          <button type="button" className="modal-close" disabled={busy} onClick={onClose}>×</button>
        </div>
        {choices.length > 0 ? (
          <div className="rewind-list" role="radiogroup" aria-label="Conversation point">
            {choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={selected?.id === choice.id}
                className={`rewind-choice${selected?.id === choice.id ? ' on' : ''}`}
                disabled={busy}
                onClick={() => setSelectedId(choice.id)}
              >
                <span className="rewind-choice-head">
                  <b>You</b>
                  <time>{new Date(choice.createdAt * 1000).toLocaleString()}</time>
                </span>
                <span className="rewind-user">{choice.user}</span>
                {choice.assistant && <span className="rewind-assistant">Codex: {choice.assistant}</span>}
              </button>
            ))}
          </div>
        ) : <p className="tp-empty">No user message is available to rewind.</p>}
        <p className="fork-note">
          The selected message and everything after it will be removed from Codex and Charon.
          File changes are not reverted.
        </p>
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose} disabled={busy}>cancel</button>
          <button type="button" className="danger" onClick={() => selected && onConfirm(selected.turns)} disabled={busy || !selected}>
            {busy ? 'rewinding…' : 'rewind before this message'}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
