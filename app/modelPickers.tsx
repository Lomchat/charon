'use client';
// Provider catalogs have distinct sources and caches; the exhaustive registry
// keeps their shared call sites provider-neutral (§14.102).
import type { ComponentType } from 'react';
import ModelPicker from './ModelPicker';
import EffortPicker from './EffortPicker';
import CodexModelPicker from './CodexModelPicker';
import CodexEffortPicker from './CodexEffortPicker';
import CursorModelPicker from './CursorModelPicker';
import CursorEffortPicker from './CursorEffortPicker';
import CursorEffortSummary from './CursorEffortSummary';
import { pruneCursorEffort } from './cursorEffort';
import { invalidateModels } from './modelsCache';
import { invalidateCodexModels } from './codexModelsCache';
import { invalidateCursorModels } from './cursorModelsCache';
import {
  PROVIDERS, providerBackendState, type SessionProvider,
} from '@/lib/sessionCapabilities';

/** The union of what any provider's picker needs. `vpsId` is always passed;
 *  a hub-global catalog simply ignores it, which is cheaper than making every
 *  call site know which shape it is talking to. */
export type ProviderModelPickerProps = {
  vpsId: string;
  value: string;
  onChange: (id: string) => void;
  presentation?: 'select' | 'list';
  disabled?: boolean;
  inheritPlaceholder?: string;
  noInherit?: boolean;
  className?: string;
  id?: string;
  catalogVersion?: string;
};
export type ProviderEffortPickerProps = ProviderModelPickerProps & { modelId: string };
/** Read-only rendering of a stored effort, for the closed header cell. */
export type ProviderEffortSummaryProps = {
  vpsId: string; modelId: string; effort: string | null;
};

export type ProviderCatalog = {
  Model: ComponentType<ProviderModelPickerProps>;
  Effort: ComponentType<ProviderEffortPickerProps>;
  /** Drop the cached catalog after a refresh or a release notice. Takes the VPS
   *  for a per-VPS catalog; a hub-global one ignores it and clears everything. */
  invalidate: (vpsId?: string) => void;
  /** How the stored effort READS when the control is closed. Absent for a
   *  provider whose effort is one word — the word is its own summary. */
  EffortSummary?: ComponentType<ProviderEffortSummaryProps>;
  /** The effort to keep when the MODEL changes. Absent where the vocabulary is
   *  the provider's rather than the model's, so nothing can go stale. */
  pruneEffort?: (vpsId: string, modelId: string, effort: string | null)
    => Promise<string | null>;
};

/**
 * The VPS whose account should answer a provider's catalog.
 *
 * Prefers a box that is SIGNED IN: an account-driven catalog (Codex, Cursor)
 * answers `unauthenticated` on a box that merely has the runtime installed, and
 * the picker then renders empty with no hint why — which reads as "Cursor has
 * no models" rather than "this VPS is not signed in". Falls back to a
 * connected-but-unverified box, then to any box at all, so the picker still
 * offers something on a fleet that has never been probed.
 */
export function catalogVpsFor<T extends {
  agentStatus?: string | null;
  claudeLoggedIn?: number | null; codexLoggedIn?: number | null; cursorLoggedIn?: number | null;
  codexAvailable?: number | null; cursorAvailable?: number | null;
}>(provider: SessionProvider, list: readonly T[] | null | undefined): T | null {
  const rows = list ?? [];
  const backend = PROVIDERS[provider].backend;
  const state = (v: T) => providerBackendState(v as any, provider);
  const usable = rows.filter((v) => !backend.availability.blocksLaunch
    || state(v).available === 1);
  return (
    usable.find((v) => state(v).loggedIn === 1 && v.agentStatus === 'ok')
    ?? usable.find((v) => v.agentStatus === 'ok')
    ?? usable[0]
    ?? null
  );
}

export const PROVIDER_CATALOGS: Record<SessionProvider, ProviderCatalog> = {
  claude: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    Model: ({ vpsId: _vpsId, ...rest }) => <ModelPicker {...rest} />,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    Effort: ({ vpsId: _vpsId, ...rest }) => <EffortPicker {...rest} />,
    invalidate: () => invalidateModels(),
  },
  codex: {
    Model: (props) => <CodexModelPicker {...props} />,
    Effort: (props) => <CodexEffortPicker {...props} />,
    invalidate: (vpsId) => invalidateCodexModels(vpsId),
  },
  cursor: {
    Model: (props) => <CursorModelPicker {...props} />,
    // Per-model effort: the control offers the SELECTED model's own ladder and
    // switches, which is why `modelId` is part of the shared prop shape rather
    // than a Codex extra (§14.103).
    Effort: (props) => <CursorEffortPicker {...props} />,
    invalidate: (vpsId) => invalidateCursorModels(vpsId),
    EffortSummary: (props) => <CursorEffortSummary {...props} />,
    pruneEffort: pruneCursorEffort,
  },
};
