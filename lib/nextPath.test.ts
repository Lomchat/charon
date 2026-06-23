import { describe, it, expect } from 'vitest';
import { sanitizeNextPath } from './nextPath';

describe('sanitizeNextPath', () => {
  describe('valid same-origin paths pass through unchanged', () => {
    it('keeps a simple absolute path', () => {
      expect(sanitizeNextPath('/m/chat')).toBe('/m/chat');
    });

    it('keeps an absolute path with a query string', () => {
      expect(sanitizeNextPath('/m/chat?x=1')).toBe('/m/chat?x=1');
    });

    it('keeps the bare root', () => {
      expect(sanitizeNextPath('/')).toBe('/');
    });

    it('keeps a path with a fragment and multiple query params', () => {
      expect(sanitizeNextPath('/m/select?vps=1&tab=shell#top')).toBe(
        '/m/select?vps=1&tab=shell#top',
      );
    });

    it('keeps a path that merely contains "login" deeper in the tree', () => {
      // Only /login (exactly), /login?, /login/ are rejected — not /m/login.
      expect(sanitizeNextPath('/m/login')).toBe('/m/login');
    });

    it('keeps a path whose first segment starts with "login" but is longer', () => {
      expect(sanitizeNextPath('/loginhelp')).toBe('/loginhelp');
    });

    it('trims surrounding whitespace before returning', () => {
      // s = raw.trim(); the trimmed value is what gets returned.
      expect(sanitizeNextPath('  /m/chat  ')).toBe('/m/chat');
    });
  });

  describe('open-redirect attempts are neutralised to "/"', () => {
    it('rejects protocol-relative "//evil.com"', () => {
      expect(sanitizeNextPath('//evil.com')).toBe('/');
    });

    it('rejects an absolute https URL', () => {
      expect(sanitizeNextPath('https://evil.com')).toBe('/');
    });

    it('rejects an absolute http URL', () => {
      expect(sanitizeNextPath('http://evil.com/path')).toBe('/');
    });

    it('rejects the backslash bypass "/\\evil.com"', () => {
      expect(sanitizeNextPath('/\\evil.com')).toBe('/');
    });

    it('rejects a scheme-only value lacking a leading slash', () => {
      expect(sanitizeNextPath('javascript:alert(1)')).toBe('/');
    });

    it('rejects a value not starting with "/"', () => {
      expect(sanitizeNextPath('evil.com')).toBe('/');
    });

    it('rejects a whitespace-padded protocol-relative URL (trim then //)', () => {
      expect(sanitizeNextPath('   //evil.com')).toBe('/');
    });
  });

  describe('control chars / newlines are rejected (header smuggling)', () => {
    it('rejects an embedded newline', () => {
      expect(sanitizeNextPath('/m/chat\nSet-Cookie: x=1')).toBe('/');
    });

    it('rejects a carriage return', () => {
      expect(sanitizeNextPath('/m/chat\rfoo')).toBe('/');
    });

    it('rejects a NUL byte', () => {
      expect(sanitizeNextPath('/m/\x00chat')).toBe('/');
    });

    it('rejects a DEL (0x7f) byte', () => {
      expect(sanitizeNextPath('/m/chat\x7f')).toBe('/');
    });

    it('rejects a tab (0x09 is a control char in the regex range)', () => {
      // \t survives .trim() only when interior; here it's interior so the
      // [\x00-\x1f] check fires.
      expect(sanitizeNextPath('/m/a\tb')).toBe('/');
    });
  });

  describe('/login loops are rejected', () => {
    it('rejects exactly "/login"', () => {
      expect(sanitizeNextPath('/login')).toBe('/');
    });

    it('rejects "/login?next=..."', () => {
      expect(sanitizeNextPath('/login?next=%2Fm%2Fchat')).toBe('/');
    });

    it('rejects "/login/sub"', () => {
      expect(sanitizeNextPath('/login/whatever')).toBe('/');
    });
  });

  describe('empty / non-string inputs collapse to fallback', () => {
    it('empty string → "/"', () => {
      expect(sanitizeNextPath('')).toBe('/');
    });

    it('whitespace-only string → "/"', () => {
      expect(sanitizeNextPath('   ')).toBe('/');
    });

    it('null → "/"', () => {
      expect(sanitizeNextPath(null)).toBe('/');
    });

    it('undefined → "/"', () => {
      expect(sanitizeNextPath(undefined)).toBe('/');
    });

    it('number → "/"', () => {
      expect(sanitizeNextPath(42)).toBe('/');
    });

    it('object → "/"', () => {
      expect(sanitizeNextPath({ toString: () => '/m/chat' })).toBe('/');
    });
  });

  describe('length guard', () => {
    it('rejects a path longer than 1024 chars', () => {
      const long = '/' + 'a'.repeat(1024); // length 1025
      expect(sanitizeNextPath(long)).toBe('/');
    });

    it('accepts a path of exactly 1024 chars', () => {
      const exact = '/' + 'a'.repeat(1023); // length 1024
      expect(sanitizeNextPath(exact)).toBe(exact);
    });
  });

  describe('custom fallback', () => {
    it('uses the provided fallback for an invalid input', () => {
      expect(sanitizeNextPath('//evil.com', '/m/select')).toBe('/m/select');
    });

    it('uses the provided fallback for a non-string', () => {
      expect(sanitizeNextPath(null, '/home')).toBe('/home');
    });

    it('does not apply the fallback to a valid path', () => {
      expect(sanitizeNextPath('/m/chat', '/home')).toBe('/m/chat');
    });
  });
});
