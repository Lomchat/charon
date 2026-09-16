'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';
import { ENDPOINT_ENGINES, endpointModelCheck, endpointModels, normalizeEndpointUrl, type CustomEndpoint, type EndpointAuth, type EndpointEngine, type EndpointInput } from '@/lib/customEndpoints';
import { providerName } from '@/lib/providerText';
import type { Vps } from '@/lib/types/api';
import type { EndpointProbeResponse } from '@/lib/types/api';
import PickerControl, { PickerOption } from './PickerControl';
import EndpointModelPicker from './EndpointModelPicker';
import AgentLogo from './AgentLogo';
import { IconPlug } from './icons';

export default function CustomEndpointModal({ sessionId, engine: initialEngine, vpsId: initialVpsId, vpsList = [], initial, editingId, focusTest, onClose, onApplied }: {
  sessionId?: string; engine: EndpointEngine; vpsId?: string; vpsList?: Vps[];
  initial?: CustomEndpoint | null; editingId?: string; focusTest?: boolean;
  onClose: () => void; onApplied: () => void;
}) {
  const [engine, setEngine] = useState(initialEngine);
  const [vpsId, setVpsId] = useState(initialVpsId || vpsList.find((v) => v.id === initial?.checks?.[initialEngine]?.vpsId)?.id || vpsList[0]?.id || '');
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
  const [modelInputMode, setModelInputMode] = useState<'list' | 'manual'>(initial?.models?.length ? 'list' : 'manual');
  const [saveForReuse, setSaveForReuse] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(!initial);
  const [authOpen, setAuthOpen] = useState(!initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EndpointProbeResponse | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const busyRef = useRef(busy); busyRef.current = busy;
  const source = savedId ? saved.find((e) => e.id === savedId) || (savedId === editingId ? initial : undefined)
    : useSessionCredential ? initial : undefined;
  let normalizedUrl = baseUrl.trim();
  try { normalizedUrl = normalizeEndpointUrl(baseUrl); } catch { /* The form still shows an incomplete URL. */ }
  const sameConnection = !!source && normalizedUrl === source.baseUrl && auth === source.auth
    && !token && (auth === 'none' || hasToken);
  const showSave = !!sessionId && (!sameConnection || name.trim() !== source?.name);
  const showAuth = authOpen || !source || (auth !== 'none' && !hasToken);
  useEffect(() => {
    api.listCustomEndpoints().then((r) => setSaved(r.endpoints)).catch((e) => setError(e.message));
    const previous = document.activeElement as HTMLElement | null;
    if (focusTest) testButton.current?.focus();
    else dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
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
    const choices = endpoint ? endpointModels(endpoint, engine) : [];
    setModel(choices.find((m) => m.id === endpoint?.model)?.id || choices[0]?.id || endpoint?.model || '');
    setModelInputMode(choices.length ? 'list' : 'manual');
    setDetailsOpen(!endpoint); setAuthOpen(!endpoint); setSaveForReuse(false);
    setModels(endpoint?.models || []); changed();
  }
  function changeUrl(value: string) {
    let matchesSource = false;
    try { matchesSource = normalizeEndpointUrl(value) === source?.baseUrl && auth === source?.auth; } catch { /* Typing. */ }
    setBaseUrl(value); setHasToken(matchesSource && !!source?.hasToken); setToken('');
    setModels(matchesSource ? source?.models || [] : []);
    setModelInputMode(matchesSource && source?.models?.length ? 'list' : 'manual'); changed();
  }
  function payload(): EndpointInput {
    return { name, baseUrl, auth, model, ...(savedId ? { savedId } : {}),
      useSessionCredential, ...(token || !hasToken ? { token } : {}) };
  }
  async function probe(action: 'models' | 'test') {
    setBusy(action); setError(null); setResult(null);
    try {
      const r = await api.probeCustomEndpoint({ endpoint: payload(), engine, vpsId, sessionId, action });
      if (r.models?.length) {
        setModels(r.models.map((m) => ({ ...m, checks: models.find((previous) => previous.id === m.id)?.checks })));
        if (action === 'models') setModelInputMode('list');
      }
      setResult(r);
      if (!model && r.models?.length) setModel(r.models[0].id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Connection test failed.'); }
    finally { setBusy(null); }
  }
  async function apply() {
    setBusy('save'); setError(null);
    try {
      if (sessionId) await api.setSessionEndpoint(sessionId, { endpoint: payload(), saveForReuse: showSave && saveForReuse });
      else await api.saveCustomEndpoint({ endpoint: payload(), id: editingId, vpsId });
      onApplied(); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save endpoint.'); }
    finally { setBusy(null); }
  }
  const valid = !!baseUrl.trim() && !!model.trim() && (auth === 'none' || !!token || hasToken);
  const savedCheck = sameConnection ? endpointModelCheck(source, engine, model) : undefined;
  const check = result?.check || (!error && savedCheck?.vpsId === vpsId ? savedCheck : undefined);
  const parameters = models.find((m) => m.id === model)?.parameters?.[engine];
  const parameterInfo = check?.ok && parameters
    ? parameters.length ? parameters.map((p) => p.label).join(' · ') : 'No adjustable parameters'
    : check?.ok && check.effortLevels?.length ? check.effortLevels.join(' · ') : 'Model default · support unknown';
  const modelChoices = endpointModels({ name, baseUrl, auth, model, models }, engine);
  const showModelList = modelInputMode === 'list' && modelChoices.length > 0;
  const title = sessionId ? 'Custom endpoint' : editingId ? 'Edit endpoint' : 'New endpoint';
  const testState = busy === 'test' ? 'Testing…' : check?.ok ? 'API verified' : check ? 'Test failed' : 'Not tested';
  return createPortal(<div className="claude-modal-bg endpoint-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="claude-modal endpoint-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="endpoint-modal-title" aria-busy={!!busy}>
      <div className="endpoint-modal-head"><span className="endpoint-card-icon"><IconPlug /></span><div><h2 id="endpoint-modal-title">{title}</h2><p className="set-meta">{sessionId ? `Use your own model in this ${providerName(engine)} session.` : editingId ? 'Update this saved model connection.' : 'Connect a self-hosted model or another provider.'}</p></div><button type="button" className="endpoint-btn is-icon" onClick={onClose} disabled={!!busy} aria-label="Close endpoint dialog">×</button></div>
      <div className="endpoint-modal-body">
        {sessionId && <div className="endpoint-source"><label>Connection<PickerControl aria-label="Connection" value={savedId} disabled={!!busy} onValueChange={chooseSaved}>
          <option value="">{useSessionCredential ? 'Current session connection' : 'New endpoint'}</option>
          {saved.map((e) => <option key={e.id} value={e.id}><PickerOption title={e.name} sub={e.baseUrl} /></option>)}
        </PickerControl></label>{useSessionCredential && <button type="button" className="endpoint-btn" onClick={() => chooseSaved('')} disabled={!!busy}>New endpoint</button>}</div>}
        <section className="endpoint-form-section" aria-label="Connection details">
          <div className="endpoint-connection-card">
            {source && <div className="endpoint-connection-summary"><div><strong>{name || 'Endpoint connection'}</strong><span title={baseUrl}>{baseUrl}</span></div>
              <button type="button" className="endpoint-text-btn" aria-expanded={detailsOpen} aria-controls="endpoint-connection-details" disabled={!!busy} onClick={() => setDetailsOpen(!detailsOpen)}>{detailsOpen ? 'Done' : 'Edit details'}</button></div>}
            {(detailsOpen || !source) && <div className="endpoint-connection-fields" id="endpoint-connection-details">
              <label><span>Display name <small>(optional)</small></span><input value={name} maxLength={100} placeholder="My inference server" disabled={!!busy} onChange={(e) => setName(e.target.value)} /></label>
              <label>Base URL<input value={baseUrl} placeholder="https://models.example.com" autoComplete="off" spellCheck={false} disabled={!!busy} onChange={(e) => changeUrl(e.target.value)} /></label>
            </div>}
            {source && <button type="button" className="endpoint-text-btn endpoint-auth-toggle" aria-expanded={showAuth} aria-controls="endpoint-auth-fields" disabled={!!busy} onClick={() => setAuthOpen(!showAuth)}>{showAuth ? 'Authentication' : 'Change authentication'}<span aria-hidden="true">{showAuth ? '−' : '+'}</span></button>}
            {showAuth && <div className="endpoint-auth-fields" id="endpoint-auth-fields"><label>Authentication<PickerControl aria-label="Authentication" value={auth} disabled={!!busy} onValueChange={(v) => {
              setAuth(v as EndpointAuth); setHasToken(v === source?.auth && normalizedUrl === source?.baseUrl && !!source?.hasToken); setToken(''); changed();
            }}>
              <option value="none">None</option><option value="api-key">API key (x-api-key)</option><option value="bearer">Bearer token (Authorization)</option>
            </PickerControl></label>
              {auth !== 'none' && <label>Token<input className="endpoint-token" type="text" value={token} autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true"
                placeholder={hasToken ? 'Keep saved token' : 'API key or token'} disabled={!!busy} onChange={(e) => { setToken(e.target.value); changed(); }} /></label>}
            </div>}
          </div>
          <div className="endpoint-model-heading"><label htmlFor="endpoint-model-id">Model ID</label>
            <div className="endpoint-model-mode" role="group" aria-label="Model input mode">
              <button type="button" aria-pressed={showModelList} disabled={!!busy || !modelChoices.length} title={modelChoices.length ? 'Choose a model from the list' : 'Load models to enable the list'} onClick={() => setModelInputMode('list')}>List</button>
              <button type="button" aria-pressed={!showModelList} disabled={!!busy} onClick={() => setModelInputMode('manual')}>Custom ID</button>
            </div>
          </div>
          <div className="endpoint-model-field">{showModelList
            ? <EndpointModelPicker id="endpoint-model-id" aria-label="Model ID" endpoint={{ name, baseUrl, auth, model, models }} kind={engine} value={model} disabled={!!busy} onChange={(v) => { setModel(v); changed(); }} />
            : <input id="endpoint-model-id" value={model} placeholder="Exact model ID" maxLength={256} autoComplete="off" spellCheck={false} disabled={!!busy} onChange={(e) => { setModel(e.target.value); changed(); }} />}
            <button type="button" className="endpoint-btn" disabled={!!busy || !baseUrl || !vpsId || (auth !== 'none' && !token && !hasToken)} onClick={() => probe('models')}>{busy === 'models' ? 'Loading…' : 'Load models'}</button></div>
          {result && !result.check && <p className="set-meta" role="status">{result.models.length ? `${result.models.length} models found. Choose a model above.` : result.catalogError}</p>}
        </section>
        <section className="endpoint-form-section endpoint-compatibility" aria-label="Compatibility">
          <div className="endpoint-compatibility-head"><div><div className="endpoint-section-title">Compatibility <span className={`endpoint-test-state${check ? check.ok ? ' is-verified' : ' is-failed' : ''}`} role="status">{testState}</span></div>
            <p className="set-meta endpoint-protocol"><AgentLogo kind={engine} size={14} />{providerName(engine)} · {engine === 'claude' ? 'Messages' : 'Responses'} API</p></div>
            <button ref={testButton} type="button" className="endpoint-btn" disabled={!!busy || !valid || !vpsId} onClick={() => probe('test')}>{busy === 'test' ? 'Testing…' : check ? 'Test again' : 'Test connection'}</button></div>
          {!sessionId && <div className="endpoint-test-target"><label>Test with<PickerControl aria-label="Test with" value={engine} disabled={!!busy} onValueChange={(v) => { setEngine(v as EndpointEngine); changed(); }}>{ENDPOINT_ENGINES.map((v) => <option key={v} value={v}>{providerName(v)}</option>)}</PickerControl></label>
            <label>VPS<PickerControl aria-label="VPS" value={vpsId} disabled={!!busy} onValueChange={(v) => { setVpsId(v); changed(); }}>{vpsList.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</PickerControl></label></div>}
          <div className="endpoint-test-chips" aria-label="Test results">{[
            { label: 'Streaming', ok: check?.streaming }, { label: 'Tool calls + results', ok: check?.tools },
          ].map((fact) => <span key={fact.label} className={`endpoint-test-chip${fact.ok ? ' is-verified' : check ? ' is-failed' : ''}`} title={check ? fact.ok ? 'Verified' : 'Not verified' : 'Not tested'}>
            <span aria-hidden="true">{check ? fact.ok ? '✓' : '×' : '○'}</span>{fact.label}<span className="sr-only">: {check ? fact.ok ? 'Verified' : 'Not verified' : 'Not tested'}</span></span>)}</div>
          <p className="endpoint-parameter-info"><span>Parameters</span>{parameterInfo}</p>
          {check?.error && <p className="endpoint-error" role="alert">{check.error}</p>}
          <p className="set-meta endpoint-test-scope">API check from your VPS. Full sessions and every tool are not tested.</p>
        </section>
        {showSave && <div className="endpoint-save-option"><div><strong>{source ? 'Save as a new endpoint' : 'Save for reuse'}</strong><p className="set-meta">{source ? 'Keep these changes as a separate saved connection.' : 'Make this connection available in other sessions.'}</p></div><button type="button" role="switch" aria-label="Save for reuse" aria-checked={saveForReuse} className={`toggle${saveForReuse ? ' on' : ''}`} disabled={!!busy} onClick={() => setSaveForReuse(!saveForReuse)}><span className="knob" /></button></div>}
        {error && <p className="endpoint-error" role="alert">{error}</p>}
      </div>
      <div className="endpoint-modal-foot"><p className="set-meta">{sessionId ? 'Applies to this session after its current work finishes.' : 'Existing sessions keep their current connection.'}</p><div className="modal-actions"><button type="button" onClick={onClose} disabled={!!busy}>Cancel</button><button type="button" className="primary" onClick={apply} disabled={!!busy || !valid || (!!sessionId && !!result?.check && !result.ok)}>{busy === 'save' ? 'Saving…' : sessionId ? 'Apply to this session' : editingId ? 'Save changes' : 'Add endpoint'}</button></div></div>
    </div>
  </div>, document.querySelector('.claude-root') || document.body);
}
