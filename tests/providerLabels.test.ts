import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDERS, SESSION_PROVIDERS } from '@/lib/sessionCapabilities';

/**
 * A backend's IDENTITY and its NAME each come from exactly one place.
 *
 * These two rules exist because breaking them is invisible until a human runs
 * the app with a third backend installed — and it happened repeatedly while
 * Cursor shipped: the wizard said "⚠ Claude: not installed" about Cursor, the
 * chat said "Claude is thinking" on a Cursor turn, the sidebar offered to
 * "scan existing Claude sessions" whichever backend you asked for. Each was a
 * different file, found one bug report at a time.
 *
 *   1. IDENTITY — `asSessionProvider(kind)`. A `k === 'codex' ? … : …` ternary
 *      keeps compiling when the union grows and routes the newcomer into an
 *      old one's branch (§14.102).
 *   2. WORDS — `lib/providerText.ts`. A component asks for a sentence; it
 *      never types a provider's name.
 *
 * The allow-list below is the whole exception surface: a module that IS one
 * provider's own mechanism may say its name. If a new file needs to be added
 * there, that is a decision worth seeing in a diff — which is the point.
 */

const ROOT = path.resolve(__dirname, '..');

function sourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.next', 'dist', '__pycache__']);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, 'app'));
  walk(path.join(ROOT, 'lib'));
  return out;
}

/** The two modules that OWN identity and words. */
const OWNERS = ['lib/sessionCapabilities.ts', 'lib/providerText.ts', 'app/AgentLogo.tsx'];

/**
 * Modules that ARE one provider's own mechanism, and may therefore name it:
 * its sign-in flow, its catalog, its transcript importer, its install phase.
 * Each entry is a file whose whole reason to exist is that backend.
 */
const PROVIDER_OWNED = [
  'app/CodexLoginModal.tsx', 'app/CursorLoginModal.tsx',
  'app/CodexModelPicker.tsx', 'app/CodexEffortPicker.tsx',
  'app/CursorModelPicker.tsx', 'app/CursorEffortPicker.tsx',
  'app/api/vps/[id]/codex/', 'app/api/vps/[id]/cursor/',
  'app/api/codex/', 'app/api/cursor/',
  'lib/server/claude/codexModels.ts', 'lib/server/claude/cursorModels.ts',
  'lib/server/claude/importCodexRollout.ts', 'lib/server/claude/importCursorAgent.ts',
  'lib/server/claude/importJsonl.ts',
  'lib/server/claude/knownModels.ts', 'lib/server/claude/modelSync.ts',
  'lib/server/claude/sessionInsightCompat.ts', 'lib/server/claude/forkHistory.ts',
  'lib/server/claude/reviewPrompt.ts',
  // Bootstrap names each runtime's PACKAGE per install phase, and the fork
  // route names the pair a transport is for — both are mechanism, not chrome.
  'lib/server/claude/bootstrap.ts',
  'app/api/claude/sessions/[id]/fork/route.ts',
  'app/api/claude/sessions/[id]/review/route.ts',
  // Claude-specific auth-expiry prose detection (§14.65) and its bubble copy.
  'lib/authExpired.ts', 'lib/server/agent/loginSession.ts',
  'lib/server/agent/claudeLoginCheck.ts', 'app/ClaudeLoginModal.tsx',
  // The product's own name in metadata, and the wizard's per-backend rows.
  'app/layout.tsx',
];

function allowed(rel: string): boolean {
  return OWNERS.includes(rel) || PROVIDER_OWNED.some((p) => rel.startsWith(p));
}

/** Strip comments so prose ABOUT a provider never trips the scan. */
function codeLines(src: string): { line: string; n: number }[] {
  const out: { line: string; n: number }[] = [];
  let inBlock = false;
  src.split('\n').forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    const block = line.indexOf('/*');
    if (block >= 0) { inBlock = !line.includes('*/', block); line = line.slice(0, block); }
    const slash = line.indexOf('//');
    if (slash >= 0) line = line.slice(0, slash);
    const jsx = line.indexOf('{/*');
    if (jsx >= 0) line = line.slice(0, jsx);
    if (line.trim()) out.push({ line, n: i + 1 });
  });
  return out;
}


const cap = (p: string) => p[0].toUpperCase() + p.slice(1);

/**
 * The text right after the `:` that closes the ternary starting at `from`.
 * Returns null when there is no balanced `:` (a `?.` optional chain, a type
 * annotation, a `?` that belongs to something else).
 */
function elseOf(src: string, from: number): string | null {
  let depth = 0;
  let quote = '';
  let nested = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) { depth += 1; continue; }
    if (')]}'.includes(c)) { if (depth === 0) return null; depth -= 1; continue; }
    if (depth !== 0) continue;
    if (c === '?') { nested += 1; continue; }
    if (c === ':') {
      if (nested > 0) { nested -= 1; continue; }
      return src.slice(i + 1).replace(/^[\s\n]+/, '');
    }
    if (c === ';') return null;
  }
  return null;
}

describe('provider identity and words', () => {
  it('narrows a kind with asSessionProvider, never a ternary', () => {
    const ids = SESSION_PROVIDERS.map((p) => `'${p}'`).join('|');
    const ternary = new RegExp(`\\?\\s*(?:${ids})\\s*:\\s*(?:${ids})`);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = path.relative(ROOT, file);
      if (OWNERS.includes(rel)) continue;
      for (const { line, n } of codeLines(fs.readFileSync(file, 'utf8'))) {
        if (ternary.test(line)) offenders.push(`${rel}:${n}`);
      }
    }
    expect(
      offenders,
      `use asSessionProvider(kind): a coercion relabels a new provider at\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('names a backend only in that backend’s own module', () => {
    const names = SESSION_PROVIDERS.map((p) => PROVIDERS[p].label);
    // Inside a string literal only: an identifier like `CodexSession` or an
    // import path is code, not something a user reads.
    //
    // ⚠ DOUBLE quotes belong in this class. The repo writes TS strings with
    // single quotes, so scanning only those felt complete — and it missed every
    // JSX attribute, which is where `placeholder="…"`, `title="…"` and
    // `aria-label="…"` live. Fourteen hard-coded provider names were sitting in
    // shared components behind that gap, including a "Codex has no per-item
    // stop" tooltip shown for every backend.
    const inString = new RegExp(`['"\`][^'"\`]*\\b(?:${names.join('|')})\\b`);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = path.relative(ROOT, file);
      if (allowed(rel)) continue;
      for (const { line, n } of codeLines(fs.readFileSync(file, 'utf8'))) {
        if (/^\s*(import|export)\b/.test(line) || line.includes('from \'')) continue;
        if (inString.test(line)) offenders.push(`${rel}:${n}  ${line.trim().slice(0, 88)}`);
      }
    }
    expect(
      offenders,
      'a user-visible sentence must come from lib/providerText.ts (or add the '
      + `file to PROVIDER_OWNED if it IS that backend's mechanism):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('never lets a provider test own the ELSE branch of a shared surface', () => {
    // The §14.102 failure in the shape that survives a typecheck: not a value
    // coercion but a two-branch conditional whose CONDITION names one backend.
    // `isCodex ? <CodexModes/> : <ClaudeModes/>` over a three-member union puts
    // provider n+1 into the else, silently — which is how a Cursor session got
    // Claude's permission ladder, Claude's model catalog and Claude's diff
    // renderer, each found one bug report at a time.
    //
    // An else of `null` is the SAFE form and is allowed: it means "this block
    // belongs to that one backend", and a newcomer correctly renders nothing.
    const ids = SESSION_PROVIDERS.join('|');
    const predicate = new RegExp(
      `(?:\\bis(?:${SESSION_PROVIDERS.map(cap).join('|')})\\b`
      + `|\\b\\w*[Kk]ind\\s*(?:===|!==)\\s*['"](?:${ids})['"])\\s*\\?`,
      'g',
    );
    const SAFE_ELSE = /^(?:null|undefined|''|""|``|\[\]|\{\}|<\/>|<>\s*<\/>)\b/;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = path.relative(ROOT, file);
      if (allowed(rel)) continue;
      const src = codeLines(fs.readFileSync(file, 'utf8')).map((x) => x.line).join('\n');
      for (const m of src.matchAll(predicate)) {
        const elseBranch = elseOf(src, m.index! + m[0].length);
        if (elseBranch == null || SAFE_ELSE.test(elseBranch)) continue;
        const n = src.slice(0, m.index).split('\n').length;
        offenders.push(`${rel}:${n}  ${m[0].trim()} … : ${elseBranch.slice(0, 40)}`);
      }
    }
    expect(
      offenders,
      'a two-branch conditional on one provider silently routes every LATER '
      + 'provider into the else. Read the answer from the registry, or use '
      + `independent \`kind === 'x' &&\` guards:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('builds every phrase from the registry label', () => {
    for (const p of SESSION_PROVIDERS) {
      expect(PROVIDERS[p].label.trim()).not.toBe('');
      // Distinct: two backends sharing a name makes every warning ambiguous.
      const others = SESSION_PROVIDERS.filter((x) => x !== p).map((x) => PROVIDERS[x].label);
      expect(others).not.toContain(PROVIDERS[p].label);
    }
  });
});
