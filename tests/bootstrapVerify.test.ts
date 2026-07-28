import { describe, it, expect } from 'vitest';
import { parseVerifyOutput, isVenvPython } from '../lib/server/claude/verifyParse';

// ── The bootstrap verify probe must never false-positive (§14.67) ───────────
// A FALSE POSITIVE here is the expensive direction: it makes the bootstrap
// take its fast path, skip install_sdk, never create ~/.charon/venv — and then
// install_codex can only bail with "venv not ready". The VPS ends up with a
// running agent and NO backend at all, behind a fully green install log.
// A false NEGATIVE just re-runs an idempotent `pip install --upgrade`.
//
// The literal blobs below are copy-pasted from real hosts. Keep them literal:
// the whole point is that the traceback ECHOES the probe's source line, which
// contains the `SDK=` marker we grep for.

// Python 3.13 (the incident: ElevenDuel, /usr/bin/python3.13, no SDK).
// Note line 3 — the echoed source contains `SDK="`.
const PY313_MISSING_SDK = `PY=/usr/bin/python3.13
Traceback (most recent call last):
  File "<string>", line 1, in <module>
    import claude_agent_sdk; print("SDK=" + str(claude_agent_sdk.__version__))
    ^^^^^^^^^^^^^^^^^^^^^^^
ModuleNotFoundError: No module named 'claude_agent_sdk'`;

// Python ≤3.12: no source echo, the old parser survived only by luck.
const PY312_MISSING_SDK = `PY=/usr/bin/python3.12
Traceback (most recent call last):
  File "<string>", line 1, in <module>
ModuleNotFoundError: No module named 'claude_agent_sdk'`;

const VENV_OK = `PY=/root/.charon/venv/bin/python
SDK=0.2.128`;

const SYSTEM_OK = `PY=/usr/bin/python3.12
SDK=0.2.128`;

describe('parseVerifyOutput', () => {
  it('does NOT read a version out of a python 3.13 traceback', () => {
    const r = parseVerifyOutput(PY313_MISSING_SDK, false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_sdk');
    expect(r.sdk).toBeUndefined();
    // The regression, verbatim: the old parser returned `"` here.
    expect(r.sdk).not.toBe('"');
  });

  it('still reports the python it resolved when the SDK is missing', () => {
    expect(parseVerifyOutput(PY313_MISSING_SDK, false).py).toBe('/usr/bin/python3.13');
    expect(parseVerifyOutput(PY312_MISSING_SDK, false).py).toBe('/usr/bin/python3.12');
  });

  it('handles the pre-3.13 traceback shape too', () => {
    const r = parseVerifyOutput(PY312_MISSING_SDK, false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_sdk');
  });

  it('accepts a genuine success', () => {
    const r = parseVerifyOutput(VENV_OK, true);
    expect(r).toMatchObject({ ok: true, reason: 'ok', sdk: '0.2.128', py: '/root/.charon/venv/bin/python' });
  });

  it('refuses a success marker when the command exited non-zero', () => {
    // Guard 1 alone: even a clean-looking output is not trusted if python died
    // (e.g. the marker printed, then a later line of the probe blew up).
    expect(parseVerifyOutput(VENV_OK, false).ok).toBe(false);
  });

  it('refuses a marker that does not start its line', () => {
    // Guard 3 alone: any future traceback/echo format that indents the source.
    const sneaky = `PY=/usr/bin/python3.14\n    print("SDK=" + version)`;
    expect(parseVerifyOutput(sneaky, true).ok).toBe(false);
  });

  it('reports no_py when no interpreter was found', () => {
    expect(parseVerifyOutput('NO_PY', false)).toMatchObject({ ok: false, reason: 'no_py' });
  });

  it('falls back to "other" on unrecognized noise', () => {
    const r = parseVerifyOutput('PY=/usr/bin/python3\nSegmentation fault', false);
    expect(r).toMatchObject({ ok: false, reason: 'other', py: '/usr/bin/python3' });
  });
});

describe('isVenvPython', () => {
  it('recognizes the charon venv interpreter', () => {
    expect(isVenvPython('/root/.charon/venv/bin/python')).toBe(true);
    expect(isVenvPython('/home/deploy/.charon/venv/bin/python3')).toBe(true);
    expect(isVenvPython('/home/deploy/.charon/venv/bin/python3.12')).toBe(true);
  });

  it('rejects a system python — the case that starved install_codex', () => {
    // SYSTEM_OK verifies GREEN (the SDK is importable) yet has no venv, so the
    // bootstrap must still run ensureSdkLatest to create one.
    expect(parseVerifyOutput(SYSTEM_OK, true).ok).toBe(true);
    expect(isVenvPython(parseVerifyOutput(SYSTEM_OK, true).py)).toBe(false);
    expect(isVenvPython('/usr/bin/python3.13')).toBe(false);
    expect(isVenvPython('/opt/venv/bin/python')).toBe(false);
    expect(isVenvPython(undefined)).toBe(false);
  });
});
