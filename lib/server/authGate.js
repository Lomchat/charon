// Hub-wide authentication switch (CLAUDE.md §12).
//
// `CHARON_AUTH_REQUIRED` decides whether the dashboard asks for the
// MASTER_PASSWORD at all. Unset — the historical state — means REQUIRED, so
// an existing deployment behaves byte-identically. Setting it to `false`
// removes the login screen AND every session check: the hub is then wide open
// to anything that can reach its port, which on Charon means root SSH on the
// whole fleet (SECURITY.md). It exists for the topology where the port is
// already private (loopback + SSH tunnel, VPN, a single-user laptop).
//
// There is deliberately NO in-app setting mirroring this: a switch that can
// disable authentication must not itself be reachable from the authenticated
// surface it protects.
//
// Plain CJS, like sessionHash.js, because `server.js` needs it too — the Next
// middleware never runs on a WebSocket Upgrade, so the WS gate is a separate
// implementation that must read the same switch.
//
// FAIL-CLOSED parsing: only an explicit, recognised falsy word opens the hub.
// A typo (`flase`), an empty value, a stray quote or an unset variable all
// keep the password. The inverse rule ("anything but `true` is off") would
// turn a mistyped .env into a silently published fleet.

/** Values that DISABLE authentication. Anything else keeps it on. */
const DISABLED_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Is the login password required for this hub?
 *
 * Reads `process.env` on every call rather than snapshotting at import: the
 * value only changes across a restart in production, and a live read keeps
 * the four call sites (middleware, session.ts, server.js, /login) honest and
 * trivially testable.
 *
 * @param {Record<string, string | undefined>} [env] override, for tests
 * @returns {boolean}
 */
function isAuthRequired(env) {
  const raw = (env || process.env).CHARON_AUTH_REQUIRED;
  if (typeof raw !== 'string') return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

module.exports = { isAuthRequired, DISABLED_VALUES };
