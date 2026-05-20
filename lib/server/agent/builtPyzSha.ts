import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Compute the SHA256 (first 12 chars) of the .pyz embedded in the dashboard.
// Aligned with the format returned by the agent on the Python side
// (server.py / _compute_pyz_sha) to allow direct comparison.
//
// In-memory cache: the file only changes on dashboard redeployment, so
// no need to re-hash on every request. If the file does not exist (dev
// without build), returns null — the UI treats this as "no known update,
// we propose nothing".

const PYZ_PATH = path.join(process.cwd(), 'agent/dist/charon-agent.pyz');

let cached: { sha: string | null; mtimeMs: number } | null = null;

export function getBuiltPyzSha(): string | null {
  try {
    const stat = fs.statSync(PYZ_PATH);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.sha;
    const buf = fs.readFileSync(PYZ_PATH);
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    cached = { sha, mtimeMs: stat.mtimeMs };
    return sha;
  } catch {
    return null;
  }
}
