import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDERS, SESSION_PROVIDERS, DEFAULT_SESSION_PROVIDER,
  asSessionProvider, isSessionProvider, defaultSessionMode, hasEffortAxis,
  isEffortValue, isSessionEffort,
  isSessionMode, providerBackendState, providerLabel, providerLoginPatch,
  providerSettingKey, sessionCapabilities, sessionModes, showsTurnCost,
  supportsSessionCapability, type SessionCapability,
} from '@/lib/sessionCapabilities';
import { vps } from '@/lib/db/schema';
import { AGENT_KINDS, enabledBackendsFromSettings, enabledKinds } from '@/app/enabledBackends';
import {
  PROVIDER_VERSION_COLUMNS, VPS_RUNTIME_KEYS, pickVpsRuntimeFields,
} from '@/lib/vpsRuntimeFields';
import { diagnoseVps } from '@/app/vpsHealth';

// The provider registry is the ONE table a new backend is declared in
// (CLAUDE.md §14.102). TypeScript already refuses an incomplete descriptor —
// every table is a `Record<SessionProvider, …>`. These tests cover what the
// type system cannot see: that the STRINGS a descriptor names (settings keys,
// VPS columns) really exist, and that the values are mutually consistent.
//
// When provider #3 lands, this file is the checklist that fails first, and
// each failure names the exact thing still missing.

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Keys declared in `settings.ts § DEFAULTS` (not exported — scanned). */
function declaredSettingKeys(): Set<string> {
  const src = read('lib/server/claude/settings.ts');
  const start = src.indexOf('const DEFAULTS');
  expect(start, 'settings.ts no longer declares DEFAULTS').toBeGreaterThan(-1);
  const keys = new Set<string>();
  for (const m of src.slice(start).matchAll(/^\s*'([a-z0-9_.]+)'\s*:/gim)) keys.add(m[1]);
  return keys;
}

/** The literal value a key carries in `settings.ts § DEFAULTS`. */
function declaredSettingValue(key: string): string {
  const src = read('lib/server/claude/settings.ts');
  const m = new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*'([^']*)'`).exec(src);
  return m ? m[1] : '';
}

const ALL_CAPABILITIES: SessionCapability[] = Object.keys(
  PROVIDERS[DEFAULT_SESSION_PROVIDER].capabilities,
) as SessionCapability[];

describe('provider registry', () => {
  it('has a self-consistent descriptor per declared provider', () => {
    expect(SESSION_PROVIDERS.length).toBeGreaterThan(0);
    expect(SESSION_PROVIDERS).toContain(DEFAULT_SESSION_PROVIDER);
    for (const p of SESSION_PROVIDERS) {
      const d = PROVIDERS[p];
      expect(d.id, `${p}: descriptor id must match its key`).toBe(p);
      expect(d.label.trim().length, `${p}: needs a display label`).toBeGreaterThan(0);
      expect(providerLabel(p)).toBe(d.label);
      expect(d.modes.length, `${p}: needs at least one mode`).toBeGreaterThan(0);
      // Whatever IS declared must validate — a level the provider would reject
      // is worse than none.
      for (const e of d.efforts) expect(isSessionEffort(p, e)).toBe(true);
      // A default the provider itself rejects would be replaced on every read.
      expect(d.modes, `${p}: defaultMode must be one of its modes`).toContain(d.defaultMode);
      expect(isSessionMode(p, d.defaultMode)).toBe(true);
      expect(defaultSessionMode(p)).toBe(d.defaultMode);
      expect(sessionModes(p)).toBe(d.modes);
      // Gates must expire on the PROVIDER's deadline, never zero/never.
      expect(d.interactionTimeoutS.permission).toBeGreaterThan(0);
      expect(d.interactionTimeoutS.question).toBeGreaterThan(0);
    }
  });

  it('declares where each effort vocabulary comes from', () => {
    // `efforts: []` is ambiguous on its own — it describes BOTH "no reasoning
    // axis" and "a ladder declared per model". Gating the UI on the list length
    // conflated them and hid Cursor's real per-model ladder behind an empty
    // array. `effortAxis` is the answer, and these are its coherence rules.
    for (const p of SESSION_PROVIDERS) {
      const d = PROVIDERS[p];
      expect(['static', 'model', 'none'], `${p}: unknown effortAxis`).toContain(d.effortAxis);
      // A static vocabulary that is empty is a contradiction: nothing to offer.
      if (d.effortAxis === 'static') expect(d.efforts.length, p).toBeGreaterThan(0);
      // A per-model axis must NOT also claim a hub-side list, or two sources of
      // truth disagree about what is valid.
      if (d.effortAxis !== 'static') expect(d.efforts, p).toEqual([]);
      expect(hasEffortAxis(p), p).toBe(d.effortAxis !== 'none');
      // Every declared level is accepted by the shared validator...
      for (const e of d.efforts) expect(isEffortValue(p, e), `${p}: ${e}`).toBe(true);
      // ...and a parameter set is accepted exactly where the axis is per-model.
      expect(isEffortValue(p, 'effort=high&thinking=true')).toBe(d.effortAxis === 'model');
      // Junk is refused everywhere, whatever the axis.
      for (const bad of ['', 'effort=', '=high', 'effort=high&effort=low', 'a'.repeat(300)]) {
        expect(isEffortValue(p, bad), `${p}: ${bad.slice(0, 20)}`).toBe(false);
      }
      expect(isEffortValue(p, null)).toBe(false);
    }
  });

  it('declares a usage dashboard only as a real https url', () => {
    // A provider with no usage API links out instead of showing an empty gauge
    // (§14.103). The url lands in an `<a href target=_blank>`, so a typo is a
    // dead link in the header rather than a compile error.
    for (const p of SESSION_PROVIDERS) {
      const url = PROVIDERS[p].usageDashboardUrl;
      if (url === null) continue;
      expect(() => new URL(url), `${p}: not a url`).not.toThrow();
      expect(new URL(url).protocol, `${p}: must be https`).toBe('https:');
    }
  });

  it('prices a turn only where the turn is billed', () => {
    // `cost_usd != null` looks like the test to write and is the wrong one: a
    // provider reporting an API-list VALUATION of quota-metered tokens answers
    // it exactly like one reporting a charge. `showsTurnCost` is the gate, and
    // it must agree with the declaration for every provider — including a new
    // one, which gets silence by default rather than an invented price.
    for (const p of SESSION_PROVIDERS) {
      const d = PROVIDERS[p];
      expect(['billed', 'equivalent', 'none'], `${p}: unknown turnCost`).toContain(d.turnCost);
      expect(showsTurnCost(p), p).toBe(d.turnCost === 'billed');
      // A provider that reports no cost cannot be the one we price.
      if (d.turnCost === 'none') expect(showsTurnCost(p), p).toBe(false);
      // Money is per-turn; an account-level dashboard is a separate answer and
      // neither implies nor excludes the other.
      if (d.turnCost === 'billed') expect(sessionCapabilities(p).turnUsage, p).not.toBe('none');
    }
  });

  it('answers every capability for every provider', () => {
    for (const p of SESSION_PROVIDERS) {
      const caps = sessionCapabilities(p);
      for (const c of ALL_CAPABILITIES) {
        expect(['native', 'adapted', 'none'], `${p}.${c}`).toContain(caps[c]);
      }
      expect(Object.keys(caps).sort()).toEqual([...ALL_CAPABILITIES].sort());
    }
  });

  it('derives each login fix action from the provider id', () => {
    // `VpsFixAction` is the template literal `${SessionProvider}-login`, so a
    // descriptor naming anything else would produce a button no handler routes.
    for (const p of SESSION_PROVIDERS) {
      expect(PROVIDERS[p].backend.login.action).toBe(`${p}-login`);
    }
  });

  it('names settings keys that actually exist', () => {
    const declared = declaredSettingKeys();
    for (const p of SESSION_PROVIDERS) {
      const d = PROVIDERS[p];
      // Convention-built keys (providerSettingKey) — a missing one silently
      // resolves every new session to no default at all.
      for (const suffix of ['default_model', 'default_effort', 'default_permission_mode']) {
        const key = providerSettingKey(p, suffix);
        expect(declared, `settings.ts § DEFAULTS is missing '${key}'`).toContain(key);
      }
      // The stored default must be a mode the provider accepts, or every new
      // session silently falls back and the setting reads as ignored — AND it
      // must be the registry's own `defaultMode`. The two are written in
      // different files (a plain DEFAULTS literal, scanned textually here), so
      // this is what keeps the duplicate a MIRROR instead of a second opinion.
      const storedMode = declaredSettingValue(providerSettingKey(p, 'default_permission_mode'));
      expect(isSessionMode(p, storedMode), `${p}: default mode '${storedMode}' is not one of its modes`).toBe(true);
      expect(storedMode, `${p}: settings.ts default mode disagrees with the registry`)
        .toBe(d.defaultMode);
      // Declared (non-derivable) keys.
      expect(declared, `missing enabled key for ${p}`).toContain(d.settings.enabledKey);
      expect(declared, `missing auto-update gate for ${p}`).toContain(d.settings.autoUpdateKey);
      // The fallback-model key is capability-gated: it exists IFF the provider
      // declares `fallbackModel`. This is the check `_resolveSessionConfig`
      // cannot make in the type system (it casts that one key).
      const fallbackKey = `${p}.default_fallback_model`;
      expect(
        declared.has(fallbackKey),
        `${p}: declares fallbackModel=${d.capabilities.fallbackModel} but ` +
        `'${fallbackKey}' is ${declared.has(fallbackKey) ? 'present' : 'absent'}`,
      ).toBe(supportsSessionCapability(p, 'fallbackModel'));
    }
  });

  it('names VPS columns that exist on the schema', () => {
    const columns = new Set(Object.keys(vps));
    for (const p of SESSION_PROVIDERS) {
      const b = PROVIDERS[p].backend;
      for (const col of [
        b.availability.column, b.loggedInColumn, b.loggedInCheckedAtColumn,
        ...b.versions.map((v) => v.column),
      ]) {
        expect(columns, `${p}: vps has no column '${col}'`).toContain(col);
      }
    }
  });

  it('ships every backend column in the browser-safe runtime snapshot', () => {
    // §14.52: FOUR paths converge on these columns — the SQL projection, the
    // SSE `vps_status` payload, the browser merge and its equality check. They
    // now all read `VPS_RUNTIME_KEYS`, so this asserts that ONE list covers
    // every registry column. A column it omits gives a chip that never updates
    // without an F5 — invisible until someone notices a stale badge.
    for (const p of SESSION_PROVIDERS) {
      const b = PROVIDERS[p].backend;
      for (const col of [
        b.availability.column, b.loggedInColumn, ...b.versions.map((v) => v.column),
      ]) {
        expect(VPS_RUNTIME_KEYS, `VPS_RUNTIME_KEYS omits '${col}'`).toContain(col);
      }
    }
    // And that the WIRE type carries them, since the browser merges by key.
    const apiType = read('lib/types/api.ts');
    const start = apiType.indexOf('export type VpsRuntimeSnapshot');
    const snapshotType = apiType.slice(start, apiType.indexOf('>;', start));
    for (const key of VPS_RUNTIME_KEYS) {
      expect(snapshotType, `VpsRuntimeSnapshot omits '${key}'`).toContain(`'${key}'`);
    }
  });

  it('forwards every runtime column through the live vps_status patch', () => {
    // The emitter used to name the keys it forwarded, so a backend's columns
    // were accepted by the function and dropped on the floor — a sign-in in
    // one tab never reached another (§14.52).
    const patch = pickVpsRuntimeFields(
      Object.fromEntries(VPS_RUNTIME_KEYS.map((k) => [k, 1])),
    );
    expect(Object.keys(patch).sort()).toEqual([...VPS_RUNTIME_KEYS].sort());
    // `undefined` stays ABSENT: that is the no-clobber contract (§14.53).
    expect(pickVpsRuntimeFields({ sdkVersion: undefined })).toEqual({});
  });

  it('declares a latest-version source for every release line', () => {
    // A line with no entry in `LATEST_LINES` compares against null, i.e. is
    // NEVER stale — the package would silently stop being updated fleet-wide
    // while the chip says "✓". It also needs a REFRESHER, or its cached latest
    // is frozen at whatever it was when someone last called it by name.
    const sdkSync = read('lib/server/claude/sdkSync.ts');
    const body = sdkSync.slice(sdkSync.indexOf('export const LATEST_LINES'));
    const map = body.slice(0, body.indexOf('\n};'));
    for (const p of SESSION_PROVIDERS) {
      for (const line of PROVIDERS[p].backend.versions) {
        expect(map, `sdkSync § LATEST_LINES has no '${line.latestKey}'`)
          .toContain(`${line.latestKey}:`);
        expect(map, `${line.latestKey} has no refresher`)
          .toMatch(new RegExp(`${line.latestKey}:[\\s\\S]*?refresh:`));
        expect(map, `${line.latestKey} has no TTL refresher`)
          .toMatch(new RegExp(`${line.latestKey}:[\\s\\S]*?refreshIfStale:`));
      }
      for (const line of PROVIDERS[p].backend.versions) {
        // The SETTINGS key its cached latest lands in, read back by the
        // Settings "latest releases" line.
        expect(declaredSettingKeys(), `${line.latestSettingKey} is not a declared setting`)
          .toContain(line.latestSettingKey);
      }
    }
  });

  it('reports every release line back from an agent update', () => {
    // `UpdateAgentResult` reports each post-update version under the SAME name
    // as its column, which is what lets the route and the browser patch loop
    // instead of naming three of four backends (§14.52). The update route
    // BUILDS its response from this list.
    const declared = SESSION_PROVIDERS
      .flatMap((p) => PROVIDERS[p].backend.versions.map((v) => v.column));
    expect([...PROVIDER_VERSION_COLUMNS].sort()).toEqual([...new Set(declared)].sort());
    const route = read('app/api/vps/[id]/agent/update/route.ts');
    expect(route, 'the update route no longer derives its version fields')
      .toContain('PROVIDER_VERSION_COLUMNS');
  });

  it('lights the health chip for EVERY declared release line', () => {
    // The consumer half of the test above. A `latestKey` produced by
    // `latestVersionsByKey` but never PLUMBED to `diagnoseVps` compares against
    // `undefined`, so its axis is never stale and its chip never lights — which
    // is exactly what shipped: the newest line was declared, fetched, cached
    // and then dropped by four hand-listed props on the way to the UI.
    for (const p of SESSION_PROVIDERS) {
      for (const line of PROVIDERS[p].backend.versions) {
        const row = {
          id: 'v1', agentStatus: 'ok', agentVersion: '9.9.9',
          [line.column]: '1.0.0',
        } as unknown as Parameters<typeof diagnoseVps>[0];
        const health = diagnoseVps(row, {
          builtAgentVersion: '9.9.9',
          [line.latestKey]: '2.0.0',
        });
        const agent = health.axes.find((a) => a.key === 'agent');
        expect(agent?.state, `${line.packageLabel}: stale version does not warn`).toBe('warn');
        expect(agent?.detail, `${line.packageLabel} is not named in the chip`)
          .toContain(line.packageLabel);
        expect(health.fixes.map((f) => f.action), `${line.packageLabel}: no update fix`)
          .toContain('update');
        // And the same row with the latest INSTALLED must be clean, or the chip
        // would nag forever.
        const fresh = diagnoseVps(
          { ...row, [line.column]: '2.0.0' } as unknown as Parameters<typeof diagnoseVps>[0],
          { builtAgentVersion: '9.9.9', [line.latestKey]: '2.0.0' },
        );
        expect(fresh.axes.find((a) => a.key === 'agent')?.state).toBe('ok');
      }
    }
  });

  it('remembers each release line’s announcement under its own key', () => {
    // Two lines sharing a notified key would announce one release and swallow
    // the other; a key absent from DEFAULTS never persists, re-announcing the
    // same version every 30min tick.
    const declared = declaredSettingKeys();
    const seen = new Set<string>();
    for (const p of SESSION_PROVIDERS) {
      for (const line of PROVIDERS[p].backend.versions) {
        expect(declared, `settings.ts § DEFAULTS is missing '${line.notifiedKey}'`)
          .toContain(line.notifiedKey);
        expect(seen.has(line.notifiedKey), `duplicate notifiedKey '${line.notifiedKey}'`).toBe(false);
        seen.add(line.notifiedKey);
      }
    }
  });

  it('reads its post-update version back under the column name', () => {
    // `sdkWatch`'s axis calls `after(result)` with the COLUMN name, so
    // `UpdateAgentResult` must carry that exact field or a successful update
    // reads as "still behind" and retries forever.
    const bootstrap = read('lib/server/claude/bootstrap.ts');
    for (const p of SESSION_PROVIDERS) {
      for (const line of PROVIDERS[p].backend.versions) {
        expect(bootstrap, `UpdateAgentResult has no '${line.column}' field`)
          .toMatch(new RegExp(`${line.column}\\??:`));
      }
    }
  });

  it('names native RPCs that the protocol actually declares', () => {
    // A typo here fails at RUNTIME with -32601, which the UI reports as
    // "unsupported" — indistinguishable from an agent too old to have the
    // method. The protocol list is the only place that can say otherwise.
    const methods = read('agent/charon_agent/protocol.py');
    for (const p of SESSION_PROVIDERS) {
      for (const [role, name] of Object.entries(PROVIDERS[p].nativeRpc)) {
        if (name == null) continue;
        expect(methods, `${p}.nativeRpc.${role} names '${name}', absent from protocol.py § METHODS`)
          .toContain(`"${name}"`);
      }
    }
  });

  it('keeps native archive RPCs and the archive capability in step', () => {
    // Two tables describing the same fact WILL drift: a provider whose archive
    // is declared `native` but names no RPC would silently keep its archive
    // hub-side only (the row hides, the provider still lists the thread), and
    // the reverse would call an RPC for a feature the UI reports as adapted.
    for (const p of SESSION_PROVIDERS) {
      const native = PROVIDERS[p].capabilities.archive === 'native';
      const rpc = PROVIDERS[p].nativeRpc;
      expect(rpc.archive != null, `${p}: archive=${PROVIDERS[p].capabilities.archive} vs rpc ${rpc.archive}`).toBe(native);
      expect(rpc.unarchive != null, `${p}: unarchive RPC must match archive's`).toBe(native);
    }
  });

  it('enrols every provider in the bootstrap and the import scan', () => {
    const bootstrap = read('lib/server/claude/bootstrap.ts');
    for (const p of SESSION_PROVIDERS) {
      const d = PROVIDERS[p].deployment;
      // Declared but unwired = a runtime installed on no VPS.
      expect(bootstrap, `bootstrap has no '${d.installPhase}' phase`)
        .toContain(`'${d.installPhase}'`);
      // Declared but unwired = an import tab that can never list history.
      const scanRoute = path.join(ROOT, 'app/api/vps/[id]', d.scanRouteDir, 'scan/route.ts');
      expect(
        fs.existsSync(scanRoute),
        `missing scan route for ${p}: app/api/vps/[id]/${d.scanRouteDir}/scan/route.ts`,
      ).toBe(true);
    }
  });

  it('reads backend state through both availability shapes', () => {
    for (const p of SESSION_PROVIDERS) {
      const b = PROVIDERS[p].backend;
      const installed = providerBackendState(
        { [b.availability.column]: b.availability.via === 'flag' ? 1 : '1.2.3', [b.loggedInColumn]: 1 },
        p,
      );
      expect(installed.available, `${p}: an installed runtime must read as 1`).toBe(1);
      expect(installed.loggedIn).toBe(1);

      const absent = providerBackendState({}, p);
      // A `flag` provider keeps NULL ("never probed"); a `version` one reads a
      // missing version as absent — the distinction `blocksLaunch` relies on.
      expect(absent.available).toBe(b.availability.via === 'flag' ? null : 0);
      expect(absent.loggedIn).toBeNull();
      expect(providerBackendState(null, p).versions.length).toBe(b.versions.length);
    }
  });

  it('writes a login verdict into that provider’s own columns', () => {
    for (const p of SESSION_PROVIDERS) {
      const b = PROVIDERS[p].backend;
      const patch = providerLoginPatch(p, 0, 1234);
      expect(patch).toEqual({ [b.loggedInColumn]: 0, [b.loggedInCheckedAtColumn]: 1234 });
      expect(providerBackendState(providerLoginPatch(p, 1, 5), p).loggedIn).toBe(1);
    }
  });

  it('validates an unknown provider instead of coercing it', () => {
    // The bug this replaced: `x === 'codex' ? 'codex' : 'claude'` maps EVERY
    // unknown string onto Claude, so a session belonging to a backend this
    // build does not know would silently open on the wrong one.
    expect(isSessionProvider('gemini')).toBe(false);
    expect(isSessionProvider(undefined)).toBe(false);
    for (const p of SESSION_PROVIDERS) {
      expect(isSessionProvider(p)).toBe(true);
      expect(asSessionProvider(p)).toBe(p);
    }
    expect(asSessionProvider('gemini')).toBe(DEFAULT_SESSION_PROVIDER);
    expect(asSessionProvider(null)).toBe(DEFAULT_SESSION_PROVIDER);
    expect(asSessionProvider('gemini', 'codex')).toBe('codex');
  });

  it('derives the enabled-backends switches from the registry', () => {
    expect([...AGENT_KINDS]).toEqual([...SESSION_PROVIDERS]);
    // Absence resolves to each provider's DECLARED default: a failed settings
    // fetch must neither subtract a configured backend nor advertise one that
    // ships opt-in.
    const declared = SESSION_PROVIDERS.filter((p) => PROVIDERS[p].settings.defaultEnabled);
    expect(enabledKinds(enabledBackendsFromSettings(null))).toEqual(declared);
    expect(enabledKinds(enabledBackendsFromSettings({}))).toEqual(declared);
    for (const p of SESSION_PROVIDERS) {
      const off = enabledBackendsFromSettings({ [PROVIDERS[p].settings.enabledKey]: 'false' });
      expect(off[p]).toBe(false);
      expect(enabledKinds(off)).not.toContain(p);
      // Only the literal 'false' disables.
      // A value that is PRESENT but not the literal 'false' means on, whatever
      // the declared default: a typo must never hide a backend someone enabled.
      expect(enabledBackendsFromSettings({ [PROVIDERS[p].settings.enabledKey]: 'nope' })[p]).toBe(true);
    }
  });
});
