import 'server-only';

// Strict validation of everything that ends up interpolated into an ssh argv
// (user@host, -p port) or a remote shell line. Shared by POST/PATCH /api/vps
// and POST /api/sync so the Bearer-authed sync path can't smuggle values the
// UI path would refuse. Argv-side, every call site also passes `--` before
// the destination (see sshShared.js) — defense in depth: even a value that
// slips through can't be parsed as an ssh option.
//
// Deliberately conservative: hostnames/IPv4/IPv6 + POSIX-ish usernames. If a
// legit exotic value is ever rejected, loosen HERE (single source), not at a
// call site.

const MAX_NAME = 120;
const MAX_HOST = 253; // RFC 1035 upper bound
const MAX_USER = 64;
const MAX_PATH = 512;

// Hostname / IPv4 / IPv6 (colons). No leading '-' (ssh option injection),
// no whitespace, no shell metacharacters.
const HOST_RE = /^[A-Za-z0-9_][A-Za-z0-9._:\-]*$/;
// POSIX-ish username. No leading '-'.
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._\-]*$/;

export type VpsTargetInput = {
  name?: unknown;
  ip?: unknown;
  sshUser?: unknown;
  sshPort?: unknown;
  defaultPath?: unknown;
};

export type VpsTargetValidated = {
  ok: true;
  name: string;
  ip: string;
  sshUser: string;
  sshPort: number;
  defaultPath: string | null;
} | { ok: false; error: string };

export function validatePort(raw: unknown, fallback = 22): number | null {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const p = Math.floor(n);
  return p >= 1 && p <= 65535 ? p : null;
}

export function validateHost(raw: unknown): string | null {
  const v = String(raw ?? '').trim();
  if (!v || v.length > MAX_HOST || !HOST_RE.test(v)) return null;
  return v;
}

export function validateSshUser(raw: unknown): string | null {
  const v = String(raw ?? '').trim();
  if (!v || v.length > MAX_USER || !USER_RE.test(v)) return null;
  return v;
}

export function validateRemotePath(raw: unknown): string | null | undefined {
  // undefined = invalid; null = absent/cleared.
  if (raw == null) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  if (v.length > MAX_PATH || /[\0\n\r]/.test(v)) return undefined;
  return v;
}

/** Full-record validation for create/upsert paths. */
export function validateVpsTarget(input: VpsTargetInput): VpsTargetValidated {
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > MAX_NAME) return { ok: false, error: `name too long (max ${MAX_NAME})` };

  const ip = validateHost(input.ip);
  if (!ip) return { ok: false, error: 'invalid host/ip (letters, digits, . _ - :, no leading dash, max 253 chars)' };

  const sshUser = validateSshUser(input.sshUser);
  if (!sshUser) return { ok: false, error: 'invalid ssh user (POSIX-like, no leading dash, max 64 chars)' };

  const sshPort = validatePort(input.sshPort);
  if (sshPort == null) return { ok: false, error: 'invalid ssh port (1..65535)' };

  const defaultPath = validateRemotePath(input.defaultPath);
  if (defaultPath === undefined) return { ok: false, error: `invalid default path (max ${MAX_PATH} chars, no control chars)` };

  return { ok: true, name, ip, sshUser, sshPort, defaultPath };
}
