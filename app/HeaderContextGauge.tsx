'use client';

import React from 'react';
import {
  contextUsagePercentage, contextWindowTokenLabel, type SessionContextUsage,
} from './sessionInsightState';
import type { CacheReading } from '@/lib/promptCache';
import { CacheGaugeMark } from './PromptCacheMarks';

/** Compact, shared-context summary under the cwd in the session header. */
export default function HeaderContextGauge({
  context, cache, onCompact, compacting, compactDisabled, compactError,
}: {
  context: SessionContextUsage | null;
  /** The prompt cache as of now (lib/promptCache.ts): a marker after the
   *  token count — what the row shows will be re-read, this says at what price. */
  cache?: CacheReading | null;
  onCompact: () => void | Promise<void>;
  compacting: boolean;
  compactDisabled: boolean;
  compactError?: string | null;
}) {
  const percentage = contextUsagePercentage(context);
  const tokenLabel = contextWindowTokenLabel(context);
  // The header is an at-a-glance surface, not an error panel. Until both the
  // occupancy and its numerator/denominator exist, Tools carries the explicit
  // loading/unavailable explanation and the header keeps its normal height.
  if (!context?.ok || percentage == null || !tokenLabel) return null;
  const rounded = Math.round(percentage);
  const title = `Context window\n${rounded}% used\n${tokenLabel} tokens`;
  return (
    <span className="bar-context-row">
      <span className="bar-context-meter" title={title}>
        <span className="bar-context-label">context</span>
        <span className="bar-context-track" role="progressbar"
          aria-label="Context window used" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.min(100, Math.max(0, rounded))}>
          <span className={`bar-context-fill${percentage >= 75 ? ' hot' : ''}`}
            style={{ width: `${Math.min(100, Math.max(2, percentage))}%` }} />
        </span>
        <b>{rounded}%</b>
        <span className="bar-context-tokens">{tokenLabel}</span>
        <CacheGaugeMark reading={cache ?? null} />
      </span>
      <button type="button" className="bar-context-compact"
        onClick={() => void onCompact()} disabled={compacting || compactDisabled}
        aria-label={compacting ? 'Compacting context' : 'Compact context'}
        title={compactDisabled ? 'The session must be running and idle to compact' : 'Compact the model context now'}>
        {compacting ? '…' : 'compact'}
      </button>
      {compactError && <span className="bar-context-error" title={compactError}>failed</span>}
    </span>
  );
}
