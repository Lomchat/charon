'use client';
import type { AgentKind } from '@/lib/types/api';
import { asSessionProvider } from '@/lib/sessionCapabilities';
import type { CacheReading } from '@/lib/promptCache';
import AgentLogo from './AgentLogo';
import { CacheGaugeMark } from './PromptCacheMarks';
import { contextUsagePercentage, type SessionContextUsage } from './sessionInsightState';
import { UsageRingsInline } from './UsageMeter';
import { useUsage } from './usageStore';

/** An effort that is a parameter set (`effort=high&fast=false`, §14.103)
 *  reads as its `effort` knob, else its first value: one word on one line. */
function effortWord(effort: string | null): string {
  if (!effort) return 'default';
  if (!effort.includes('=')) return effort;
  const params = new URLSearchParams(effort);
  return params.get('effort') ?? params.values().next().value ?? effort;
}

const CTX_R = 5;
const CTX_C = 2 * Math.PI * CTX_R;

/** The context window as a small ring (the full panel's strip, drawn round). */
function ContextRing({ pct }: { pct: number | null }) {
  const used = pct == null ? 0 : Math.min(100, Math.max(0, pct)) / 100;
  return (
    <svg className={`rs-ctx-ring${pct == null ? ' is-empty' : ''}${pct != null && pct >= 75 ? ' hot' : ''}`} viewBox="0 0 13 13" aria-hidden="true">
      <circle className="rs-ctx-track" cx="6.5" cy="6.5" r={CTX_R} />
      {used > 0 && <circle className="rs-ctx-arc" cx="6.5" cy="6.5" r={CTX_R}
        strokeDasharray={`${CTX_C * used} ${CTX_C}`} transform="rotate(-90 6.5 6.5)" />}
    </svg>
  );
}

/**
 * The reduced session header's one-line summary of its runtime panel: model ·
 * effort · context · account usage. Display only — the whole pill is ONE
 * button, and it opens the full panel (which keeps every picker) under it.
 */
export default function RuntimeSummary({
  kind, profileNumber, modelLabel, endpointName, effort, showEffort, context, showContext, cache,
  vpsId, accountProfile, showUsage, open, onToggle,
}: {
  kind: AgentKind;
  profileNumber?: number;
  modelLabel: string;
  /** A custom endpoint's name (its logo badge). */
  endpointName?: string;
  effort: string | null;
  /** The provider has an effort axis (§14.102). */
  showEffort: boolean;
  context: SessionContextUsage | null;
  /** The provider reports context occupancy. */
  showContext: boolean;
  cache: CacheReading | null;
  vpsId: string;
  accountProfile: string;
  /** Account usage applies (no custom endpoint: that one bills per token). */
  showUsage: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const usage = useUsage(vpsId, asSessionProvider(kind), accountProfile);
  const pct = context?.ok ? contextUsagePercentage(context) : null;
  return (
    <button type="button" className={`runtime-summary${open ? ' is-open' : ''}`} onClick={onToggle}
      aria-expanded={open} aria-label="Model, effort, context and usage" title={open ? undefined : 'Model, effort, context and usage'}>
      <span className="rs-model">
        <AgentLogo kind={kind} profileNumber={profileNumber} size={13} endpointName={endpointName} title="" />
        <b className="rs-model-name">{modelLabel}</b>
      </span>
      {showEffort && <span className="rs-effort"><span className="rs-effort-symbol" aria-hidden="true">✦</span>{effortWord(effort)}</span>}
      {showContext && (
        <span className="rs-ctx">
          <ContextRing pct={pct} />
          <b>{pct == null ? '—' : `${Math.round(pct)}%`}</b>
          <CacheGaugeMark reading={cache} />
        </span>
      )}
      {showUsage && <span className="rs-usage"><UsageRingsInline usage={usage} kind={kind} /></span>}
      <span className="rs-caret" aria-hidden="true">▾</span>
    </button>
  );
}
