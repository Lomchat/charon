'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { ENDPOINT_ENGINES, type CustomEndpoint, type EndpointAuth, type EndpointEngine, type EndpointInput } from '@/lib/customEndpoints';
import { providerName } from '@/lib/providerText';
import type { Vps } from '@/lib/types/api';
import type { EndpointProbeResponse } from '@/lib/types/api';
import PickerControl from './PickerControl';

export default function CustomEndpointModal({ sessionId, engine: initialEngine, vpsId: initialVpsId, vpsList = [], initial, editingId, onClose, onApplied }: {
  sessionId?: string; engine: EndpointEngine; vpsId?: string; vpsList?: Vps[];
  initial?: CustomEndpoint | null; editingId?: string;
  onClose: () => void; onApplied: () => void;
}) {
  const [engine, setEngine] = useState(initialEngine);
  const [vpsId, setVpsId] = useState(initialVpsId || vpsList[0]?.id || '');
  const [saved, setSaved] = useState<CustomEndpoint[]>([]);
  const [savedId, setSavedId] = useState(editingId || '');
  const [useSessionCredential, setUseSessionCredential] = useState(!!sessionId && !!initial);
  const [name, setName] = useState(initial?.name || '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || '');
  const [auth, setAuth] = useState<EndpointAuth>(initial?.auth || 'none');
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(!!initial?.hasToken);
  const [model, setModel] = useState(initial?.model || '');
  const [models, setModels] = useState(initial?.models || []);
  const [saveForReuse, setSaveForReuse] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EndpointProbeResponse | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  useEffect(() => {
    api.listCustomEndpoints().then((r) => setSaved(r.endpoints)).catch((e) => setError(e.message));
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      // A picker opened inside the dialog owns its Escape and keyboard trap.
      if (document.querySelector('.picker-popup')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!busyRef.current) closeRef.current(); }
      if (e.key === 'Tab') {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || []).filter((el) => el.offsetParent !== null);
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.isConnected && previous.focus(); };
  }, []);

  function changed() { setResult(null); setError(null); }
  function chooseSaved(id: string) {
    const endpoint = saved.find((v) => v.id === id);
    setSavedId(id); setUseSessionCredential(false); setToken(''); setHasToken(!!endpoint?.hasToken);
    setBaseUrl(endpoint?.baseUrl || ''); setAuth(endpoint?.auth || 'none'); setName(endpoint?.name || '');
    setModel(endpoint?.model || ''); setModels(endpoint?.models || []); changed();
  }
  function payload(): EndpointInput {
    return { name, baseUrl, auth, model, ...(savedId ? { savedId } : {}),
      useSessionCredential, ...(token || !hasToken ? { token } : {}) };
  }
  async function probe(action: 'models' | 'test') {
    setBusy(action); setError(null); setResult(null);
    try {
      const r = await api.probeCustomEndpoint({ endpoint: payload(), engine, vpsId, sessionId, action });
      setModels(r.models || []); setResult(r);
      if (!model && r.models?.length) setModel(r.models[0].id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection test failed.'); }
    finally { setBusy(null); }
  }
  async function apply() {
    setBusy('save'); setError(null);
    try {
      if (sessionId) await api.setSessionEndpoint(sessionId, { endpoint: payload(), saveForReuse });
      else await api.saveCustomEndpoint({ endpoint: payload(), id: editingId, vpsId });
      onApplied(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save endpoint.'); }
    finally { setBusy(null); }
  }
  const valid = !!baseUrl.trim() && !!model.trim() && (auth === 'none' || !!token || hasToken);
  return createPortal(<div className="claude-modal-bg endpoint-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="claude-modal endpoint-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="endpoint-modal-title" aria-busy={!!busy}>
      <div className="endpoint-modal-head"><h2 id="endpoint-modal-title">Custom endpoint</h2><button type="button" onClick={onClose} disabled={!!busy} aria-label="Close endpoint dialog">×</button></div>
      <p className="set-meta">{sessionId ? `Use a custom model with ${providerName(engine)} in this session.` : 'Save a connection for reuse across sessions.'}</p>
      {sessionId && <label>Connection<PickerControl aria-label="Connection" value={savedId} disabled={!!busy} onValueChange={chooseSaved}>
        <option value="">{useSessionCredential ? 'Current session connection' : 'New endpoint'}</option>
        {saved.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.baseUrl}</option>)}
      </PickerControl></label>}
      {sessionId && useSessionCredential && <button type="button" className="endpoint-inline-action" onClick={() => chooseSaved('')} disabled={!!busy}>New endpoint</button>}
      <label>Base URL<input value={baseUrl} placeholder="https://models.example.com" autoComplete="off" disabled={!!busy}
        onChange={(e) => { setBaseUrl(e.target.value); setHasToken(false); setToken(''); setModels([]); changed(); }} /></label>
      <p className="set-meta">{engine === 'claude' ? 'Requires a Messages-compatible API with streaming and tools.' : 'Requires a Responses-compatible API with streaming and tools.'}</p>
      <label><span>Display name <small className="set-meta">(optional)</small></span><input value={name} maxLength={100} placeholder="My inference server" disabled={!!busy} onChange={(e) => setName(e.target.value)} /></label>
      <label>Authentication<PickerControl aria-label="Authentication" value={auth} disabled={!!busy} onValueChange={(v) => { setAuth(v as EndpointAuth); setHasToken(false); setToken(''); changed(); }}>
        <option value="none">None</option><option value="api-key">API key (x-api-key)</option><option value="bearer">Bearer token (Authorization)</option>
      </PickerControl></label>
      {auth !== 'none' && <label>Token<input className="endpoint-token" type="text" value={token} autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true"
        placeholder={hasToken ? 'Stored credential — leave blank to keep' : 'Enter the endpoint credential'} disabled={!!busy} onChange={(e) => { setToken(e.target.value); changed(); }} /></label>}
      <label>Model ID<input value={model} list="endpoint-model-ids" placeholder="Exact model ID" maxLength={256} disabled={!!busy} onChange={(e) => { setModel(e.target.value); changed(); }} /></label>
      <datalist id="endpoint-model-ids">{models.map((m) => <option key={m.id} value={m.id} />)}</datalist>
      {!sessionId && <div className="endpoint-test-target"><label>Test with<PickerControl aria-label="Test with" value={engine} disabled={!!busy} onValueChange={(v) => { setEngine(v as EndpointEngine); changed(); }}>{ENDPOINT_ENGINES.map((v) => <option key={v} value={v}>{providerName(v)}</option>)}</PickerControl></label>
        <label>VPS<PickerControl aria-label="VPS" value={vpsId} disabled={!!busy} onValueChange={(v) => { setVpsId(v); changed(); }}>{vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</PickerControl></label></div>}
      <div className="endpoint-test-actions"><button type="button" disabled={!!busy || !baseUrl || !vpsId} onClick={() => probe('models')}>{busy === 'models' ? 'Loading…' : 'Load models'}</button>
        <button type="button" disabled={!!busy || !valid || !vpsId} onClick={() => probe('test')}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button></div>
      {result && <div className={`endpoint-test-result${result.check && !result.ok ? ' is-error' : ''}`} role="status">
        {result.check ? <><strong>{result.ok ? 'Streaming and tool round trip verified' : 'Compatibility test failed'}</strong><p>{result.check.error || `${providerName(engine)} · ${model}`}</p>
          {result.ok && <p>{result.check.effortLevels?.length ? `Effort: ${result.check.effortLevels.join(', ')} (declared by endpoint)` : 'Effort support unknown — model default will be used.'}</p>}</> : <p>{result.models.length ? `${result.models.length} models found. Choose a model above.` : result.catalogError}</p>}
      </div>}
      {sessionId && <div className="switch-row"><span>Save for reuse</span><button type="button" role="switch" aria-label="Save for reuse" aria-checked={saveForReuse} className={`toggle${saveForReuse ? ' on' : ''}`} disabled={!!busy} onClick={() => setSaveForReuse(!saveForReuse)}><span className="knob" /></button></div>}
      <p className="set-meta">{sessionId ? 'Applies only to this session, after its current work finishes. The connection is kept when the session restarts.' : 'Existing sessions keep their own connection when this entry is edited or deleted.'}</p>
      {error && <p className="runtime-choice-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={!!busy}>Cancel</button><button type="button" className="primary" onClick={apply} disabled={!!busy || !valid || (!!result?.check && !result.ok)}>{busy === 'save' ? 'Saving…' : sessionId ? 'Apply to this session' : 'Save endpoint'}</button></div>
    </div>
  </div>, document.querySelector('.claude-root') || document.body);
}
