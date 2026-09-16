'use client';
import PickerControl, { PickerOption } from './PickerControl';
import { endpointModels, endpointParameters, type CustomEndpoint, type EndpointModel } from '@/lib/customEndpoints';
import { modelAxes } from '@/lib/modelParams';
import { formatPrice, priceTier } from '@/lib/modelPricing';
import { endpointModelFamily, groupEndpointModels, isNewEndpointModel } from '@/lib/endpointModelCatalog';

const tokens = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${+(n / 1000).toFixed(1)}K`;
export default function EndpointModelPicker({ endpoint, kind, value, onChange, presentation, disabled, id, 'aria-label': label }: {
  endpoint: CustomEndpoint; kind: string; value: string; onChange: (id: string) => void;
  presentation?: 'select' | 'list'; disabled?: boolean; id?: string; 'aria-label'?: string;
}) {
  const models = [...endpointModels(endpoint, kind)];
  if (value && !models.some((m) => m.id === value)) models.unshift(endpoint.models?.find((m) => m.id === value) || { id: value });
  const now = Date.now();
  return <PickerControl id={id} aria-label={label} presentation={presentation} disabled={disabled} value={value} onValueChange={onChange}>
    {!value && <option value="" disabled>Choose a model</option>}
    {groupEndpointModels(models, now).map((group) => <optgroup key={group.label} label={group.label}>
      {group.models.map((m) => <option key={m.id} value={m.id} data-search={`${m.id} ${m.info?.name || ''} ${endpointModelFamily(m)} ${m.info?.description || ''}`}>
        <EndpointModelOption model={m} endpoint={endpoint} kind={kind} isNew={isNewEndpointModel(m, now)} />
      </option>)}
    </optgroup>)}
  </PickerControl>;
}
function EndpointModelOption({ model: m, endpoint, kind, isNew }: { model: EndpointModel; endpoint: CustomEndpoint; kind: string; isNew: boolean }) {
  const info = m.info;
  const tier = priceTier(info?.price);
  const price = formatPrice(info?.price);
  const facts = modelAxes({ id: m.id, label: info?.name || m.id, parameters: endpointParameters(endpoint, kind, m.id) }).facts;
  return <PickerOption title={<>{info?.name || m.id}{isNew && <span className="endpoint-model-new" title={`Released ${info?.releaseDate}`}>New</span>}{tier && <span className="picker-tier">{tier}</span>}</>} sub={[
    info?.name && info.name !== m.id ? m.id : null,
    price ? `Catalog base rate · ${price}` : null,
    m.contextWindow ? `${tokens(m.contextWindow)} context` : null,
    info?.outputTokens ? `${tokens(info.outputTokens)} max output` : null,
    info?.input?.length ? `Input: ${info.input.join(', ')}` : null,
    ...facts,
    info?.reasoning && !facts.length ? 'Reasoning · model default' : null,
    info?.tieredPrice ? 'Higher rates for long context' : null,
    info?.description || null,
  ]} />;
}
