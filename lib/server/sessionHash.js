// Session-token hashing — single source shared by the TS hub (lib/server/
// auth.ts via allowJs) AND the plain-CJS custom server (server.js, which
// authenticates WebSocket upgrades with its own SQLite handle because Next
// middleware doesn't run on Upgrade requests).
//
// WHY: the browser cookie holds a raw 256-bit random token; the DB stores
// only HMAC-SHA256(SESSION_SECRET, token). A leaked DB copy / backup can no
// longer be replayed into a valid `charon_session` cookie (pre-2026-07 the
// raw token was stored as-is). This is also what finally gives
// SESSION_SECRET a real job — it was documented as "cookie signing" but
// never used anywhere.
//
// Notes:
// - Fallback to unkeyed SHA-256 when SESSION_SECRET is unset, so a missing
//   env var degrades to "still not replayable from a DB dump" instead of
//   crashing the auth path.
// - CHANGING SESSION_SECRET invalidates every active session (users just
//   re-login) — the lookup simply stops matching.
// - The one-shot migration of pre-hash rows lives in auth.ts
//   (migrateSessionIdsToHashed), gated by the `auth.session_ids_hashed`
//   marker in claude_settings.
'use strict';

const crypto = require('node:crypto');

/**
 * @param {string} token raw session token (cookie value)
 * @returns {string} hex digest to use as the sessions.id DB key
 */
function hashSessionToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    return crypto.createHmac('sha256', secret).update(token).digest('hex');
  }
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { hashSessionToken };
