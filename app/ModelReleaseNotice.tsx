'use client';
import { useState } from 'react';
import type { AgentKind, ModelNotice } from '@/lib/types/api';

/** Each model is acknowledged explicitly; the shared server ledger removes it
 * from every browser only after the request succeeds. */
export default function ModelReleaseNotice({ provider, unread, onSeen }: {
  provider: AgentKind;
  unread: ModelNotice[];
  onSeen: (provider: AgentKind, ids: string[]) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!unread.length) return null;
  return (
    <div className="model-release-notices" aria-label={`New ${provider} models`}>
      {unread.map((model) => (
        <div key={model.id} className="model-release-notice" role="status">
          <span>New model available: <strong>{model.label}</strong></span>
          <button
            type="button"
            disabled={pending !== null}
            aria-label={`Acknowledge ${model.label}`}
            onClick={async () => {
              setPending(model.id);
              setError(null);
              try { await onSeen(provider, [model.id]); }
              catch { setError(model.id); }
              finally { setPending(null); }
            }}
          >
            {pending === model.id ? 'Saving…' : 'OK'}
          </button>
          {error === model.id && <span className="model-release-error">Could not save. Try again.</span>}
        </div>
      ))}
    </div>
  );
}
