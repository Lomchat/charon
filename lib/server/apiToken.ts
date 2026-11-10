// Automation token (CLAUDE.md §12).
//
// `CHARON_API_TOKEN` lets a program on the box (a benchmark runner, a cron…)
// create, drive and read sessions with `Authorization: Bearer <token>`, without
// a browser login. It is deliberately NOT a second password:
//
// - only the routes in API_TOKEN_ROUTES accept it, and the MIDDLEWARE enforces
//   that list (a token on any other route is a 401, never a cookie fallback);
// - unset, or shorter than MIN_TOKEN_LENGTH, the whole path is OFF (fail closed);
// - no CSRF check applies: a Bearer request carries no ambient credential.
//
// What the list grants is still a lot: creating a session in any folder with
// any permission mode is code execution on that VPS. Treat the token like the
// SSH key it effectively is.
import crypto from 'node:crypto';

export const MIN_TOKEN_LENGTH = 32;

/** `sessionId` reported by `readSession` for a token-authenticated request. */
export const API_TOKEN_SESSION_ID = 'api-token';

type Env = Record<string, string | undefined>;

/** Does this `Authorization` header carry the configured automation token? */
export function apiTokenMatches(authorization: string | null | undefined, env: Env = process.env): boolean {
  const expected = (env.CHARON_API_TOKEN ?? '').trim();
  if (expected.length < MIN_TOKEN_LENGTH || !authorization) return false;
  const m = /^Bearer ([^\s]+)$/.exec(authorization.trim());
  if (!m) return false;
  // Hash both sides: timingSafeEqual needs equal lengths, and comparing
  // digests leaks neither the length nor a prefix of the token.
  const given = crypto.createHash('sha256').update(m[1]).digest();
  const wanted = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(given, wanted);
}

/** A header that ASKS for token auth (any Bearer), valid or not. */
export function isBearerAttempt(authorization: string | null | undefined): boolean {
  return !!authorization && /^Bearer\s/i.test(authorization.trim());
}

// Session ids are lowercase hex. A wider class would also match the static
// siblings (`/api/sessions/import`, `/reorder`, `/bulk-delete`).
const ID = '[0-9a-f]{8,64}';
const API_TOKEN_ROUTES: ReadonlyArray<readonly [method: string, path: RegExp]> = [
  ['GET', /^\/api\/sessions$/],
  ['POST', /^\/api\/sessions$/],
  ['GET', new RegExp(`^/api/sessions/${ID}$`)],
  ['GET', new RegExp(`^/api/sessions/${ID}/endpoint$`)],
  ['POST', new RegExp(`^/api/sessions/${ID}/(input|endpoint|effort|sleep|force-stop|archive|hidden)$`)],
  ['GET', /^\/api\/accounts$/],
  ['GET', /^\/api\/custom-endpoints$/],
  ['GET', /^\/api\/(claude|codex|cursor)\/models$/],
];

/** Is this route open to the automation token? Pathname as Next normalized it. */
export function apiTokenRouteAllowed(method: string, pathname: string): boolean {
  return API_TOKEN_ROUTES.some(([m, re]) => m === method && re.test(pathname));
}
