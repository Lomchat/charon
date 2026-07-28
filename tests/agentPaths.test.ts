import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * Per-hub agent instances (§14.70).
 *
 * The load-bearing property is the FIRST block: with `CHARON_INSTANCE` unset,
 * every string must be byte-identical to what Charon emitted before instances
 * existed. That is what makes deploying this to an existing fleet a provable
 * no-op instead of a fleet-wide agent reinstall. The literals below are
 * transcribed from the pre-change source — do NOT "fix" them to match new
 * output; if they fail, the production path changed and the fleet will churn.
 *
 * `agentPaths.js` snapshots `process.env.CHARON_INSTANCE` at import time (it
 * has to: `server.js` requires it before anything else exists), so each case
 * sets the env and re-imports through a busted module cache via `vi.resetModules`.
 */

const ORIGINAL = process.env.CHARON_INSTANCE;

async function loadWith(instance: string | undefined) {
  const { default: vi } = await import('vitest').then((m) => ({ default: m.vi }));
  vi.resetModules();
  if (instance === undefined) delete process.env.CHARON_INSTANCE;
  else process.env.CHARON_INSTANCE = instance;
  return (await import('../lib/server/agent/agentPaths.js')) as any;
}

beforeEach(() => { delete process.env.CHARON_INSTANCE; });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CHARON_INSTANCE;
  else process.env.CHARON_INSTANCE = ORIGINAL;
});

describe('default instance is byte-identical to the pre-instance behaviour', () => {
  it('emits the legacy paths, unit name and pkill pattern', async () => {
    const p = await loadWith(undefined);
    expect(p.INSTANCE).toBe('');
    expect(p.AGENT_DIR_NAME).toBe('.charon');
    expect(p.AGENT_DIR_TILDE).toBe('~/.charon');
    expect(p.AGENT_DIR_HOME).toBe('$HOME/.charon');
    expect(p.AGENT_DIR_SYSTEMD).toBe('%h/.charon');
    expect(p.UNIT_NAME).toBe('charon-agent.service');
    expect(p.REMOTE_AGENT_PATH).toBe('~/.charon/charon-agent.pyz');
    expect(p.AGENT_LOG_SYSTEMD).toBe('%h/.charon/agent.log');
    // The pre-change pattern was `charon-agent.pyz$`; we now scope it to the
    // instance dir. For the default instance it must still match the real
    // legacy cmdline and still spare holders — asserted in the block below.
    expect(p.AGENT_PKILL_PATTERN).toBe('/\\.charon/charon-agent\\.pyz$');
  });

  it('adds no env prefix and no systemd Environment= line', async () => {
    const p = await loadWith(undefined);
    // Both must be EMPTY: any addition changes the remote command line and
    // the unit file for all 9 existing VPSes.
    expect(p.agentHomeEnvPrefix()).toBe('');
    expect(p.agentHomeEnvPrefix('tilde')).toBe('');
    expect(p.systemdEnvironmentLine()).toBe('');
  });

  it('treats empty/whitespace CHARON_INSTANCE as default', async () => {
    for (const raw of ['', '   ']) {
      const p = await loadWith(raw);
      expect(p.INSTANCE).toBe('');
      expect(p.UNIT_NAME).toBe('charon-agent.service');
    }
  });
});

describe('a namespaced instance is fully isolated', () => {
  it('namespaces dir, unit, pyz and log — but never the venv', async () => {
    const p = await loadWith('eleven');
    expect(p.AGENT_DIR_NAME).toBe('.charon-eleven');
    expect(p.UNIT_NAME).toBe('charon-agent-eleven.service');
    expect(p.REMOTE_AGENT_PATH).toBe('~/.charon-eleven/charon-agent.pyz');
    expect(p.AGENT_LOG_HOME).toBe('$HOME/.charon-eleven/agent.log');
    // The venv is SHARED on purpose: an SDK upgrade from either hub must
    // benefit both. If this ever becomes instance-scoped, co-tenant hubs stop
    // sharing dependency updates — the explicit non-goal.
    expect(p.SHARED_VENV_HOME).toBe('$HOME/.charon/venv');
    expect(p.SHARED_VENV_PY_HOME).toBe('$HOME/.charon/venv/bin/python');
    expect(p.SHARED_VENV_PY_SYSTEMD).toBe('%h/.charon/venv/bin/python');
  });

  it('points the agent at its own state dir via CHARON_AGENT_HOME', async () => {
    const p = await loadWith('eleven');
    // Without this the proxy would open the DEFAULT socket — i.e. drive the
    // co-tenant's daemon, the exact bug being fixed.
    expect(p.agentHomeEnvPrefix('home')).toBe('env CHARON_AGENT_HOME=$HOME/.charon-eleven ');
    expect(p.agentHomeEnvPrefix('tilde')).toBe('env CHARON_AGENT_HOME=~/.charon-eleven ');
    expect(p.systemdEnvironmentLine()).toBe('Environment=CHARON_AGENT_HOME=%h/.charon-eleven\n');
  });
});

describe('pkill patterns never cross instance boundaries', () => {
  // Real cmdlines as they appear in `ps -eo cmd` on the fleet.
  const DEFAULT_DAEMON = '/root/.charon/venv/bin/python /root/.charon/charon-agent.pyz';
  const ELEVEN_DAEMON = '/root/.charon/venv/bin/python /root/.charon-eleven/charon-agent.pyz';
  const DEFAULT_HOLDER =
    '/root/.charon/venv/bin/python /root/.charon/charon-agent.pyz --shell-holder a1b2c3 --cols 80 --rows 24';
  const ELEVEN_HOLDER =
    '/root/.charon/venv/bin/python /root/.charon-eleven/charon-agent.pyz --shell-holder a1b2c3 --cols 80 --rows 24';

  it('the default pattern hits only the default daemon', async () => {
    const p = await loadWith(undefined);
    const re = new RegExp(p.AGENT_PKILL_PATTERN);
    expect(re.test(DEFAULT_DAEMON)).toBe(true);
    // The co-tenant's daemon must survive: this is the regression that made
    // one hub's install tear down the other hub's live sessions.
    expect(re.test(ELEVEN_DAEMON)).toBe(false);
    // Holders must survive (§14.44) — the `$` anchor.
    expect(re.test(DEFAULT_HOLDER)).toBe(false);
    expect(re.test(ELEVEN_HOLDER)).toBe(false);
  });

  it('a namespaced pattern hits only its own daemon', async () => {
    const p = await loadWith('eleven');
    const re = new RegExp(p.AGENT_PKILL_PATTERN);
    expect(re.test(ELEVEN_DAEMON)).toBe(true);
    expect(re.test(DEFAULT_DAEMON)).toBe(false);
    expect(re.test(ELEVEN_HOLDER)).toBe(false);
    expect(re.test(DEFAULT_HOLDER)).toBe(false);
  });

  it('a prefix-colliding instance name cannot match a sibling', async () => {
    // `.charon-a` must not match `.charon-ab`; the trailing `/` in the
    // pattern is what guarantees it.
    const p = await loadWith('a');
    const re = new RegExp(p.AGENT_PKILL_PATTERN);
    expect(re.test('/usr/bin/python /root/.charon-a/charon-agent.pyz')).toBe(true);
    expect(re.test('/usr/bin/python /root/.charon-ab/charon-agent.pyz')).toBe(false);
  });
});

describe('instance ids are validated before they reach a path or a regex', () => {
  it('accepts sane ids', async () => {
    const { parseInstance } = await loadWith(undefined);
    for (const ok of ['a', 'eleven', 'hub-2', 'hub_2', 'x'.repeat(32)]) {
      expect(parseInstance(ok)).toEqual({ ok: true, instance: ok });
    }
    expect(parseInstance(undefined)).toEqual({ ok: true, instance: '' });
    expect(parseInstance('  eleven  ')).toEqual({ ok: true, instance: 'eleven' });
  });

  it('rejects anything that could escape a path, a unit name or a regex', async () => {
    const { parseInstance } = await loadWith(undefined);
    const bad = [
      '../evil',        // path traversal
      'a/b',            // separator
      'a b',            // word split in the shell
      "a'b",            // quote break-out in the pkill command
      'a$b', 'a`b',     // shell expansion
      'a.b', 'a*b',     // regex metacharacters in the pkill pattern
      'A',              // uppercase (systemd unit names are case-sensitive;
                        //   keep one canonical spelling)
      '-lead',          // leading dash → reads as an option
      '_lead',
      'x'.repeat(33),   // too long
    ];
    for (const b of bad) {
      const r = parseInstance(b);
      expect(r.ok, `expected ${JSON.stringify(b)} to be rejected`).toBe(false);
    }
  });

  it('an invalid id degrades to default rather than throwing at import', async () => {
    // agentPaths is required by server.js before any logging exists, so it
    // must never throw; configCheck.ts is what surfaces the error.
    const p = await loadWith('../evil');
    expect(p.INSTANCE).toBe('');
    expect(p.AGENT_DIR_NAME).toBe('.charon');
  });
});
