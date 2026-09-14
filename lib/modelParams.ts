import type { CursorModel, CursorModelParameter } from './types/api';

/**
 * Per-model parameters: the shape a provider takes when its reasoning axis is
 * declared by the MODEL rather than by the provider (`effortAxis: 'model'`,
 * lib/sessionCapabilities.ts).
 *
 * Claude and Codex have one global effort vocabulary, so a session's effort is
 * a word from a fixed list. Cursor does not: each model ships its OWN knobs —
 * one reasoning ladder (`effort` / `reasoning` / `reasoning_effort`, whose
 * rungs differ per model) plus independent switches (`thinking`, `fast`,
 * `context`). `claude-opus-5` alone has 5 × 2 × 2 × 2 = 32 combinations.
 *
 * Listing those combinations as models was the first attempt and it was wrong:
 * the picker showed the same model forty times. The split that replaces it is
 * the one the data already has — the MODEL column holds the bare id, the
 * EFFORT column holds the parameter set, and the effort control is filled from
 * whatever model is selected.
 *
 * A parameter set travels as ONE string, `effort=high&thinking=true`, because
 * a session has one effort column. Keys are sorted so two equal selections
 * compare equal as strings — the picker marks the active row that way.
 */

/** Parameter ids that mean "how hard should it think".
 *
 *  Measured against the live 38-model catalog: a model declares AT MOST ONE of
 *  these, never two, which is what lets it drive a single effort control. An id
 *  not listed here is treated as an ordinary switch, so an unknown future knob
 *  degrades to "shown as its own group" rather than disappearing. */
export const REASONING_PARAM_IDS: readonly string[] = ['effort', 'reasoning', 'reasoning_effort'];

export type ModelParamSet = Record<string, string>;

// Bounds, not opinions: these values reach an argv-free SDK call, but they also
// land in a DB column and a URL, and an unbounded key/value pair from a
// provider catalog is still input we did not write.
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/i;
const VALUE_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;
const MAX_PARAMS = 8;

/** Canonical encoding: sorted, empty values dropped. */
export function encodeModelParams(params: ModelParamSet | null | undefined): string {
  return Object.entries(params ?? {})
    .filter(([k, v]) => KEY_RE.test(k) && typeof v === 'string' && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Tolerant decoding: anything malformed is skipped rather than throwing —
 *  this parses a value that may have been stored by an older build. */
export function decodeModelParams(raw: string | null | undefined): ModelParamSet {
  const out: ModelParamSet = {};
  for (const chunk of (raw ?? '').split('&')) {
    const at = chunk.indexOf('=');
    if (at <= 0) continue;
    const key = chunk.slice(0, at).trim();
    const value = chunk.slice(at + 1).trim();
    if (KEY_RE.test(key) && VALUE_RE.test(value) && Object.keys(out).length < MAX_PARAMS) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Is this a well-formed parameter set?
 *
 * The VOCABULARY is deliberately not checked: the levels are per model and come
 * from a live account catalog, so a hub-side list would either reject a rung
 * the account really has or go stale silently. The provider is the final gate —
 * the same rule the effort route already applies to Claude's catalog levels.
 */
export function isModelParamSet(raw: string): boolean {
  if (!raw || raw.length > 256) return false;
  const parts = raw.split('&');
  if (parts.length > MAX_PARAMS) return false;
  const seen = new Set<string>();
  for (const chunk of parts) {
    const at = chunk.indexOf('=');
    if (at <= 0) return false;
    const key = chunk.slice(0, at);
    if (!KEY_RE.test(key) || !VALUE_RE.test(chunk.slice(at + 1)) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** Split `claude-opus-5?thinking=true` into its halves.
 *
 *  The query suffix is LEGACY — parameters live in the effort column now — but
 *  sessions created before that split still carry it, and the agent still
 *  honours it, so every reader must keep understanding it. */
export function splitModelSpec(spec: string | null | undefined): {
  id: string; params: ModelParamSet;
} {
  const raw = (spec ?? '').trim();
  const at = raw.indexOf('?');
  if (at < 0) return { id: raw, params: {} };
  return { id: raw.slice(0, at).trim(), params: decodeModelParams(raw.slice(at + 1)) };
}

/** The inverse. A bare id stays bare, so nothing gains a suffix it didn't have. */
export function joinModelSpec(id: string, params: ModelParamSet | null | undefined): string {
  const query = encodeModelParams(params);
  return query ? `${id}?${query}` : id;
}

// ── Reading a model's knobs ─────────────────────────────────────────────────

/** Cursor pads some display names with U+200B to make duplicates unique
 *  ("Fast", "Fast​", "Fast​​"). Invisible here, so strip it. */
function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

/** A value's human label, falling back to something readable.
 *
 *  Two catalog quirks make the raw labels unusable on their own. A BOOLEAN
 *  parameter ships `false` with no label at all and `true` labelled with the
 *  parameter's own name — fine for a standalone chip, but inside a group headed
 *  "Fast" the rows would read "" and "Fast". So a boolean is always on/off,
 *  which is what the group header leaves to say. Everything else keeps the
 *  catalog's own word (Low, Extra High, 300K, 1M). */
export function paramValueLabel(param: CursorModelParameter, value: string): string {
  if (value === 'true') return 'on';
  if (value === 'false') return 'off';
  return clean(param.values?.find((v) => v.value === value)?.label) || value;
}

export function paramLabel(param: CursorModelParameter): string {
  return clean(param.label) || param.id;
}

export type ModelAxes = {
  /** The model's reasoning ladder, if it has one. */
  reasoning: CursorModelParameter | null;
  /** Its independent switches, catalog order preserved. */
  extra: CursorModelParameter[];
  /** Every parameter, reasoning first — the order the effort picker groups in. */
  all: CursorModelParameter[];
  /** The values of the catalog's default variant: what the provider applies
   *  when the session's effort column is empty. */
  defaults: ModelParamSet;
  /** Short facts, ONE PER LINE, in the order they should read. */
  facts: string[];
};

/**
 * Classify one model's parameters into the axes the UI has controls for.
 *
 * HUB-side on purpose: the agent forwards the catalog verbatim, so recognising
 * a newly-named ladder is a hub deploy rather than a fleet-wide agent rollout.
 */
export function modelAxes(model: CursorModel | null | undefined): ModelAxes {
  const params = model?.parameters ?? [];
  const reasoning = params.find((p) => REASONING_PARAM_IDS.includes(p.id)) ?? null;
  const extra = params.filter((p) => p !== reasoning);
  const defaults = model?.variants?.find((v) => v.isDefault)?.params ?? {};

  // What a reader wants off a model row: how much context it can hold, how far
  // its reasoning goes, and which switches it has. One fact per LINE — packed
  // onto one, they read as a sentence nobody parses; stacked, the eye can run
  // down a column and compare the same field across models. (The price is a
  // separate source and is added by the picker, not here — `modelPricing.ts`.)
  const facts: string[] = [];
  const context = params.find((p) => p.id === 'context');
  if (context?.values?.length) {
    // Named, not bare: "300K/1M" on its own is a number with no unit. A slash
    // rather than a dash because these are the two sizes offered, not a range.
    facts.push(`${context.values.map((v) => paramValueLabel(context, v.value)).join('/')} context`);
  }
  if (reasoning?.values?.length) {
    const rungs = reasoning.values;
    const span = rungs.length > 1
      ? `${paramValueLabel(reasoning, rungs[0].value)}–${paramValueLabel(reasoning, rungs[rungs.length - 1].value)}`
      : paramValueLabel(reasoning, rungs[0].value);
    facts.push(`${paramLabel(reasoning)} ${span}`);
  }
  for (const p of extra) {
    if (p.id === 'context') continue;
    // A two-value switch is a capability ("it can think", "it has a fast
    // lane"); naming both values would say nothing extra.
    facts.push(paramLabel(p));
  }
  return { reasoning, extra, all: reasoning ? [reasoning, ...extra] : extra, defaults, facts };
}
