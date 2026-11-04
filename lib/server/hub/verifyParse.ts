// ── Parsing of the remote python/SDK probes (§14.67) ────────────────────────
// PLAIN module, zero imports on purpose: `bootstrap.ts` pulls in `lib/db`
// (`server-only` + the native better-sqlite3), so the parsing logic lives here
// to stay unit-testable (same rationale as `lib/authExpired.ts`).
//
// THE INVARIANT THIS FILE EXISTS FOR: never conclude "the marker is in the
// output, therefore it worked". Python ≥3.13 echoes the offending SOURCE LINE
// in its tracebacks, and for a `python -c 'print("SDK=" + ...)'` probe that
// echoed line CONTAINS the marker we grep for. A naive `/SDK=(\S+)/` matched
// the crash and read the version as `"`.
//
// What that cost (real incident, ElevenDuel, agent 0.21.0): a fresh VPS on
// python3.13 reported `✓ verify — /usr/bin/python3.13 · claude sdk "`, so the
// bootstrap took its fast path and SKIPPED install_sdk entirely. No venv was
// ever created → install_codex bailed with "venv not ready" → the VPS ended up
// with the agent running and NEITHER backend installed, while the UI showed a
// green install.

export type VerifyOutcome = {
  ok: boolean;
  sdk?: string;
  py?: string;
  reason: 'no_py' | 'no_sdk' | 'ok' | 'other';
};

/**
 * Parse the output of the verify probe:
 *   PY=$(…); echo "PY=$PY"; "$PY" -c 'import claude_agent_sdk; print("SDK=" + …)' 2>&1
 *
 * `exitOk` = the remote command exited 0. THREE independent guards, keep all
 * three (any one of them alone fixes the incident above; together they also
 * cover future python versions changing their traceback format):
 *   1. `exitOk` — a crashing python cannot be a success,
 *   2. no traceback in the output,
 *   3. the marker must START A LINE — the echoed source line is indented, so
 *      it can never satisfy `^SDK=`.
 */
export function parseVerifyOutput(rawOut: string, exitOk: boolean): VerifyOutcome {
  const out = rawOut.trim();
  if (out.includes('NO_PY')) return { ok: false, reason: 'no_py' };
  const pyMatch = out.match(/^PY=(\S+)/m);
  const traceback =
    out.includes('Traceback (most recent call last)') || out.includes('ModuleNotFoundError');
  const sdkMatch = exitOk && !traceback ? out.match(/^SDK=(\S+)/m) : null;
  if (sdkMatch && pyMatch) return { ok: true, sdk: sdkMatch[1], py: pyMatch[1], reason: 'ok' };
  if (out.includes("No module named 'claude_agent_sdk'") || out.includes('ModuleNotFoundError')) {
    return { ok: false, reason: 'no_sdk', py: pyMatch?.[1] };
  }
  return { ok: false, reason: 'other', py: pyMatch?.[1] };
}

/**
 * True when the python the VPS resolved IS the one from our venv.
 *
 * `PY=` is echoed already expanded (`/root/.charon/venv/bin/python`), so it
 * cannot be compared to the `VENV_PY` constant (which still holds a literal
 * `$HOME`). Load-bearing for §14.67: a legacy host with the SDK in its SYSTEM
 * python verifies green while having NO venv — and the venv is what every pip
 * step (openai-codex included) targets, so the bootstrap must normalize it.
 */
export function isVenvPython(py: string | undefined): boolean {
  return !!py && /(^|\/)\.charon\/venv\/bin\/python\d*(\.\d+)?$/.test(py);
}
