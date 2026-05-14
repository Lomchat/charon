'use client';
import { useEffect } from 'react';
import type { ClaudeSession } from '@/lib/db/schema';

type Props = {
  session: ClaudeSession;
  x: number;
  y: number;
  onRename: () => void;
  onKill: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export default function SessionContextMenu({ session, x, y, onRename, onKill, onDelete, onClose }: Props) {
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement;
      if (!tgt.closest('.session-ctx-menu')) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const canKill = session.status !== 'killed';

  return (
    <div className="session-ctx-menu" style={{ left: x, top: y }} role="menu">
      <div className="ctx-head">{session.name || session.cwd.split('/').slice(-2).join('/')}</div>
      <button type="button" onClick={() => { onRename(); onClose(); }}>renommer</button>
      <button type="button" onClick={() => { onKill(); onClose(); }} disabled={!canKill}>
        kill {session.status === 'killed' && '(déjà tuée)'}
      </button>
      <button type="button" className="danger" onClick={() => { onDelete(); onClose(); }}>
        supprimer définitivement
      </button>
    </div>
  );
}
