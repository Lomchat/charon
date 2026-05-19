#!/usr/bin/env node
// check-protocol-sync.mjs
//
// Vérifie que la liste des méthodes JSON-RPC est identique côté Python
// (agent/charon_agent/protocol.py — set METHODS) et côté TypeScript
// (lib/server/agent/types.ts — union AgentMethodName).
//
// Exit non-zéro + diagnostic clair si drift. Branché en prebuild dans
// package.json — toute désync casse le `npm run build`.

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
  // Cherche le bloc:  METHODS = { "hello", "ping", ... }
  const m = src.match(/METHODS\s*=\s*{([\s\S]*?)}/);
  if (!m) fail(`pas trouvé "METHODS = {...}" dans ${PY_PATH}`);
  const inside = m[1];
  const names = [...inside.matchAll(/["']([a-z_][a-z0-9_]*)["']/g)].map((x) => x[1]);
  return new Set(names);
}

function extractTsMethods(src) {
  // Cherche:  export type AgentMethodName =
  //            | 'hello'
  //            | 'ping'
  //            ...
  const idx = src.indexOf('export type AgentMethodName');
  if (idx < 0) fail(`pas trouvé "export type AgentMethodName" dans ${TS_PATH}`);
  // Coupe à partir du = et jusqu'au ; final du type.
  const after = src.slice(idx);
  const eq = after.indexOf('=');
  const end = after.indexOf(';', eq);
  if (eq < 0 || end < 0) fail('parsing AgentMethodName cassé');
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
  console.log(`✓ protocol-sync: ${pySet.size} méthodes alignées Py/TS`);
  process.exit(0);
}

const lines = [];
lines.push(`Drift entre protocol.py et lib/server/agent/types.ts.`);
if (onlyPy.length) lines.push(`  - Présentes côté Py mais absentes côté TS : ${onlyPy.join(', ')}`);
if (onlyTs.length) lines.push(`  - Présentes côté TS mais absentes côté Py : ${onlyTs.join(', ')}`);
lines.push(`Fix : aligne les deux listes (agent/charon_agent/protocol.py METHODS,`);
lines.push(`      lib/server/agent/types.ts AgentMethodName) puis rebuild.`);
fail(lines.join('\n'));
