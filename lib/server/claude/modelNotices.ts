import 'server-only';
import type { AgentKind, ModelNotice, ModelNoticesResponse } from '@/lib/types/api';
import { getSetting, setSetting } from './settings';
import { SESSION_PROVIDERS, type SessionProvider } from '@/lib/sessionCapabilities';

type ProviderState = { known: string[]; unread: ModelNotice[] };
type Ledger = { revision: number } & Record<SessionProvider, ProviderState | null>;
/** A baseline ledger with one empty bucket per declared provider. */
function emptyLedger(): Ledger {
  return {
    revision: 0,
    ...Object.fromEntries(SESSION_PROVIDERS.map((k) => [k, null])),
  } as Ledger;
}

const g = globalThis as unknown as { _modelNoticeListeners?: Set<(state: ModelNoticesResponse) => void> };
const listeners = g._modelNoticeListeners ??= new Set();

function read(): Ledger {
  const raw = getSetting('models.notices');
  if (raw) {
    try {
      const state = JSON.parse(raw) as Ledger;
      if (Number.isSafeInteger(state.revision)
          && SESSION_PROVIDERS.every((k) => state[k] === null || state[k] === undefined
            || (Array.isArray(state[k]?.known) && Array.isArray(state[k]?.unread)))) return state;
    } catch { /* A corrupt ledger starts a silent baseline again. */ }
  }
  return emptyLedger();
}

function response(state: Ledger): ModelNoticesResponse {
  return {
    revision: state.revision,
    ...Object.fromEntries(SESSION_PROVIDERS.map((k) => [k, state[k]?.unread ?? []])),
  } as ModelNoticesResponse;
}

function write(state: Ledger): void {
  state.revision++;
  setSetting('models.notices', JSON.stringify(state));
  const snapshot = response(state);
  for (const listener of listeners) {
    try { listener(snapshot); } catch { /* One disconnected browser cannot veto a write. */ }
  }
}

export function getModelNotices(): ModelNoticesResponse { return response(read()); }

export function subscribeModelNotices(listener: (state: ModelNoticesResponse) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A versioned Claude model is one release, regardless of date/context pins.
 * Bare aliases cannot announce releases: their ids never change. */
export function normalizeNoticeModel(kind: AgentKind, model: ModelNotice): ModelNotice | null {
  if (!model.id || !model.label) return null;
  // The folding below is CLAUDE's OWN id scheme (§14.43): its catalog mixes
  // bare aliases, dated ids and `[1m]` context variants of the same model, so
  // they are collapsed before comparison and an id outside that family is not
  // one of its models. Every other provider ships a list of distinct ids that
  // needs none of it — and routing them through it dropped ALL of them, since
  // nothing there starts with `claude-`. A `kind === 'codex' ? … : …` said this
  // for two providers and silently mis-said it for the third (§14.102).
  if (kind !== 'claude') return { id: model.id, label: model.label };
  const id = model.id.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');
  return id.startsWith('claude-') ? { id, label: model.label } : null;
}

/** Monotonic union across VPSes/catalogs. Empty/failed refreshes never reset
 * history; the first nonempty catalog per provider is a silent baseline. */
export function observeModels(kind: AgentKind, models: ModelNotice[]): void {
  const catalog = new Map<string, ModelNotice>();
  for (const model of models) {
    const normalized = normalizeNoticeModel(kind, model);
    if (normalized) catalog.set(normalized.id, normalized);
  }
  if (!catalog.size) return;
  const state = read();
  const previous = state[kind];
  if (!previous) {
    state[kind] = { known: [...catalog.keys()], unread: [] };
    write(state);
    return;
  }
  const known = new Set(previous.known);
  const added = [...catalog.values()].filter((m) => !known.has(m.id));
  if (!added.length) return;
  previous.known.push(...added.map((m) => m.id));
  previous.unread.push(...added);
  write(state);
}

/** Acknowledge only the ids actually rendered, never a newer discovery that
 * arrived while the browser's request was in flight. Shared by all sessions. */
export function markModelsSeen(kind: AgentKind, ids: string[]): ModelNoticesResponse {
  const state = read();
  const provider = state[kind];
  if (provider) {
    const seen = new Set(ids);
    const unread = provider.unread.filter((m) => !seen.has(m.id));
    if (unread.length !== provider.unread.length) {
      provider.unread = unread;
      write(state);
    }
  }
  return response(state);
}
