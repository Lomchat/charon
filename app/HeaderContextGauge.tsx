'use client';

import React from 'react';
import {
  contextUsagePercentage, contextWindowTokenLabel, type SessionContextUsage,
} from './sessionInsightState';

/** Compact, shared-context summary under the cwd in the session header. */
export default function HeaderContextGauge({
  context, onCompact, compacting, compactDisabled, compactError,
}: {
  context: SessionContextUsage | null;
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
  const title = `Context window: ${rounded}% used · ${tokenLabel} tokens`;
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
