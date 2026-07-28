'use client';
import { useEffect, useMemo, useRef } from 'react';
import type { Vps, VpsPath } from '@/lib/db/schema';

// ─────────────────────────────────────────────────────────────
// Shared VPS filtering for every VPS LIST in the hub (the « VPS &
// paths » modal and the new-agent / new-shell wizard). One matcher so
// both places answer the same question the same way: "does this VPS
// match what I typed?" — over the name, the host (user@ip[:port]) and
// the PROJECTS (registered paths + their labels + the default path).
//
// Matching rules (kept deliberately dumb + predictable):
//   - case-insensitive substring, NOT fuzzy (a fuzzy match on short
//     hostnames matches everything and destroys trust in the filter);
//   - whitespace splits the query into terms combined with AND, so
//     "prod charon" narrows instead of widening.
// ─────────────────────────────────────────────────────────────

export type VpsMatch = {
  ok: boolean;
  /** Project paths that matched — used to show WHY a row survived the filter. */
  paths: string[];
};

export type VpsSearch = {
  /** false when the query is empty ⇒ callers must skip filtering entirely. */
  active: boolean;
  match: (v: Vps) => VpsMatch;
  filter: (list: Vps[]) => Vps[];
};

const NO_MATCH: VpsMatch = { ok: true, paths: [] };

export function buildVpsSearch(query: string, paths: VpsPath[]): VpsSearch {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return { active: false, match: () => NO_MATCH, filter: (list) => list };
  }

  // Projects per VPS, computed once per (query, paths) matcher. `hay` carries
  // the label too (searchable), `path` is what we show back to the user.
  type Project = { path: string; hay: string };
  const projectsByVps = new Map<string, Project[]>();
  for (const p of paths) {
    const arr = projectsByVps.get(p.vpsId) ?? [];
    arr.push({ path: p.path, hay: (p.label ? `${p.label} ${p.path}` : p.path).toLowerCase() });
    projectsByVps.set(p.vpsId, arr);
  }

  // Keyed by OBJECT identity, not id: `vps` rows are re-created on every
  // live health merge, so an id-keyed cache could serve a stale haystack
  // after a rename.
  const cache = new Map<Vps, VpsMatch>();

  function match(v: Vps): VpsMatch {
    const hit = cache.get(v);
    if (hit) return hit;
    const projects = projectsByVps.get(v.id) ?? [];
    const dp = (v.defaultPath ?? '').trim();
    const all: Project[] = dp && !projects.some((p) => p.path === dp)
      ? [...projects, { path: dp, hay: dp.toLowerCase() }]
      : projects;
    const hay = [
      v.name,
      v.ip,
      v.sshUser,
      `${v.sshUser}@${v.ip}:${v.sshPort}`,
    ].join('\n').toLowerCase() + '\n' + all.map((p) => p.hay).join('\n');
    const ok = terms.every((t) => hay.includes(t));
    // Which projects matched (for the "why" hint) — a path is worth
    // showing as soon as it carries ANY of the terms.
    const matchedPaths = ok
      ? all.filter((p) => terms.some((t) => p.hay.includes(t))).map((p) => p.path)
      : [];
    const res: VpsMatch = { ok, paths: matchedPaths };
    cache.set(v, res);
    return res;
  }

  return {
    active: true,
    match,
    filter: (list) => list.filter((v) => match(v).ok),
  };
}

export function useVpsSearch(query: string, paths: VpsPath[]): VpsSearch {
  return useMemo(() => buildVpsSearch(query, paths), [query, paths]);
}

// Focus the search box as soon as the list opens, so "open the modal →
// type" filters straight away without a click. Skipped on COARSE
// pointers (phone/tablet): auto-focusing there pops the virtual keyboard
// over the very list the user came to look at.
export function useSearchAutoFocus<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    // rAF: the modal's node must be laid out before .focus() sticks.
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [enabled]);
  return ref;
}
