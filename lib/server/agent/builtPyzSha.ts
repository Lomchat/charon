import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Calcule le SHA256 (12 premiers chars) du .pyz embarqué dans le dashboard.
// Aligné avec le format renvoyé par l'agent côté Python (server.py /
// _compute_pyz_sha) pour permettre la comparaison directe.
//
// Cache en mémoire : le fichier ne change qu'au redéploiement du dashboard,
// donc inutile de re-hasher à chaque request. Si jamais le fichier n'existe
// pas (dev sans build), retourne null — l'UI traitera ça comme "pas
// d'update connu, on ne propose rien".

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
