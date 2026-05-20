#!/usr/bin/env node
// check-protocol-sync.mjs
//
// Checks that the list of JSON-RPC methods is identical on the Python side
// (agent/charon_agent/protocol.py — METHODS set) and on the TypeScript side
// (lib/server/agent/types.ts — AgentMethodName union).
//
// Non-zero exit + clear diagnostic if drift. Wired as prebuild in
// package.json — any desync breaks `npm run build`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PY_PATH = resolve(ROOT, 'agent/charon_agent/protocol.py');
const TS_PATH = resolve(ROOT, 'lib/server/agent/types.ts');

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`\n❌ protocol-sync: ${msg}\n`);
  process.exit(1);
}

function extractPyMethods(src) {
  // Look for the block:  METHODS = { "hello", "ping", ... }
  const m = src.match(/METHODS\s*=\s*{([\s\S]*?)}/);
  if (!m) fail(`could not find "METHODS = {...}" in ${PY_PATH}`);
  const inside = m[1];
  const names = [...inside.matchAll(/["']([a-z_][a-z0-9_]*)["']/g)].map((x) => x[1]);
  return new Set(names);
}

function extractTsMethods(src) {
  // Look for:  export type AgentMethodName =
  //            | 'hello'
  //            | 'ping'
  //            ...
  const idx = src.indexOf('export type AgentMethodName');
  if (idx < 0) fail(`could not find "export type AgentMethodName" in ${TS_PATH}`);
  // Slice from the = through the final ; of the type.
  const after = src.slice(idx);
  const eq = after.indexOf('=');
  const end = after.indexOf(';', eq);
  if (eq < 0 || end < 0) fail('AgentMethodName parsing broken');
  const body = after.slice(eq + 1, end);
  const names = [...body.matchAll(/['"]([a-z_][a-z0-9_]*)['"]/g)].map((x) => x[1]);
  return new Set(names);
}

const py = readFileSync(PY_PATH, 'utf8');
const ts = readFileSync(TS_PATH, 'utf8');

const pySet = extractPyMethods(py);
const tsSet = extractTsMethods(ts);

const onlyPy = [...pySet].filter((n) => !tsSet.has(n)).sort();
const onlyTs = [...tsSet].filter((n) => !pySet.has(n)).sort();

if (onlyPy.length === 0 && onlyTs.length === 0) {
  // eslint-disable-next-line no-console
  console.log(`✓ protocol-sync: ${pySet.size} methods aligned Py/TS`);
  process.exit(0);
}

const lines = [];
lines.push(`Drift between protocol.py and lib/server/agent/types.ts.`);
if (onlyPy.length) lines.push(`  - Present on Py side but missing on TS side: ${onlyPy.join(', ')}`);
if (onlyTs.length) lines.push(`  - Present on TS side but missing on Py side: ${onlyTs.join(', ')}`);
lines.push(`Fix: align both lists (agent/charon_agent/protocol.py METHODS,`);
lines.push(`     lib/server/agent/types.ts AgentMethodName) then rebuild.`);
fail(lines.join('\n'));
