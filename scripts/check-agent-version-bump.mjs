#!/usr/bin/env node
// CI guard: a change to the shipped agent package MUST bump `__version__`.
//
// Since §14.6, fleet propagation is version-ORDERED: a VPS updates iff the hub
// ships a STRICTLY NEWER `charon_agent.__version__`. That kills the two-hub
// pyz ping-pong (§14.70), but it moves the failure mode: an agent change
// committed without a bump reaches NOBODY — no badge, no auto-update, no
// error. Silent. This turns that into a red CI step.
//
// Scope = `agent/charon_agent/**` only: that package IS what runs on the VPS.
// `agent/tests/**` and docs don't ship, so they never require a bump (the
// committed `agent/dist/charon-agent.pyz` is covered by its own diff check).
//
// Usage: node scripts/check-agent-version-bump.mjs <baseSha> [headSha]
// A missing/unknown base (fresh branch, force-push, shallow clone) SKIPS the
// check rather than failing — it must never block on a git edge case.

import { execFileSync } from 'node:child_process';

const PKG = 'agent/charon_agent';
const VERSION_FILE = `${PKG}/__init__.py`;
const VERSION_RE = /^__version__\s*=\s*['"]([^'"]+)['"]/m;

const base = process.argv[2];
const head = process.argv[3] || 'HEAD';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function versionAt(ref) {
  try {
    const m = VERSION_RE.exec(git(['show', `${ref}:${VERSION_FILE}`]));
    return m ? m[1].trim() : null;
  } catch {
    return null; // file absent at that ref
  }
}

if (!base || /^0+$/.test(base)) {
  console.log('[check-agent-version-bump] no usable base ref — skipped');
  process.exit(0);
}
try {
  git(['cat-file', '-e', `${base}^{commit}`]);
} catch {
  console.log(`[check-agent-version-bump] base ${base} not in this clone — skipped`);
  process.exit(0);
}

const changed = git(['diff', '--name-only', `${base}`, `${head}`, '--', PKG])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

if (changed.length === 0) {
  console.log('[check-agent-version-bump] no change under agent/charon_agent — ok');
  process.exit(0);
}

const before = versionAt(base);
const after = versionAt(head);

if (before !== null && after !== null && before === after) {
  console.error(
    `\n✗ agent/charon_agent changed but __version__ is still ${after}.\n\n` +
    `  Changed files:\n${changed.map((f) => `    · ${f}`).join('\n')}\n\n` +
    `  Fleet updates are version-ordered (CLAUDE.md §14.6): a VPS only updates\n` +
    `  when the hub ships a STRICTLY NEWER version. Without a bump this change\n` +
    `  deploys to nothing, silently.\n\n` +
    `  Fix: bump __version__ in ${VERSION_FILE}, then\n` +
    `       bash agent/build.sh && git add ${VERSION_FILE} agent/dist/charon-agent.pyz\n`,
  );
  process.exit(1);
}

console.log(`[check-agent-version-bump] ok — ${before ?? '(none)'} → ${after ?? '(none)'}`);
