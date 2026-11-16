#!/usr/bin/env node
// Builds the browser bundle (Vite → dist/client) and keeps the previous
// builds' hashed assets in dist/assets-archive for 7 days: a tab opened before
// a deploy still lazy-loads chunks of ITS build (server/http/static.ts).
// Writes dist/client/BUILD_ID (lib/server/sync/buildId.ts, §14.57).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'dist', 'client');
const archiveDir = path.join(root, 'dist', 'assets-archive');
const KEEP_MS = 7 * 24 * 3600 * 1000;

function archivePreviousAssets() {
  const assets = path.join(clientDir, 'assets');
  if (!fs.existsSync(assets)) return;
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const f of fs.readdirSync(assets)) {
    const to = path.join(archiveDir, f);
    // Re-copying refreshes the mtime: a file still served by the last build
    // is kept another 7 days.
    fs.copyFileSync(path.join(assets, f), to);
    const now = new Date();
    fs.utimesSync(to, now, now);
  }
}

function pruneArchive() {
  if (!fs.existsSync(archiveDir)) return;
  const cutoff = Date.now() - KEEP_MS;
  for (const f of fs.readdirSync(archiveDir)) {
    const p = path.join(archiveDir, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
  }
}

archivePreviousAssets();
await build({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'warn' });
pruneArchive();
const buildId = crypto.randomBytes(12).toString('base64url');
fs.writeFileSync(path.join(clientDir, 'BUILD_ID'), buildId);
console.log(`client bundle: dist/client (build ${buildId})`);
