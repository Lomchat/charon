'use client';
import { useState } from 'react';
import type { AgentKind, ModelNoticesResponse } from '@/lib/types/api';
import { SESSION_PROVIDERS } from '@/lib/sessionCapabilities';
import { providerText } from '@/lib/providerText';
import AgentLogo from './AgentLogo';

/** Every provider's discoveries in ONE list (Settings › general), each row
 * naming the CLI it belongs to. Each model is acknowledged explicitly; the
 * shared server ledger removes it from every browser only after the request
 * succeeds. */
export default function ModelReleaseNotice({ notices, onSeen }: {
  notices: ModelNoticesResponse;
  onSeen: (provider: AgentKind, ids: string[]) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = SESSION_PROVIDERS.flatMap((provider) =>
    notices[provider].map((model) => ({ provider, model, key: `${provider}:${model.id}` })));
  if (!rows.length) return null;
  return (
    <div className="model-release-notices" aria-label="New models">
      {rows.map(({ provider, model, key }) => (
        <div key={key} className="model-release-notice" role="status">
          <span className="model-release-text">
            <span className="model-release-cli">
              <AgentLogo kind={provider} size={14} title="" />
              {providerText.agentLabel(provider)}
            </span>
            <span>New model available: <strong>{model.label}</strong></span>
          </span>
          <button
            type="button"
            disabled={pending !== null}
            aria-label={`Acknowledge ${providerText.agentLabel(provider)} model ${model.label}`}
            onClick={async () => {
              setPending(key);
              setError(null);
              try { await onSeen(provider, [model.id]); }
              catch { setError(key); }
              finally { setPending(null); }
            }}
          >
            {pending === key ? 'Saving…' : 'OK'}
          </button>
          {error === key && <span className="model-release-error">Could not save. Try again.</span>}
        </div>
      ))}
    </div>
  );
}
