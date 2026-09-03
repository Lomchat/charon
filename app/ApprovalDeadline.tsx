'use client';

import { useEffect, useState } from 'react';

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Makes the provider-side approval lifetime explicit while the gate is open. */
export default function ApprovalDeadline({ expiresAt }: { expiresAt?: number }) {
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const remaining = Math.max(0, expiresAt - nowSeconds);

  return (
    <div className="approval-deadline" role="status" aria-live="polite">
      {remaining > 0 ? (
        <>
          The agent is paused for approval. You can close this page. Auto-deny in{' '}
          <strong>{formatRemaining(remaining)}</strong>.
        </>
      ) : (
        <>Approval expired — denying automatically…</>
      )}
    </div>
  );
}
