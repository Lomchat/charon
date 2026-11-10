'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { api } from '@/lib/api';
import { publishSavedEndpoints, refreshSavedEndpoints } from './savedEndpointsStore';
import type { EndpointBatch, Vps } from '@/lib/types/api';
import { ENDPOINT_ENGINES, endpointModelCheck, type CustomEndpoint, type EndpointEngine } from '@/lib/customEndpoints';
import { providerName } from '@/lib/providerText';
import AgentLogo from './AgentLogo';
import { IconPencil, IconPlay, IconPlug, IconPlusSquare, IconTrash } from './icons';
import PickerControl from './PickerControl';
const CustomEndpointModal = dynamic(() => import('./CustomEndpointModal'), { ssr: false });

export default function CustomEndpointsSettings({ vpsList = [] }: { vpsList?: Vps[] }) {
  const [endpoints, setEndpoints] = useState<CustomEndpoint[]>([]);
  const [editing, setEditing] = useState<{ endpoint: CustomEndpoint | null; engine: EndpointEngine; test?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<EndpointBatch | null>(null);
  const [batchPending, setBatchPending] = useState(false);
  const [testVpsId, setTestVpsId] = useState('');
  const batchRevision = useRef(0);
  const selectedVpsId = testVpsId || vpsList[0]?.id || '';
  const batchBusy = !!batch && ['preparing', 'running', 'cancelling'].includes(batch.status);
  const locked = batchBusy || batchPending || !!removing;
  async function refresh() {
    try { const r = await api.listCustomEndpoints(); setEndpoints(r.endpoints); publishSavedEndpoints(r.endpoints); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load endpoints.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let last = '';
    const poll = async () => {
      const revision = batchRevision.current;
      try {
        const { batch: next } = await api.getEndpointBatch();
        if (stopped || revision !== batchRevision.current) return;
        setBatch(next);
        const stamp = next ? `${next.id}:${next.completed}:${next.status}` : '';
        if (stamp !== last) { last = stamp; await refresh(); }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : 'Could not refresh test progress.');
      } finally {
        if (!stopped) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
  async function testAll(endpointId?: string) {
    batchRevision.current++;
    setBatchPending(true); setError(null);
    try {
      const result = await api.startEndpointBatch({ vpsId: selectedVpsId, endpointId });
      setBatch(result.batch);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not start endpoint tests.'); }
    finally { setBatchPending(false); }
  }
  async function stopTests() {
    if (!batch) return;
    batchRevision.current++;
    setBatchPending(true); setError(null);
    try { setBatch((await api.cancelEndpointBatch(batch.id)).batch); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not stop endpoint tests.'); }
    finally { setBatchPending(false); }
  }
  async function remove(id: string) {
    setRemoving(id); setError(null);
    try { await api.deleteCustomEndpoint(id); setEndpoints((rows) => rows.filter((e) => e.id !== id)); void refreshSavedEndpoints(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not delete endpoint.'); }
    finally { setRemoving(null); }
  }
  return <section className="endpoint-settings" aria-label="Custom endpoints">
    <div className="endpoint-settings-head">
      <div><h3>Custom endpoints <span className="endpoint-count">{endpoints.length}</span></h3><p className="set-hint">Your model connections, ready to use in any session.</p></div>
      <button type="button" className="endpoint-btn is-primary" disabled={locked} onClick={() => setEditing({ endpoint: null, engine: 'claude' })}><IconPlusSquare />Add endpoint</button>
    </div>
    <div className="endpoint-batch">
      <div className="endpoint-batch-controls">
        <label>Test from VPS<PickerControl aria-label="VPS for endpoint tests" value={batchBusy && batch ? batch.vpsId : selectedVpsId} disabled={locked} onValueChange={setTestVpsId}>
          {vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </PickerControl></label>
        <button type="button" className="endpoint-btn is-primary" disabled={locked || loading || !endpoints.length || !selectedVpsId} onClick={() => testAll()}><IconPlay />Test all endpoints</button>
        {batchBusy && <button type="button" className="endpoint-btn" disabled={batchPending || batch?.status === 'cancelling'} onClick={stopTests}>{batch?.status === 'cancelling' ? 'Stopping…' : 'Stop tests'}</button>}
      </div>
      <p className="set-meta">Tests every model with {ENDPOINT_ENGINES.map(providerName).join(' and ')} and saves compatibility badges automatically. These tests send small requests to your providers.</p>
      {batch && <EndpointBatchProgress batch={batch} />}
    </div>
    {error && <div className="endpoint-error" role="alert"><span>{error}</span><button type="button" className="endpoint-btn" onClick={refresh}>Retry</button></div>}
    {loading ? <p className="endpoint-empty" role="status">Loading connections…</p> : <>
      {!endpoints.length && !error && <div className="endpoint-empty"><IconPlug /><strong>Connect your own model</strong><p>Use a self-hosted server or another provider. Add its URL, model and optional API key to get started.</p></div>}
      <div className="endpoint-cards">
        {endpoints.map((e) => <article className="endpoint-card" key={e.id} aria-label={e.name} aria-busy={removing === e.id}>
          <div className="endpoint-card-head">
            <span className="endpoint-card-icon"><IconPlug /></span>
            <div className="endpoint-card-name"><strong>{e.name}</strong><span>{e.models?.length ? `${e.models.length} models · ${e.models.filter((m) => ENDPOINT_ENGINES.some((engine) => endpointModelCheck(e, engine, m.id)?.ok)).length} verified · Default: ${e.model}` : e.model}</span></div>
            <div className="endpoint-card-actions">
              <button type="button" className="endpoint-btn" disabled={locked || !selectedVpsId} onClick={() => testAll(e.id)} aria-label={`Test all models for ${e.name}`}><IconPlay />Test all models</button>
              <button type="button" className="endpoint-btn" disabled={locked} onClick={() => setEditing({ endpoint: e, engine: ENDPOINT_ENGINES.find((engine) => endpointModelCheck(e, engine, e.model)?.ok) || 'claude' })} aria-label={`Edit ${e.name}`}><IconPencil />Edit</button>
              <button type="button" className="endpoint-btn is-icon is-danger" disabled={locked} onClick={() => remove(e.id!)} title={`Delete ${e.name}`} aria-label={`Delete ${e.name}`}><IconTrash /></button>
            </div>
          </div>
          <dl className="endpoint-card-details"><div><dt>URL</dt><dd>{e.baseUrl}</dd></div><div><dt>Auth</dt><dd>{e.auth === 'none' ? 'No authentication' : e.auth === 'bearer' ? 'Bearer token' : 'API key'}{e.hasToken && <span className="endpoint-credential-state">Credential saved</span>}</dd></div></dl>
          <div className="endpoint-card-checks" aria-label="API compatibility">
            {ENDPOINT_ENGINES.map((engine) => {
              const verified = e.models?.filter((m) => endpointModelCheck(e, engine, m.id)?.ok) ?? [];
              const check = endpointModelCheck(e, engine, e.model);
              const status = verified.length || check?.ok ? 'verified' : check ? 'failed' : 'unknown';
              return <button key={engine} type="button" className={`endpoint-engine-check is-${status}`} disabled={locked}
                onClick={() => setEditing({ endpoint: { ...e, model: verified[0]?.id || e.model }, engine, test: true })} aria-label={`Check ${providerName(engine)} compatibility for ${e.name}`}>
                <AgentLogo kind={engine} size={16} /><span>{providerName(engine)}</span><span className="endpoint-check-label"><i />{verified.length ? `${verified.length} ${verified.length === 1 ? 'model' : 'models'} verified` : check?.ok ? 'API verified' : check ? 'Test failed' : 'Not tested'}</span><span className="endpoint-check-arrow" aria-hidden="true">↗</span>
              </button>;
            })}
          </div>
        </article>)}
      </div>
    </>}
    <div className="endpoint-guide">
      <h3>What the compatibility test checks</h3>
      <dl><div><dt>Streaming & tools</dt><dd>A streamed reply, a tool call and a reply after its result. Test each engine with the model you will use.</dd></div>
        <div><dt>Pause & resume</dt><dd>Managed by Charon and the session engine. A live session is needed to verify recovery with a new provider.</dd></div>
        <div><dt>Reasoning effort</dt><dd>Shown only when the model declares supported levels. Otherwise, the model uses its own default.</dd></div></dl>
      <p className="set-meta">Editing or deleting a saved connection does not change sessions already using it.</p>
    </div>
    {editing && <CustomEndpointModal engine={editing.engine} vpsList={vpsList} initial={editing.endpoint} editingId={editing.endpoint?.id} focusTest={editing.test} onClose={() => setEditing(null)} onApplied={refresh} />}
  </section>;
}

export function EndpointBatchProgress({ batch }: { batch: EndpointBatch }) {
  const labels: Record<EndpointBatch['status'], string> = {
    preparing: 'Loading model catalogs…', running: 'Testing compatibility…', cancelling: 'Finishing current tests…',
    completed: 'Tests complete', cancelled: 'Tests stopped — completed results saved', error: 'Tests interrupted — completed results saved',
  };
  return <div className="endpoint-batch-progress">
    <div className="endpoint-batch-progress-head" role="status"><strong>{labels[batch.status]}</strong><span>{batch.completed} / {batch.total} checks</span></div>
    <progress aria-label="Endpoint compatibility tests" max={Math.max(1, batch.total)} value={batch.completed} />
    <div className="endpoint-model-badges">{ENDPOINT_ENGINES.map((engine) => <span className="endpoint-model-badge" data-state={batch.passed[engine] ? 'verified' : 'unknown'} key={engine}>
      {providerName(engine)} · {batch.passed[engine]} verified · {batch.failed[engine]} failed
    </span>)}</div>
    {batch.active.map((test) => <p className="set-meta" key={`${test.endpointId}:${test.model}:${test.engine}`}>{test.name} · {test.model} · {providerName(test.engine)}</p>)}
    {batch.error && <p className="endpoint-error" role="alert">{batch.error}</p>}
  </div>;
}
