// THE master-password rule (CLAUDE.md §12).
//
// MASTER_PASSWORD is both the login of a hub that holds SSH keys to a whole
// fleet AND the seed of the key encrypting every stored secret. A hub never
// starts on a weak one: `server.js` exits on `masterPasswordProblem()`, and
// `scripts/rotate-master-password.mjs` (which re-encrypts the stored secrets)
// refuses a weak new one by the same rule.
//
// Plain CJS, like authGate.js: server.js and the script need it outside the
// server bundle.

const MIN_MASTER_PASSWORD_LENGTH = 12;

/** Example and dummy values (lower-case) that must never guard a hub. */
const PLACEHOLDER_SECRETS = new Set([
  'your master password here', '<openssl rand -hex 32>',
  'changeme', 'change-me', 'secret', 'password', 'test', 'dummy',
  'build-dummy', 'ci-dummy', 'ci-dummy-session-secret', 'ci-dummy-sync-token',
  'ci-dummy-salt', 'example', 'xxx',
]);

/** @param {string} v */
function isPlaceholderSecret(v) {
  return PLACEHOLDER_SECRETS.has(String(v).trim().toLowerCase());
}

/**
 * Why this MASTER_PASSWORD may not run a hub, or null when it may.
 * @param {string | undefined} v
 * @returns {string | null}
 */
function masterPasswordProblem(v) {
  if (!v) return 'MASTER_PASSWORD is not set';
  if (isPlaceholderSecret(v)) return 'MASTER_PASSWORD is still an example value';
  if (v.length < MIN_MASTER_PASSWORD_LENGTH) {
    return `MASTER_PASSWORD is too short (${v.length} characters, at least ${MIN_MASTER_PASSWORD_LENGTH})`;
  }
  return null;
}

module.exports = { MIN_MASTER_PASSWORD_LENGTH, PLACEHOLDER_SECRETS, isPlaceholderSecret, masterPasswordProblem };
