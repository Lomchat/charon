import 'server-only';
import { getSetting, setSetting } from './settings';

/**
 * Tracks the latest `claude-agent-sdk` version published on PyPI.
 *
 * Why: the SDK ships the BUNDLED Claude Code CLI that actually executes every
 * Charon session on the VPSes (`claude_agent_sdk/_bundled/claude`) — the
 * standalone `claude` binary is only used for `claude login`. A stale SDK
 * means a stale CLI (real incident: SDK 0.2.87's CLI predated claude-fable-5
 * and mis-attributed the model). So the hub keeps a lazily-refreshed record
 * of the PyPI latest, compared against each VPS's `vps.sdkVersion` (reported
 * by agent hello ≥0.12.0) to light the sidebar "update" badge and drive the
 * idle auto-update tick (sdkWatch.ts).
 *
 * Same shape as modelSync.ts: settings-backed cache + TTL + inflight dedup +
 * graceful degradation ({ok:false}, never throws to callers).
 */

const PYPI_URL = 'https://pypi.org/pypi/claude-agent-sdk/json';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const FETCH_TIMEOUT_MS = 15_000;

// PyPI's `info.version` is the latest non-yanked release ("0.2.116").
// Sanity-gate the shape so a CDN error page never lands in settings.
const VERSION_RE = /^[0-9]+(\.[0-9A-Za-z]+)*$/;

export type SdkRefreshResult = { ok: boolean; version?: string; syncedAt?: number; error?: string };

/** Latest PyPI version we know of (null = never successfully synced). */
export function getSdkLatestVersion(): string | null {
  return getSetting('sdk.latest_version') || null;
}

/** Force a PyPI check now. Never throws — returns {ok:false, error} instead. */
export async function refreshSdkLatest(): Promise<SdkRefreshResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PYPI_URL, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `pypi http ${res.status}` };
    const data: any = await res.json();
    const version = String(data?.info?.version ?? '').trim();
    if (!VERSION_RE.test(version)) return { ok: false, error: `unexpected version shape: ${JSON.stringify(version).slice(0, 60)}` };
    const now = Date.now();
    setSetting('sdk.latest_version', version);
    setSetting('sdk.latest_version_at', String(now));
    return { ok: true, version, syncedAt: now };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

let inflight: Promise<unknown> | null = null;

/** Best-effort background refresh if the cached latest is older than the TTL.
 *  Fire-and-forget, deduped via `inflight` — safe to kick from every SSR /
 *  auto-update tick. */
export function refreshSdkLatestIfStale(): void {
  const at = Number(getSetting('sdk.latest_version_at') || '0');
  if (Number.isFinite(at) && Date.now() - at < TTL_MS) return;
  if (inflight) return;
  inflight = refreshSdkLatest()
    .catch(() => {})
    .finally(() => { inflight = null; });
}
