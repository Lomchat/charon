'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EndpointState } from '@/lib/customEndpoints';
import { subscribeAll, subscribeReconnect } from './globalEventStream';

export function useSessionEndpoint(id: string, initial?: EndpointState) {
  const [state, setState] = useState<EndpointState>(initial || { active: null });
  const refresh = useCallback(() => api.getSessionEndpoint(id).then(setState).catch(() => {}), [id]);
  useEffect(() => {
    let alive = true;
    const sync = () => { api.getSessionEndpoint(id).then((r) => { if (alive) setState(r); }).catch(() => {}); };
    sync();
    const off = subscribeAll((e) => { if (e.type === 'session_list_changed' && e.sessionId === id) sync(); });
    const reconnect = subscribeReconnect(sync);
    return () => { alive = false; off(); reconnect(); };
  }, [id]);
  return [state, refresh] as const;
}
