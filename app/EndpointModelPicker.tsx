'use client';
import PickerControl, { PickerOption } from './PickerControl';
import { endpointModels, endpointParameters, type CustomEndpoint, type EndpointModel } from '@/lib/customEndpoints';
import { modelAxes } from '@/lib/modelParams';
import { formatPrice, priceTier } from '@/lib/modelPricing';

const tokens = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${+(n / 1000).toFixed(1)}K`;
export default function EndpointModelPicker({ endpoint, kind, value, onChange, presentation, disabled, id, 'aria-label': label }: {
  endpoint: CustomEndpoint; kind: string; value: string; onChange: (id: string) => void;
  presentation?: 'select' | 'list'; disabled?: boolean; id?: string; 'aria-label'?: string;
}) {
  const models = [...endpointModels(endpoint, kind)];
  if (value && !models.some((m) => m.id === value)) models.unshift({ id: value });
  return <PickerControl id={id} aria-label={label} presentation={presentation} disabled={disabled} value={value} onValueChange={onChange}>
    {!value && <option value="" disabled>Choose a model</option>}
    {models.map((m) => <option key={m.id} value={m.id} data-search={`${m.id} ${m.info?.name || ''} ${m.info?.description || ''}`}>
      <EndpointModelOption model={m} endpoint={endpoint} kind={kind} />
    </option>)}
  </PickerControl>;
}
function EndpointModelOption({ model: m, endpoint, kind }: { model: EndpointModel; endpoint: CustomEndpoint; kind: string }) {
  const info = m.info;
  const tier = priceTier(info?.price);
  const price = formatPrice(info?.price);
  const facts = modelAxes({ id: m.id, label: info?.name || m.id, parameters: endpointParameters(endpoint, kind, m.id) }).facts;
  return <PickerOption title={<>{info?.name || m.id}{tier && <span className="picker-tier">{tier}</span>}</>} sub={[
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
