import { describe, it, expect } from 'vitest';
// Plain CJS module, shared verbatim with server.js (typed through allowJs).
import { isAuthRequired } from '../lib/server/authGate.js';

/**
 * The hub-wide authentication switch (§12).
 *
 * This is a four-line function guarding root SSH access to an entire fleet, so
 * the property under test is not "does it parse booleans" but "which way does
 * it fail". Every unrecognised value MUST keep the password: a typo in a .env
 * that quietly published the dashboard would look exactly like a working hub.
 */

const call = (value: string | undefined) =>
  isAuthRequired(value === undefined ? {} : { CHARON_AUTH_REQUIRED: value });

describe('isAuthRequired', () => {
  it('requires the password when the variable is absent (the historical default)', () => {
    expect(call(undefined)).toBe(true);
  });

  it('opens the hub only for the documented falsy words, case/space-insensitively', () => {
    for (const v of ['false', '0', 'no', 'off', 'FALSE', 'Off', ' false ', '\tNO\n']) {
      expect(call(v), `${JSON.stringify(v)} should disable auth`).toBe(false);
    }
  });

  it('FAILS CLOSED on anything it does not recognise', () => {
    // Typos, an emptied variable, quotes left in by a .env editor, and values
    // that merely look falsy. Each of these once meant "I tried to disable
    // auth"; none of them may succeed at it by accident.
    for (const v of ['flase', 'fasle', '', ' ', "'false'", '"false"', 'false;', 'nope', 'null', 'undefined', '-1', 'disabled']) {
      expect(call(v), `${JSON.stringify(v)} must keep auth on`).toBe(true);
    }
  });

  it('keeps the password for every affirmative spelling', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'required']) {
      expect(call(v), `${JSON.stringify(v)} must keep auth on`).toBe(true);
    }
  });

  it('reads process.env when no override is passed', () => {
    const original = process.env.CHARON_AUTH_REQUIRED;
    try {
      delete process.env.CHARON_AUTH_REQUIRED;
      expect(isAuthRequired()).toBe(true);
      process.env.CHARON_AUTH_REQUIRED = 'false';
      expect(isAuthRequired()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.CHARON_AUTH_REQUIRED;
      else process.env.CHARON_AUTH_REQUIRED = original;
    }
  });
});
