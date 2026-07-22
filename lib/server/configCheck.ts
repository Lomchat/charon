import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

// Startup configuration validation (P1.8). WARN-ONLY by design: a
// misconfigured .env must degrade loudly, never brick the hub (the operator
// may need the UI to fix things). Runs once from the seed.
//
// Checks:
// - required secrets present, not known placeholders, minimally long;
// - MASTER_SALT is valid hex (scrypt silently accepts garbage otherwise —
//   Buffer.from('zz','hex') is EMPTY, weakening the derived key);
// - DB directory exists/writable and the SQLite file isn't world-readable.

const PLACEHOLDERS = new Set([
  'changeme', 'change-me', 'secret', 'password', 'test', 'dummy',
  'build-dummy', 'ci-dummy', 'ci-dummy-session-secret', 'ci-dummy-sync-token',
  'ci-dummy-salt', 'example', 'xxx',
]);

function checkSecret(name: string, minLen: number, problems: string[]): void {
  const v = process.env[name];
  if (!v) { problems.push(`${name} is not set`); return; }
  if (PLACEHOLDERS.has(v.toLowerCase())) problems.push(`${name} is a known placeholder value`);
  if (v.length < minLen) problems.push(`${name} is short (${v.length} chars; want >= ${minLen} — try \`openssl rand -hex 32\`)`);
}

export function validateConfigAtBoot(): void {
  if (process.env.NODE_ENV !== 'production') return; // dev setups are allowed to be sloppy
  const problems: string[] = [];

  checkSecret('MASTER_PASSWORD', 8, problems);
  checkSecret('SESSION_SECRET', 32, problems);
  checkSecret('SYNC_TOKEN', 32, problems);

  const salt = process.env.MASTER_SALT;
  if (!salt) problems.push('MASTER_SALT is not set');
  else if (!/^[0-9a-fA-F]{16,}$/.test(salt)) {
    problems.push('MASTER_SALT must be hex, >= 16 chars (Buffer.from(salt, "hex") silently drops non-hex — weak key derivation)');
  }

  const dbPath = process.env.DATABASE_URL || './data/charon.db';
  try {
    const dir = path.dirname(dbPath);
    fs.accessSync(dir, fs.constants.W_OK);
    if (fs.existsSync(dbPath)) {
      const mode = fs.statSync(dbPath).mode & 0o777;
      if (mode & 0o004) problems.push(`${dbPath} is world-readable (mode ${mode.toString(8)}) — chmod 600 it (contains session hashes + settings)`);
    }
  } catch {
    problems.push(`DB directory for ${dbPath} is not writable`);
  }

  if (problems.length) {
    console.error('[config] ⚠ production configuration problems:');
    for (const p of problems) console.error(`[config]   - ${p}`);
  }
}
