'use client';

import React from 'react';
import {
  contextUsagePercentage, contextWindowTokenLabel, type SessionContextUsage,
} from './sessionInsightState';
import type { CacheReading } from '@/lib/promptCache';
import { CacheGaugeMark } from './PromptCacheMarks';

/** Compact, shared-context summary under the cwd in the session header.
 *
 *  The row is there from the first frame, whatever the reading: its compact
 *  button must not wait for a provider RPC (cold hub, sleeping session), and
 *  the header must not jump when the reading lands. Without figures the track
 *  stays empty — `…` while one is being read, `—` when none comes. A stored
 *  reading (`lastKnown`, lib/contextReading.ts) shows dimmed. */
export default function HeaderContextGauge({
  context, loading, cache, onCompact, compacting, compactDisabled, compactError,
}: {
  context: SessionContextUsage | null;
  /** A reading is on its way (the hook's `loading`). */
  loading: boolean;
  /** The prompt cache as of now (lib/promptCache.ts): a marker after the
   *  token count — what the row shows will be re-read, this says at what price. */
  cache?: CacheReading | null;
  /** Null: the backend has no compaction (§14.102) — no button. */
  onCompact: (() => void | Promise<void>) | null;
  compacting: boolean;
  compactDisabled: boolean;
  compactError?: string | null;
}) {
  const percentage = context?.ok ? contextUsagePercentage(context) : null;
  const tokenLabel = context?.ok ? contextWindowTokenLabel(context) : null;
  const known = percentage != null && !!tokenLabel;
  const rounded = known ? Math.round(percentage) : null;
  const lastKnown = known && context?.lastKnown === true;
  const title = known
    ? `Context window\n${rounded}% used\n${tokenLabel} tokens${lastKnown ? `\nlast known${context?.asleep ? ' (session asleep)' : ''}` : ''}`
    : loading ? 'Context window\nreading…' : 'Context window\nnot reported yet';
  return (
    <span className={`bar-context-row${known ? '' : ' is-empty'}${lastKnown ? ' is-last-known' : ''}`}>
      <span className="bar-context-meter" title={title}>
        <span className="bar-context-label">context</span>
        <span className="bar-context-track" role="progressbar"
          aria-label="Context window used" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={rounded == null ? undefined : Math.min(100, Math.max(0, rounded))}>
          {known && (
            <span className={`bar-context-fill${percentage >= 75 ? ' hot' : ''}`}
              style={{ width: `${Math.min(100, Math.max(2, percentage))}%` }} />
          )}
        </span>
        <b>{known ? `${rounded}%` : loading ? '…' : '—'}</b>
        {known && <span className="bar-context-tokens">{tokenLabel}</span>}
        <CacheGaugeMark reading={cache ?? null} />
      </span>
      {onCompact && (
        <button type="button" className="bar-context-compact"
          onClick={() => void onCompact()} disabled={compacting || compactDisabled}
          aria-label={compacting ? 'Compacting context' : 'Compact context'}
          title={compactDisabled ? 'Compaction needs an idle session' : 'Compact the model context now'}>
          {compacting ? '…' : 'compact'}
        </button>
      )}
      {compactError && <span className="bar-context-error" title={compactError}>failed</span>}
    </span>
  );
}
