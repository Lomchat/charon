#!/usr/bin/env node
// Bundles the hub's server code (server/http/entry.ts + everything it imports
// from lib/ and server/) into dist/server/index.cjs for server.js. npm
// packages stay external (resolved from node_modules at runtime; better-sqlite3
// is native). `import 'server-only'` resolves to nothing here.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const serverBuildOptions = {
  absWorkingDir: root,
  entryPoints: ['server/http/entry.ts'],
  outfile: 'dist/server/index.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  packages: 'external',
  alias: { 'server-only': './server/http/serverOnly.ts' },
  tsconfig: 'tsconfig.json',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await esbuild.build(serverBuildOptions);
  console.log('server bundle: dist/server/index.cjs');
}
