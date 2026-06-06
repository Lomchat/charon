// Sanitize a post-login redirect target ("next" param) to prevent
// open-redirect attacks. Only same-origin absolute PATHS are allowed (must
// start with a single "/"); anything suspicious collapses to `fallback`.
//
// Used by the login flow so an inactivity-logout from /m/... bounces the user
// back to where they were instead of always landing on the desktop "/" UI.
// `middleware.ts` writes the originating `pathname + search` into ?next=...,
// and `app/login/{page.tsx,actions.ts}` read it back through this guard.
export function sanitizeNextPath(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s || s.length > 1024) return fallback;
  // Must be a relative path. Reject protocol-relative ("//evil.com") and the
  // backslash bypass ("/\evil.com") that some browsers normalize to "//".
  if (!s.startsWith('/')) return fallback;
  if (s.startsWith('//') || s.startsWith('/\\')) return fallback;
  // No control chars / newlines (header/redirect smuggling).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) return fallback;
  // Don't bounce back to the login page itself (avoids a pointless re-login loop).
  if (s === '/login' || s.startsWith('/login?') || s.startsWith('/login/')) return fallback;
  return s;
}
