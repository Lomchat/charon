'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import type { Vps } from '@/lib/types/api';
import { ENDPOINT_ENGINES, type CustomEndpoint } from '@/lib/customEndpoints';
import { providerName } from '@/lib/providerText';
const CustomEndpointModal = dynamic(() => import('./CustomEndpointModal'), { ssr: false });

export default function CustomEndpointsSettings({ vpsList = [] }: { vpsList?: Vps[] }) {
  const [endpoints, setEndpoints] = useState<CustomEndpoint[]>([]);
  const [editing, setEditing] = useState<CustomEndpoint | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => api.listCustomEndpoints().then((r) => setEndpoints(r.endpoints)).catch((e) => setError(e.message));
  useEffect(() => { void refresh(); }, []);
  async function remove(id: string) {
    try { await api.deleteCustomEndpoint(id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete endpoint.'); }
  }
  return <div className="endpoint-settings"><h3>Custom endpoints</h3><p className="set-meta">Reusable connections. Each session keeps an independent copy.</p>
    <button type="button" onClick={() => setEditing('new')}>Add endpoint</button>
    {error && <p role="alert">{error}</p>}
    {!endpoints.length && <p className="set-meta">No saved endpoints yet. You can also save one from a session’s model picker.</p>}
    {endpoints.map((e) => <div className="endpoint-saved-row" key={e.id}>
      <strong>{e.name}</strong><span>{e.baseUrl}</span><span>{e.model}</span>
      <small>{ENDPOINT_ENGINES.map((engine) => `${providerName(engine)}: ${e.checks?.[engine]?.ok ? 'tested' : 'not verified'}`).join(' · ')}</small>
      <div><button type="button" onClick={() => setEditing(e)}>Edit / test</button><button type="button" onClick={() => remove(e.id!)}>Delete</button></div>
    </div>)}
    {editing && <CustomEndpointModal engine="claude" vpsList={vpsList} initial={editing === 'new' ? null : editing} editingId={editing === 'new' ? undefined : editing.id} onClose={() => setEditing(null)} onApplied={refresh} />}
  </div>;
}
