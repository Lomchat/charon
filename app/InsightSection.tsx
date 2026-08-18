'use client';

import { type ReactNode, useState } from 'react';

/** Shared disclosure used by every section of the Tools inspector. */
export default function InsightSection({
  title, meta, defaultOpen = false, loading = false, children,
}: {
  title: string;
  meta?: string;
  defaultOpen?: boolean;
  loading?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="si-sec"
      open={open}
      aria-busy={loading}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="si-sec-title">
        <span className="si-sec-chevron" aria-hidden="true" />
        <span>{title}</span>
        {meta && <small>{meta}</small>}
      </summary>
      <div className="si-sec-body">{children}</div>
    </details>
  );
}
