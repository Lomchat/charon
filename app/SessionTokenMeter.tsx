'use client';

import { useEffect, useRef, useState } from 'react';
import type { SessionTokenUsage } from '@/lib/sessionTokenUsage';

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat('en');

export default function SessionTokenMeter({ usage }: { usage: SessionTokenUsage | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); button.current?.focus(); e.stopPropagation(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  const fields = [
    { label: 'Sent', value: usage?.inputTokens, missing: usage?.missingInput },
    { label: 'Received', value: usage?.outputTokens, missing: usage?.missingOutput },
    { label: 'Total', value: usage?.totalTokens, missing: usage?.missingTotal },
  ];
  const format = (f: typeof fields[number], full = false) => f.value == null ? '—'
    : `${usage?.partial || f.missing ? '≥ ' : ''}${(full ? exact : compact).format(f.value)}`;
  const totalOnly = usage?.inputTokens == null && usage?.outputTokens == null && usage?.totalTokens != null;
  const partial = !!usage && (usage.partial || usage.missingTotal > 0);
  return <div ref={root} className="runtime-token-usage">
    <button ref={button} type="button" className="runtime-cell runtime-usage-button runtime-token-button"
      aria-label="Session token usage" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="runtime-token-rows">
        {totalOnly ? <>
          <span className="runtime-token-row"><span>Tokens</span><b>{format(fields[2])}</b></span>
          <span className="runtime-token-note">No input/output detail</span>
        </> : fields.slice(0, 2).map((f, i) => <span key={f.label} className="runtime-token-row">
          <span><span aria-hidden="true">{i === 0 ? '↑' : '↓'}</span> {f.label}</span><b>{format(f)}</b>
        </span>)}
      </span>
    </button>
    {open && <div className="runtime-choice-popover runtime-token-popover" role="region" aria-label="Recorded session tokens">
      <strong>Session tokens</strong>
      <dl>{fields.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{format(f, true)}</dd></div>)}</dl>
      <p>Recorded across this session. Sent tokens include context sent again with each request and cached input. Received tokens include reasoning when reported.</p>
      {totalOnly && <p>The endpoint reports a total only, without separate input and output counts.</p>}
      {!usage || (usage.inputTokens == null && usage.outputTokens == null && usage.totalTokens == null)
        ? <p>No token counts reported yet. Unavailable usage is shown as —.</p> : null}
      {partial && <p>Partial history: ≥ marks the recorded minimum. Earlier or interrupted requests may have unreported usage.</p>}
      {usage?.requests ? <p className="runtime-token-note">{exact.format(usage.requests)} recorded {usage.requests === 1 ? 'request' : 'requests'}{usage.legacyTurns ? ` · ${exact.format(usage.legacyTurns)} older turns` : ''}</p> : null}
    </div>}
  </div>;
}
