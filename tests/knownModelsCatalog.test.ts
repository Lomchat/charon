import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isPlausibleModelId, KNOWN_MODELS } from '@/lib/server/claude/knownModels';

// CLAUDE.md §14.43: "Do NOT allowlist families (an `opus|sonnet|haiku` regex
// once silently dropped `claude-fable-5` — accept any `^claude-`)."
//
// That regression had shipped AGAIN: the validator tested
// `^claude-(opus|sonnet|haiku)-…`, so Fable was rejected by the very check the
// footgun was written about. The failure is silent — the id is dropped and the
// user sees a model that "doesn't work" — hence a test rather than a comment.
describe('isPlausibleModelId — no family allow-list', () => {
  it('accepts a family the hub has never heard of', () => {
    expect(isPlausibleModelId('claude-fable-5')).toBe(true);
    // The point is the RULE, not this one name: any future family must pass
    // without a code change, because the API is the authority on what exists.
    expect(isPlausibleModelId('claude-chimera-9')).toBe(true);
  });

  it('accepts the families it already knew', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']) {
      expect(isPlausibleModelId(id)).toBe(true);
    }
  });

  it('accepts date-stamped pins pasted from telemetry', () => {
    expect(isPlausibleModelId('claude-haiku-4-5-20251001')).toBe(true);
  });

  it('accepts bare aliases, which are not `claude-*` at all', () => {
    for (const id of ['default', 'best', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan']) {
      expect(isPlausibleModelId(id)).toBe(true);
    }
  });

  it('accepts the [1m] context variant on both spellings', () => {
    expect(isPlausibleModelId('sonnet[1m]')).toBe(true);
    expect(isPlausibleModelId('opusplan[1m]')).toBe(true);
    expect(isPlausibleModelId('claude-opus-4-6[1m]')).toBe(true);
    expect(isPlausibleModelId('claude-opus-4-6[1M]')).toBe(true);
  });

  it('still rejects what is plainly not a model id', () => {
    expect(isPlausibleModelId('')).toBe(false);
    expect(isPlausibleModelId('[1m]')).toBe(false);
    expect(isPlausibleModelId('gpt-4o')).toBe(false);
    expect(isPlausibleModelId('../etc/passwd')).toBe(false);
  });
});

describe('KNOWN_MODELS catalog', () => {
  it('every listed id passes its own validator', () => {
    // A picker entry the validator rejects is unselectable — the two must not
    // be able to disagree.
    for (const m of KNOWN_MODELS) expect(isPlausibleModelId(m.id)).toBe(true);
  });

  it('has no duplicate ids', () => {
    const ids = KNOWN_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
