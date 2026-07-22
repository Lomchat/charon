'use client';
// Small per-agent-kind logo chip. Multi-agent support: a session is driven by
// either Claude (Claude Agent SDK) or Codex (OpenAI). The logos live in
// public/agents/{claude,codex}.png (128×128). Rendered on a small rounded chip
// so both stay legible on the parchment/stone theme background — used in the
// sidebar session cards, the chat header badge, and the per-message chip.
import type { AgentKind } from '@/lib/types/api';

const SRC: Record<AgentKind, string> = {
  claude: '/agents/claude.png',
  codex: '/agents/codex.png',
};
const LABEL: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export default function AgentLogo({
  kind = 'claude', size = 16, className, title,
}: {
  kind?: AgentKind | null;
  size?: number;
  className?: string;
  /** Override the tooltip; defaults to the kind's display name. */
  title?: string;
}) {
  const k: AgentKind = kind === 'codex' ? 'codex' : 'claude';
  return (
    <span
      className={`agent-logo agent-logo-${k}${className ? ' ' + className : ''}`}
      title={title ?? LABEL[k]}
      aria-label={LABEL[k]}
      style={{ ['--al-size' as any]: `${size}px` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={SRC[k]} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

export function agentKindLabel(kind?: AgentKind | null): string {
  return LABEL[kind === 'codex' ? 'codex' : 'claude'];
}
