// Shared quick-nav logic for the mobile UI — the mobile equivalent of the
// desktop TabBar (mobile has no tabs). Used in two places:
//   - app/m/select/MobileSelect.tsx  → the strip under the topbar (one row/VPS)
//   - app/m/chat/MobileChat.tsx       → the "all sessions" overlay (3rd header
//                                        button), same grouping by VPS
// Keep the grouping/labelling logic here so both surfaces stay in sync.

export const ACTIVE_STATUSES = new Set(['active', 'thinking', 'starting']);

export const DOT_CLASS: Record<string, string> = {
  active: 'dot-green',
  starting: 'dot-amber',
  thinking: 'dot-amber-pulse',
  sleeping: 'dot-gray',
  killed: 'dot-gray',
  error: 'dot-red',
  waiting: 'dot-orange-pulse',
};

export type QuickNavItem = {
  kind: 'session' | 'shell';
  id: string;
  label: string;
  dotClass: string;
  attention: boolean;
  title: string;
};

export type QuickNavGroup = {
  vpsId: string;
  vpsName: string;
  hasAttention: boolean;
  items: QuickNavItem[];
};

// Loose structural inputs so both the API types (SessionListItem / ShellInfo)
// and the page-local copies satisfy them without casts.
type QuickNavSession = {
  id: string;
  vpsId: string;
  cwd: string;
  name: string | null;
  status: string;
  liveStatus?: string | null;
  pendingPermissions?: number | null;
  firstUserMessage?: string | null;
};
type QuickNavShell = {
  id: string;
  vpsId: string;
  cwd: string | null;
  name: string | null;
  exited: boolean;
  // Live activity (agent >= 0.9.0): 'busy' → amber-pulse dot (mobile parity
  // with the desktop "thinking" tab). undefined/'active' = idle/at-prompt.
  liveStatus?: 'active' | 'busy' | null;
};
type QuickNavVps = {
  id: string;
  name: string;
  position?: number;
};

function lastSegment(p: string): string {
  return p.split('/').filter(Boolean).slice(-1)[0] || p;
}

// Build the per-VPS groups of "live" entities (active/thinking/starting Claude
// sessions or ones awaiting a permission, plus non-exited shells). Within a
// group, attention items (pending permission) come first; groups that contain
// an attention item are hoisted above the rest, otherwise VPS order (the order
// of `vpsList`, which the caller sorts by `position`) is preserved.
export function computeQuickNavGroups(
  sessions: QuickNavSession[],
  shells: QuickNavShell[],
  vpsList: QuickNavVps[],
): QuickNavGroup[] {
  const vpsName = new Map(vpsList.map((v) => [v.id, v.name] as const));
  const vpsRank = new Map(vpsList.map((v, i) => [v.id, i] as const));

  const byVps = new Map<string, QuickNavItem[]>();
  const push = (vpsId: string, item: QuickNavItem) => {
    const arr = byVps.get(vpsId);
    if (arr) arr.push(item);
    else byVps.set(vpsId, [item]);
  };

  for (const s of sessions) {
    const base = String(s.liveStatus ?? s.status);
    const attention = (s.pendingPermissions ?? 0) > 0;
    if (!ACTIVE_STATUSES.has(base) && !attention) continue;
    const effective = attention && base === 'active' ? 'waiting' : base;
    const preview = (s.firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
    const label = s.name?.trim() || (preview ? preview.slice(0, 26) : lastSegment(s.cwd));
    push(s.vpsId, {
      kind: 'session',
      id: s.id,
      label,
      dotClass: DOT_CLASS[effective] ?? 'dot-gray',
      attention,
      title: `${vpsName.get(s.vpsId) ?? ''} · ${s.cwd}`.trim(),
    });
  }

  for (const sh of shells) {
    if (sh.exited) continue;
    push(sh.vpsId, {
      kind: 'shell',
      id: sh.id,
      label: sh.name?.trim() || (sh.cwd ? lastSegment(sh.cwd) : '~'),
      dotClass: sh.liveStatus === 'busy' ? 'dot-amber-pulse' : 'dot-cyan',
      attention: false,
      title: `${vpsName.get(sh.vpsId) ?? ''} · shell · ${sh.cwd ?? '~'}`.trim(),
    });
  }

  const groups: QuickNavGroup[] = [];
  for (const [vpsId, items] of byVps) {
    // Stable sort: attention items float up; sessions stay before shells and
    // keep their incoming (recency) order otherwise.
    items.sort((a, b) => Number(b.attention) - Number(a.attention));
    groups.push({
      vpsId,
      vpsName: vpsName.get(vpsId) ?? vpsId,
      hasAttention: items.some((i) => i.attention),
      items,
    });
  }
  groups.sort((a, b) => {
    if (a.hasAttention !== b.hasAttention) return Number(b.hasAttention) - Number(a.hasAttention);
    return (vpsRank.get(a.vpsId) ?? 1e9) - (vpsRank.get(b.vpsId) ?? 1e9);
  });
  return groups;
}

// Shared chip — same look on both surfaces. `active` marks the current session
// in the chat overlay (no-op on the select strip).
export function QuickNavChip({
  item, active, onClick,
}: {
  item: QuickNavItem;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`m-quick-chip ${item.kind}${item.attention ? ' attention' : ''}${active ? ' current' : ''}`}
      onClick={onClick}
      title={item.title}
    >
      <span className={`m-quick-dot ${item.dotClass}`} />
      <span className="m-quick-label">{item.label}</span>
    </button>
  );
}
