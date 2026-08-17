'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Msg } from './sessionTypes';

export type RewindChoice = {
  id: string;
  user: string;
  assistant: string;
  createdAt: number;
};

/** Build newest-first, human-readable turn anchors from the visible replay. */
export function buildRewindChoices(messages: Msg[]): RewindChoice[] {
  const chronological: RewindChoice[] = [];
  let current: RewindChoice | null = null;
  for (const message of messages) {
    // Optimistic/local user bubbles have no durable row yet. A destructive
    // rewind may only target the `m<SQLite id>` anchors returned by the API.
    if (message.role === 'user' && /^m\d+$/.test(message.id)) {
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
  return chronological.slice(-100).reverse();
}

export default function RewindModal({ messages, provider, busy, error, onConfirm, onClose }: {
  messages: Msg[];
  provider: 'Claude' | 'Codex';
  busy: boolean;
  error: string | null;
  onConfirm: (messageId: string) => void;
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
          <div><h2 id="rewind-title">Rewind {provider} history</h2><p>Choose the first message to remove</p></div>
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
                {choice.assistant && <span className="rewind-assistant">{provider}: {choice.assistant}</span>}
              </button>
            ))}
          </div>
        ) : <p className="tp-empty">No user message is available to rewind.</p>}
        <p className="fork-note">
          The selected message and everything after it will be removed from {provider} and Charon.
          File changes are not reverted.
        </p>
        {error && <p className="confirm-err">{error}</p>}
        <div className="confirm-actions">
          <button type="button" onClick={onClose} disabled={busy}>cancel</button>
          <button type="button" className="danger" onClick={() => selected && onConfirm(selected.id)} disabled={busy || !selected}>
            {busy ? 'rewinding…' : 'rewind before this message'}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(body, document.body);
}
