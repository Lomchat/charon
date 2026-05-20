'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ClaudeSession } from '@/lib/db/schema';

type Result = {
  messageId: number;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  session: (ClaudeSession & { vpsName?: string | null }) | null;
};

type Props = {
  onClose: () => void;
  onPick: (sessionId: string) => void;
};

export default function SearchModal({ onClose, onPick }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.searchClaude(q);
        setResults(r.results ?? []);
      } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="claude-modal-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="claude-modal search">
        <button className="modal-close" onClick={onClose}>✕</button>
        <h2>search</h2>
        <input
          autoFocus
          placeholder="text to search in messages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="search-input"
        />
        {loading && <div className="search-loading">searching…</div>}
        <ul className="search-results">
          {results.map((r) => (
            <li key={r.messageId} onClick={() => onPick(r.sessionId)}>
              <div className="head">
                {r.session?.vpsName && <span className="vps">{r.session.vpsName}</span>}
                <span className="sess">{r.session?.name ?? r.session?.cwd ?? r.sessionId.slice(0, 8)}</span>
                <span className="role">{r.role}</span>
                <span className="when">{new Date(r.createdAt * 1000).toLocaleString('en-US')}</span>
              </div>
              <div className="snippet">{r.snippet}</div>
            </li>
          ))}
          {q.length >= 2 && !loading && results.length === 0 && (
            <li className="empty">no results</li>
          )}
        </ul>
      </div>
    </div>
  );
}
