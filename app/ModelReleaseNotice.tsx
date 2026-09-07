'use client';
import { useEffect, useRef, useState } from 'react';
import type { AgentKind, ModelNotice } from '@/lib/types/api';

/** Mounted only beside the visible provider's select. Keep the announcement
 * readable for this visit after the backend clears badges everywhere. */
export default function ModelReleaseNotice({ provider, unread, onSeen }: {
  provider: AgentKind;
  unread: ModelNotice[];
  onSeen: (provider: AgentKind, ids: string[]) => Promise<void>;
}) {
  const [shown, setShown] = useState(unread);
  const element = useRef<HTMLSpanElement>(null);
  const displayed = [...new Map([...shown, ...unread].map((m) => [m.id, m])).values()];
  useEffect(() => {
    if (unread.length) setShown((previous) => [
      ...new Map([...previous, ...unread].map((m) => [m.id, m])).values(),
    ]);
  }, [unread]);

  useEffect(() => {
    if (!unread.length || !element.current) return;
    let disposed = false;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!visible || document.visibilityState === 'hidden') return;
      timer = setTimeout(async () => {
        try { await onSeen(provider, unread.map((m) => m.id)); }
        catch { if (!disposed) timer = setTimeout(schedule, 5_000); }
      }, 1_000);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      schedule();
    });
    observer.observe(element.current);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [provider, unread, onSeen]);

  if (!displayed.length) return null;
  return (
    <span ref={element} className="model-release-notice" role="status">
      {displayed.length === 1 ? 'Nouveau modèle' : 'Nouveaux modèles'} :{' '}
      {displayed.map((model) => model.label).join(', ')}
    </span>
  );
}
