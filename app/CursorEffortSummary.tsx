'use client';
import { useEffect, useState } from 'react';
import type { CursorModel } from '@/lib/types/api';
import { getCursorModels, peekCursorModels } from './cursorModelsCache';
import { effectiveParams } from './cursorEffort';

/**
 * The header's read-only view of a parameter-set effort (§14.103): ONE LINE PER
 * KNOB, the knob's name muted and its VALUE carrying the weight — the value is
 * what the reader came for, the name is only the label that identifies it.
 *
 * Only the knobs the selected model declares are listed; `cursorEffort.ts`
 * explains why a session can hold others. The button's `title` still carries
 * the stored column verbatim, so nothing is hidden, only ranked.
 */
export default function CursorEffortSummary({ vpsId, modelId, effort }: {
  vpsId: string;
  modelId: string;
  effort: string | null;
}) {
  const [models, setModels] = useState<CursorModel[]>(
    () => peekCursorModels(vpsId)?.models ?? [],
  );

  useEffect(() => {
    let cancelled = false;
    getCursorModels(vpsId).then((r) => {
      if (!cancelled) setModels(r.models ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [vpsId]);

  const model = models.find((m) => m.id === modelId.split('?')[0].trim()) ?? null;
  const params = Object.entries(effectiveParams(model, modelId, effort));
  if (!params.length) return <span>Default</span>;
  return (
    <span className="runtime-effort-params">
      {params.map(([key, value]) => (
        <span key={key} className="runtime-effort-param">
          {key}: <b>{value}</b>
        </span>
      ))}
    </span>
  );
}
