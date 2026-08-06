import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPyzVersion } from './pyzVersion';

// Identity of the .pyz embedded in the dashboard: its SHA256 (first 12 chars,
// same format as server.py / _compute_pyz_sha) and its `__version__`.
//
// Division of labour (§14.6): the VERSION decides whether a VPS is outdated
// (ordered comparison — a hub never deploys over a newer agent, which is what
// kills the two-hub ping-pong of §14.70); the SHA is only an identity/receipt
// (post-update confirmation, local-agent diff display) and NEVER a staleness
// verdict on its own.
//
// In-memory cache keyed on mtime: the file only changes on dashboard
// redeployment. Missing file (dev without build) ⇒ null, and the UI treats
// that as "no known update, propose nothing".

const PYZ_PATH = path.join(process.cwd(), 'agent/dist/charon-agent.pyz');

let cached: { sha: string | null; version: string | null; mtimeMs: number } | null = null;

function load(): { sha: string | null; version: string | null } {
  try {
    const stat = fs.statSync(PYZ_PATH);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
    const buf = fs.readFileSync(PYZ_PATH);
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    cached = { sha, version: readPyzVersion(PYZ_PATH), mtimeMs: stat.mtimeMs };
    return cached;
  } catch {
    return { sha: null, version: null };
  }
}

export function getBuiltPyzSha(): string | null {
  return load().sha;
}

/**
 * `__version__` of the pyz this hub would deploy — read FROM THE ARTEFACT, not
 * from `agent/charon_agent/__init__.py`: advertising a source version the
 * shipped bytes don't carry would make every update a no-op that stays
 * "outdated", i.e. a redeploy loop every 30min (see pyzVersion.ts).
 */
export function getBuiltAgentVersion(): string | null {
  return load().version;
}
