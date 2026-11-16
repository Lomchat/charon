#!/usr/bin/env node
// Event-loop stalls of the hub before vs after a change, from the journal
// (`[perf] <label> <ms>ms`, `[eventloop] stall <ms>ms`, lib/server/perf/loopLag.ts).
//
//   node scripts/perf-report.mjs --split 2026-11-16T10:23:47+01:00 [--until <iso>]
//     [--before-days N] [--unit charon.service]
//
// The "after" window runs from --split to --until (default: now); the "before"
// window ends at --split and lasts as long (or --before-days). Sections within
// 5 min of a hub start are counted apart: a cold cache right after a restart
// is expected, steady state is what a fix should change.
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.split) {
  console.error('usage: perf-report.mjs --split <iso> [--until <iso>] [--before-days N] [--unit charon.service]');
  process.exit(2);
}
const unit = args.unit || 'charon.service';
const split = new Date(args.split);
const until = args.until ? new Date(args.until) : new Date();
const beforeMs = args['before-days'] ? Number(args['before-days']) * 86400e3 : until - split;
const since = new Date(split - beforeMs);
const BOOT_GRACE_MS = 5 * 60e3;

function journal(from, to) {
  return execFileSync('journalctl', ['-u', unit, '--no-pager', '-o', 'short-iso',
    '--since', from.toISOString().replace('T', ' ').slice(0, 19), '--until', to.toISOString().replace('T', ' ').slice(0, 19)],
  { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, TZ: 'UTC' } });
}

function analyse(from, to) {
  const days = (to - from) / 86400e3;
  const boots = [];
  const perf = [];
  const stalls = [];
  for (const line of journal(from, to).split('\n')) {
    const t = Date.parse(line.slice(0, 25));
    if (!Number.isFinite(t)) continue;
    if (line.includes('[charon] ready on')) { boots.push(t); continue; }
    let m = /\[perf\] (.+?) ([\d.]+)ms(?: \(.*\))?$/.exec(line);
    if (m) {
      const label = m[1].replace(/ [0-9a-f]{16}\b/g, '').replace(/ \(\d+ \w+\)$/, '');
      perf.push({ t, label, ms: Number(m[2]) });
      continue;
    }
    m = /\[eventloop\] stall (\d+)ms/.exec(line);
    if (m) stalls.push({ t, ms: Number(m[1]) });
  }
  const cold = (t) => boots.some((b) => t >= b && t - b < BOOT_GRACE_MS);
  const steady = perf.filter((p) => !cold(p.t));
  const byLabel = new Map();
  for (const p of steady) {
    const l = byLabel.get(p.label) ?? [];
    l.push(p.ms);
    byLabel.set(p.label, l);
  }
  const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  return {
    from, to, days, restarts: boots.length,
    perfSteady: steady.length, perfCold: perf.length - steady.length,
    steadySecondsPerDay: steady.reduce((a, p) => a + p.ms, 0) / 1000 / days,
    steadyMaxMs: Math.max(0, ...steady.map((p) => p.ms)),
    stallsSteady: stalls.filter((s) => !cold(s.t)).length,
    stallMaxMs: Math.max(0, ...stalls.map((s) => s.ms)),
    labels: [...byLabel].map(([label, v]) => ({ label, n: v.length, perDay: v.length / days, median: median(v), max: Math.max(...v) }))
      .sort((a, b) => b.perDay * b.median - a.perDay * a.median),
  };
}

const fmt = (n, d = 1) => Number(n).toFixed(d);
function print(name, r) {
  console.log(`${name}: ${r.from.toISOString().slice(0, 16)}Z → ${r.to.toISOString().slice(0, 16)}Z (${fmt(r.days)} days, ${r.restarts} hub starts)`);
  console.log(`  steady-state [perf] sections >250ms: ${r.perfSteady} (${fmt(r.perfSteady / r.days)}/day), ${fmt(r.steadySecondsPerDay)} s blocked/day, max ${fmt(r.steadyMaxMs, 0)} ms`);
  console.log(`  within 5 min of a start: ${r.perfCold} sections; [eventloop] stalls outside starts: ${r.stallsSteady}, max ${fmt(r.stallMaxMs, 0)} ms`);
  for (const l of r.labels.slice(0, 8)) {
    console.log(`    ${l.label.padEnd(26)} ${fmt(l.perDay).padStart(6)}/day  median ${fmt(l.median, 0).padStart(5)} ms  max ${fmt(l.max, 0).padStart(6)} ms`);
  }
}

const before = analyse(since, split);
const after = analyse(split, until);
print('BEFORE', before);
print('AFTER ', after);
const ratio = before.steadySecondsPerDay > 0 ? after.steadySecondsPerDay / before.steadySecondsPerDay : null;
console.log(`blocked time/day, steady state: ${fmt(before.steadySecondsPerDay)} s → ${fmt(after.steadySecondsPerDay)} s`
  + (ratio == null ? '' : ` (×${fmt(ratio, 2)})`));
