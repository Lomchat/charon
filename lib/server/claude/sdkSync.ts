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
// Codex (OpenAI) second backend — same PyPI-latest tracking so the fleet
// keeps `openai-codex` fresh (it bundles the codex CLI, dep
// openai-codex-cli-bin, that actually runs Codex sessions). Compared against
// each VPS's `vps.codexSdkVersion` (hello ≥0.15.0). Mirror of the SDK cache.
const PYPI_CODEX_URL = 'https://pypi.org/pypi/openai-codex/json';
const NPM_CODEX_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
// Cursor ships ONE artefact Charon owns: the `cursor-sdk` wheel, which carries
// its own Node runtime for the SDK bridge. The standalone `cursor-agent` CLI
// self-updates and Charon deliberately does not drive it (§14.103).
const PYPI_CURSOR_URL = 'https://pypi.org/pypi/cursor-sdk/json';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const FETCH_TIMEOUT_MS = 15_000;

// PyPI's `info.version` is the latest non-yanked release ("0.2.116").
// Sanity-gate the shape so a CDN error page never lands in settings.
const VERSION_RE = /^[0-9]+(\.[0-9A-Za-z]+)*$/;

export type SdkRefreshResult = { ok: boolean; version?: string; syncedAt?: number; error?: string };

/** Fetch the latest non-yanked version from a PyPI /json endpoint. Shared by
 *  the SDK and Codex trackers. Never throws — returns {ok:false, error}. */
async function fetchPypiLatest(url: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `pypi http ${res.status}` };
    const data: any = await res.json();
    const version = String(data?.info?.version ?? '').trim();
    if (!VERSION_RE.test(version)) return { ok: false, error: `unexpected version shape: ${JSON.stringify(version).slice(0, 60)}` };
    return { ok: true, version };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every release line: how to READ its cached latest, and how to REFRESH it.
 *
 * THE seam between the provider registry and the registries a version is
 * fetched from. A backend declares its release lines; this map is where each
 * one is told how to learn its latest version. `tests/providerRegistry` asserts
 * every declared `latestKey` appears here — a line with no entry would compare
 * against `null`, i.e. silently never be stale, which is the exact failure the
 * registry exists to prevent, and a line with no REFRESHER would be frozen at
 * whatever it was when someone last called its function by name.
 *
 * Fetching stays per-package on purpose: PyPI and npm have different URLs,
 * different response shapes and their own 12h TTL cache keys.
 */
export const LATEST_LINES: Readonly<Record<string, {
  get: () => string | null;
  refresh: () => Promise<SdkRefreshResult>;
  refreshIfStale: () => void;
}>> = {
  sdkLatestVersion: {
    get: getSdkLatestVersion,
    refresh: () => refreshSdkLatest(),
    refreshIfStale: () => refreshSdkLatestIfStale(),
  },
  codexLatestVersion: {
    get: getCodexLatestVersion,
    refresh: () => refreshCodexLatest(),
    refreshIfStale: () => refreshCodexLatestIfStale(),
  },
  codexCliLatestVersion: {
    get: getCodexCliLatestVersion,
    refresh: () => refreshCodexCliLatest(),
    refreshIfStale: () => refreshCodexCliLatestIfStale(),
  },
  cursorLatestVersion: {
    get: getCursorLatestVersion,
    refresh: () => refreshCursorLatest(),
    refreshIfStale: () => refreshCursorLatestIfStale(),
  },
};

/** Every release line's `latest`, keyed by the registry's `latestKey`
 *  (`sessionCapabilities § PROVIDERS[p].backend.versions[].latestKey`). */
export function latestVersionsByKey(): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(LATEST_LINES).map(([key, line]) => [key, line.get()]),
  );
}

/** Fire-and-forget TTL refresh of every declared line. Safe to kick from SSR. */
export function refreshAllLatestsIfStale(): void {
  for (const line of Object.values(LATEST_LINES)) line.refreshIfStale();
}

/** Force-refresh every declared line, in parallel. Never throws: each entry
 *  resolves to its own `{ok:false, error}` and the caller falls back to the
 *  cached value. Derived, so a newly declared line is refreshed the day it
 *  ships instead of on the tick that someone remembers to edit. */
export async function refreshAllLatests(): Promise<Record<string, SdkRefreshResult>> {
  const keys = Object.keys(LATEST_LINES);
  const results = await Promise.all(
    keys.map((key) => LATEST_LINES[key].refresh()
      .catch((e: any) => ({ ok: false as const, error: String(e?.message ?? e) }))),
  );
  return Object.fromEntries(keys.map((key, i) => [key, results[i]]));
}

/** Latest PyPI version we know of (null = never successfully synced). */
export function getSdkLatestVersion(): string | null {
  return getSetting('sdk.latest_version') || null;
}

/** Force a PyPI check now. Never throws — returns {ok:false, error} instead. */
export async function refreshSdkLatest(): Promise<SdkRefreshResult> {
  const r = await fetchPypiLatest(PYPI_URL);
  if (!r.ok) return { ok: false, error: r.error };
  const now = Date.now();
  setSetting('sdk.latest_version', r.version);
  setSetting('sdk.latest_version_at', String(now));
  return { ok: true, version: r.version, syncedAt: now };
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

// ── Codex (openai-codex) PyPI-latest tracking — mirror of the SDK above ─────

/** Latest `openai-codex` PyPI version we know of (null = never synced). */
export function getCodexLatestVersion(): string | null {
  return getSetting('codex.latest_version') || null;
}

/** Force a PyPI check now for openai-codex. Never throws. */
export async function refreshCodexLatest(): Promise<SdkRefreshResult> {
  const r = await fetchPypiLatest(PYPI_CODEX_URL);
  if (!r.ok) return { ok: false, error: r.error };
  const now = Date.now();
  setSetting('codex.latest_version', r.version);
  setSetting('codex.latest_version_at', String(now));
  return { ok: true, version: r.version, syncedAt: now };
}

// ── Cursor (cursor-sdk) PyPI-latest tracking — mirror of the two above ─────

/** Latest `cursor-sdk` PyPI version we know of (null = never synced). */
export function getCursorLatestVersion(): string | null {
  return getSetting('cursor.latest_version') || null;
}

/** Force a PyPI check now for cursor-sdk. Never throws. */
export async function refreshCursorLatest(): Promise<SdkRefreshResult> {
  const r = await fetchPypiLatest(PYPI_CURSOR_URL);
  if (!r.ok) return { ok: false, error: r.error };
  const now = Date.now();
  setSetting('cursor.latest_version', r.version);
  setSetting('cursor.latest_version_at', String(now));
  return { ok: true, version: r.version, syncedAt: now };
}

let cursorInflight: Promise<unknown> | null = null;

/** Best-effort background refresh of the cursor latest if older than the TTL. */
export function refreshCursorLatestIfStale(): void {
  const at = Number(getSetting('cursor.latest_version_at') || '0');
  if (Number.isFinite(at) && Date.now() - at < TTL_MS) return;
  if (cursorInflight) return;
  cursorInflight = refreshCursorLatest()
    .catch(() => {})
    .finally(() => { cursorInflight = null; });
}

let codexInflight: Promise<unknown> | null = null;

/** Best-effort background refresh of the codex latest if older than the TTL. */
export function refreshCodexLatestIfStale(): void {
  const at = Number(getSetting('codex.latest_version_at') || '0');
  if (Number.isFinite(at) && Date.now() - at < TTL_MS) return;
  if (codexInflight) return;
  codexInflight = refreshCodexLatest()
    .catch(() => {})
    .finally(() => { codexInflight = null; });
}

// ── Standalone Codex CLI (npm) ─────────────────────────────────────────────

export function getCodexCliLatestVersion(): string | null {
  return getSetting('codex.cli_latest_version') || null;
}

export async function refreshCodexCliLatest(): Promise<SdkRefreshResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(NPM_CODEX_URL, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `npm registry http ${res.status}` };
    const data: any = await res.json();
    const version = String(data?.version ?? '').trim();
    if (!VERSION_RE.test(version)) return { ok: false, error: `unexpected npm version shape: ${JSON.stringify(version).slice(0, 60)}` };
    const now = Date.now();
    setSetting('codex.cli_latest_version', version);
    setSetting('codex.cli_latest_version_at', String(now));
    return { ok: true, version, syncedAt: now };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

let codexCliInflight: Promise<unknown> | null = null;

/** Best-effort background refresh of the standalone CLI latest version. */
export function refreshCodexCliLatestIfStale(): void {
  const at = Number(getSetting('codex.cli_latest_version_at') || '0');
  if (Number.isFinite(at) && Date.now() - at < TTL_MS) return;
  if (codexCliInflight) return;
  codexCliInflight = refreshCodexCliLatest()
    .catch(() => {})
    .finally(() => { codexCliInflight = null; });
}
