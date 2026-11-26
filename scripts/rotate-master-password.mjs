#!/usr/bin/env node
// Change MASTER_PASSWORD without losing the stored secrets (CLAUDE.md §12).
// Operator tool, OFFLINE: the hub must be stopped (the exclusive-lock probe of
// compact-thinking.mjs refuses otherwise).
//
//   node scripts/rotate-master-password.mjs [--env .env] [--skip-undecryptable]
//
// MASTER_PASSWORD + MASTER_SALT derive the AES key of every secret the hub
// stores (provider accounts, endpoint tokens, Telegram token, API key, Web
// Push key), so a bare .env edit loses them. This re-encrypts each one under
// a key from the NEW password and a fresh salt, then rewrites both lines of
// the env file. The new password is asked twice on the terminal, or read
// from CHARON_NEW_MASTER_PASSWORD; it must pass masterPasswordRule.js.
//
// Secrets are FOUND, not listed: every text cell of every table (except the
// transcript tables) that is an AES-GCM blob, an `enc:v1:` blob, or a JSON
// document holding one at any depth. A blob the OLD key cannot open is
// already lost: refused unless --skip-undecryptable (left untouched).
//
// Order: compute every new value in memory → write the old values of the
// changed cells + a copy of the env file next to the DB (0600) → ONE
// transaction (cells + every login session, so every browser signs in again)
// → re-read and decrypt each cell with the new key → rewrite the env file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { openOffline, RefusedError } from './compact-thinking.mjs';

const require = createRequire(import.meta.url);
const { masterPasswordProblem } = require('../lib/server/masterPasswordRule.js');

/** Transcript tables: large, and never hold a sealed secret. */
const SKIP_TABLE = /^(sqlite_|__drizzle|session_messages|session_logs)/;
const ENC_PREFIX = 'enc:v1:';
/** Cheap prefilter: an `"iv"` key, also inside escaped JSON strings (`\"iv\"`). */
const MAY_SEAL = /iv\\*"/;

// ── Crypto: byte-compatible with lib/server/crypto.ts + masterKey.ts ────────
export function deriveKey(password, saltHex) {
  if (!/^[0-9a-fA-F]{16,}$/.test(saltHex || '')) throw new RefusedError('MASTER_SALT must be hex (>= 16 characters)');
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
}

function seal(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
}

function open(blob, key) {
  const { iv, ct, tag } = JSON.parse(blob);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

function isBlob(s) {
  if (!s.startsWith('{"iv":"')) return false;
  try {
    const v = JSON.parse(s);
    return Object.keys(v).length === 3 && ['iv', 'ct', 'tag'].every((k) => typeof v[k] === 'string');
  } catch { return false; }
}

// ── Finding and re-sealing ──────────────────────────────────────────────────
/**
 * Every cell holding a sealed secret, re-sealed under `newKey`. Writes
 * nothing. → { changes: [{table, rowid, column, before, after}], sealed,
 * undecryptable: ['table.column#rowid'] }.
 */
export function planRotation(db, oldKey, newKey) {
  const changes = [];
  const undecryptable = [];
  let sealed = 0;
  for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (SKIP_TABLE.test(table)) continue;
    const q = (id) => `"${id.replaceAll('"', '""')}"`;
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name);
    let rows;
    try { rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${q(table)}`).all(); }
    catch (e) { throw new RefusedError(`cannot scan table ${table} (${e.message})`); }
    for (const row of rows) {
      for (const column of columns) {
        const before = row[column];
        if (typeof before !== 'string' || !MAY_SEAL.test(before)) continue;
        const where = `${table}.${column}#${row.__rowid}`;
        // An unreadable blob stays as it is; its readable neighbours move on.
        const reseal = (s) => {
          sealed += 1;
          try { return seal(open(s, oldKey), newKey); }
          catch { undecryptable.push(where); return s; }
        };
        const walk = (v) => {
          if (typeof v === 'string') return transform(v);
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
          return v;
        };
        const transform = (s) => {
          if (isBlob(s)) return reseal(s);
          if (s.startsWith(ENC_PREFIX) && isBlob(s.slice(ENC_PREFIX.length))) return ENC_PREFIX + reseal(s.slice(ENC_PREFIX.length));
          if (!/^\s*[[{]/.test(s) || !MAY_SEAL.test(s)) return s;
          let doc;
          try { doc = JSON.parse(s); } catch { return s; }
          const next = JSON.stringify(walk(doc));
          return next === JSON.stringify(doc) ? s : next;
        };
        const after = transform(before);
        if (after !== before) changes.push({ table, rowid: row.__rowid, column, before, after });
      }
    }
  }
  return { changes, sealed, undecryptable };
}

/** One transaction: the cells, then every login session. */
export function applyRotation(db, changes) {
  const q = (id) => `"${id.replaceAll('"', '""')}"`;
  db.transaction(() => {
    for (const c of changes) {
      const r = db.prepare(`UPDATE ${q(c.table)} SET ${q(c.column)} = ? WHERE rowid = ? AND ${q(c.column)} = ?`).run(c.after, c.rowid, c.before);
      if (r.changes !== 1) throw new Error(`${c.table}.${c.column}#${c.rowid} changed under us`);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) db.prepare('DELETE FROM sessions').run();
  })();
}

/** Every blob a rotated cell gained opens with the new key (a blob found
 *  verbatim in `before` is an unreadable one left as it was). */
export function verifyRotation(db, changes, newKey) {
  const q = (id) => `"${id.replaceAll('"', '""')}"`;
  for (const c of changes) {
    const now = db.prepare(`SELECT ${q(c.column)} AS v FROM ${q(c.table)} WHERE rowid = ?`).get(c.rowid)?.v;
    if (now !== c.after) throw new Error(`${c.table}.${c.column}#${c.rowid} does not hold its new value`);
    const blobs = [];
    const collect = (s) => {
      if (isBlob(s)) { blobs.push(s); return; }
      if (s.startsWith(ENC_PREFIX) && isBlob(s.slice(ENC_PREFIX.length))) { blobs.push(s.slice(ENC_PREFIX.length)); return; }
      let doc;
      try { doc = JSON.parse(s); } catch { return; }
      const walk = (v) => {
        if (typeof v === 'string') collect(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(doc);
    };
    collect(now);
    for (const b of blobs) if (!c.before.includes(JSON.stringify(b).slice(1, -1)) && !c.before.includes(b)) open(b, newKey); // throws on a wrong key
  }
}

// ── The env file ────────────────────────────────────────────────────────────
/** `KEY='value'` replaced (every occurrence) or appended. */
export function rewriteEnv(text, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}='${value}'`;
    const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'gm');
    // A function replacer: `$&` / `$1` in a password stay literal.
    out = out.match(re) ? out.replace(re, () => line) : `${out.replace(/\n?$/, '\n')}${line}\n`;
  }
  return out;
}

function writePrivate(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

async function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new RefusedError('no terminal: pass the new password in CHARON_NEW_MASTER_PASSWORD');
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); resolve(value); return; }
        if (ch === '\u0003') { done(); reject(new RefusedError('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword(old) {
  let pw = process.env.CHARON_NEW_MASTER_PASSWORD;
  if (!pw) {
    pw = await askHidden('New MASTER_PASSWORD: ');
    if (pw !== await askHidden('Again: ')) throw new RefusedError('the two entries differ');
  }
  const problem = masterPasswordProblem(pw);
  if (problem) throw new RefusedError(problem.replace('MASTER_PASSWORD', 'the new password'));
  if (/['\\\r\n]/.test(pw)) throw new RefusedError("the new password may not contain ', \\ or a line break (they break .env quoting)");
  if (pw === old) throw new RefusedError('the new password is the current one');
  return pw;
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const envPath = path.resolve(arg('--env') ?? '.env');
  const skipUndecryptable = argv.includes('--skip-undecryptable');
  if (!fs.existsSync(envPath)) throw new RefusedError(`${envPath} not found (--env <file>)`);
  const env = dotenv.parse(fs.readFileSync(envPath));
  if (!env.MASTER_PASSWORD) throw new RefusedError(`${envPath} has no MASTER_PASSWORD`);
  const dbPath = path.resolve(path.dirname(envPath), env.DATABASE_URL || './data/charon.db');
  const oldKey = deriveKey(env.MASTER_PASSWORD, env.MASTER_SALT);

  const db = openOffline(Database, dbPath); // refuses while the hub runs
  try {
    const password = await newPassword(env.MASTER_PASSWORD);
    const salt = crypto.randomBytes(32).toString('hex');
    const newKey = deriveKey(password, salt);
    const plan = planRotation(db, oldKey, newKey);
    if (plan.sealed > 0 && plan.undecryptable.length === plan.sealed) {
      throw new RefusedError(`the current MASTER_PASSWORD/MASTER_SALT open none of the ${plan.sealed} stored secrets: is ${envPath} the hub's env file?`);
    }
    if (plan.undecryptable.length && !skipUndecryptable) {
      throw new RefusedError(`${plan.undecryptable.length} stored secret(s) were already unreadable with the current key `
        + `(${plan.undecryptable.slice(0, 5).join(', ')}${plan.undecryptable.length > 5 ? ', …' : ''}): `
        + 'rerun with --skip-undecryptable to leave them as they are (re-enter them in Charon afterwards)');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(dbPath), `password-rotation-${stamp}.json`);
    writePrivate(backup, JSON.stringify({ env: envPath, cells: plan.changes.map(({ after: _a, ...c }) => c) }, null, 1));
    writePrivate(`${envPath}.before-password-rotation-${stamp}`, fs.readFileSync(envPath));

    applyRotation(db, plan.changes);
    verifyRotation(db, plan.changes, newKey);
    const mode = fs.statSync(envPath).mode & 0o777;
    writePrivate(envPath, rewriteEnv(fs.readFileSync(envPath, 'utf8'), { MASTER_PASSWORD: password, MASTER_SALT: salt }), mode);

    console.log(`✓ ${plan.changes.length} cell(s) re-encrypted (${plan.sealed - plan.undecryptable.length} secret(s)), every login session closed.`);
    if (plan.undecryptable.length) console.log(`  ${plan.undecryptable.length} already unreadable secret(s) left as they were: re-enter them in Charon.`);
    console.log(`  ${envPath}: MASTER_PASSWORD and a fresh MASTER_SALT written.`);
    console.log(`  Old values kept (delete them once the hub runs): ${backup}, ${envPath}.before-password-rotation-${stamp}`);
    console.log('  Start the hub again (Docker: `docker compose up -d`, which re-reads the env file).');
    return 0;
  } finally {
    db.close();
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e instanceof RefusedError ? `✖ ${e.message}` : e);
    process.exitCode = e instanceof RefusedError ? 2 : 1;
  });
}
