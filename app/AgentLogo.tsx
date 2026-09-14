'use client';
// Small per-agent-kind logo chip. Multi-agent: a session is driven by one of
// the providers declared in lib/sessionCapabilities § SESSION_PROVIDERS. Both
// the artwork path and the display name come from that registry, so a new
// backend needs no edit here — only its logo dropped under public/agents/ and
// a `.agent-logo-<id>` rule in the stylesheet.
// Used by the sidebar session cards, the chat header badge and the per-message
// chip.
import type { AgentKind } from '@/lib/types/api';
import { PROVIDERS, asSessionProvider } from '@/lib/sessionCapabilities';
import { providerName } from '@/lib/providerText';

export default function AgentLogo({
  kind = 'claude', size = 16, className, title,
}: {
  kind?: AgentKind | null;
  size?: number;
  className?: string;
  /** Override the tooltip; defaults to the kind's display name. */
  title?: string;
}) {
  const k = asSessionProvider(kind);
  const label = providerName(k);
  return (
    <span
      className={`agent-logo agent-logo-${k}${className ? ' ' + className : ''}`}
      title={title ?? label}
      aria-label={label}
      style={{ ['--al-size' as any]: `${size}px` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={PROVIDERS[k].logo} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

/** @deprecated Use `providerName` from `@/lib/providerText` — one atom, one
 *  implementation. Kept so historical imports keep resolving. */
export const agentKindLabel = providerName;
