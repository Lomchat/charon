'use client';
import PickerControl from './PickerControl';
import { changeEndpointParam, endpointParameters, endpointParamValues, type CustomEndpoint } from '@/lib/customEndpoints';
import { encodeModelParams, paramLabel, paramValueLabel } from '@/lib/modelParams';

type Props = { endpoint: CustomEndpoint; kind: string; model: string; effort: string | null };
export default function EndpointEffortPicker({ endpoint, kind, model, effort, disabled, onChange }: Props & {
  disabled?: boolean; onChange: (value: string) => void;
}) {
  const parameters = endpointParameters(endpoint, kind, model);
  const current = encodeModelParams(endpointParamValues(effort));
  return <PickerControl presentation="list" value={current} disabled={disabled} onValueChange={onChange}>
    <option value="">Model default</option>
    {parameters.map((p) => <optgroup key={p.id} label={paramLabel(p)}>
      {p.values.map((v) => <option key={v.value} value={changeEndpointParam(effort, p.id, v.value)}>{paramValueLabel(p, v.value)}</option>)}
    </optgroup>)}
  </PickerControl>;
}
export function EndpointEffortSummary({ endpoint, kind, model, effort }: Props) {
  const values = endpointParamValues(effort);
  const params = endpointParameters(endpoint, kind, model).filter((p) => values[p.id] != null);
  if (!params.length) return <span>Default</span>;
  return <span className="runtime-effort-params">{params.map((p) => <span key={p.id} className="runtime-effort-param">
    {paramLabel(p)}: <b>{paramValueLabel(p, values[p.id])}</b>
  </span>)}</span>;
}
