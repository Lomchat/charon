'use client';
import { useEffect, useState } from 'react';
import type { CodexModelPick, KnownClaudeModel } from '@/lib/types/api';
import { CANONICAL_EFFORTS, CODEX_CANONICAL_EFFORTS } from '@/lib/types/api';
import { getModels, getEfforts, peekModels, peekEfforts } from './modelsCache';
import { getCodexModels, peekCodexModels } from './codexModelsCache';

// The effort levels a default can take, as the pickers compute them: the
// model's own ladder when it is known, else the catalog's union, else the
// canonical list. A stored value the list lacks stays offered.

const keep = (levels: string[], value: string) => (value && !levels.includes(value) ? [...levels, value] : levels);

export function useClaudeEffortLevels(modelId: string, value: string): string[] {
  const [models, setModels] = useState<KnownClaudeModel[]>(() => peekModels() ?? []);
  const [union, setUnion] = useState<string[]>(() => peekEfforts() ?? [...CANONICAL_EFFORTS]);
  useEffect(() => {
    let cancelled = false;
    getModels().then((m) => { if (!cancelled) setModels(m); }).catch(() => {});
    getEfforts().then((e) => { if (!cancelled) setUnion(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const own = modelId ? models.find((m) => m.id === modelId)?.efforts : undefined;
  return keep(Array.isArray(own) && own.length ? own : (union.length ? union : [...CANONICAL_EFFORTS]), value);
}

export function useCodexEffortLevels(vpsId: string, modelId: string, value: string, profile = 'default'): string[] {
  const [models, setModels] = useState<CodexModelPick[]>(() => peekCodexModels(vpsId, profile)?.models ?? []);
  const [union, setUnion] = useState<string[]>(() => peekCodexModels(vpsId, profile)?.efforts ?? [...CODEX_CANONICAL_EFFORTS]);
  useEffect(() => {
    if (!vpsId) return;
    let cancelled = false;
    getCodexModels(vpsId, profile).then((r) => {
      if (cancelled) return;
      setModels(r.models ?? []);
      setUnion(r.efforts?.length ? r.efforts : [...CODEX_CANONICAL_EFFORTS]);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [vpsId, profile]);
  const own = modelId ? models.find((m) => m.id === modelId)?.efforts : undefined;
  return keep(Array.isArray(own) && own.length ? own : (union.length ? union : [...CODEX_CANONICAL_EFFORTS]), value);
}
