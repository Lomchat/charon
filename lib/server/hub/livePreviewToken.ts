import crypto from 'node:crypto';

// ── Live-view capability tokens (§14.110) ───────────────────────────────────
// The previewed page runs sandboxed in an OPAQUE origin, so the browser never
// sends it the hub's SameSite cookie — the page's own stylesheet request
// would come back 401. The URL therefore carries its authorization: an HMAC
// over (vps, root, session, expiry), minted by a cookie-authenticated POST
// and checked by the preview route. Stateless on purpose: it survives the
// hub restarting under an open preview (autodeploy), and two copies of this
// module (§14.106) agree without sharing memory.
//
// Read-only, one VPS, one root, the preview's extension allow-list, and dead
// with the login session that minted it.

export type LivePreviewClaims = {
  vpsId: string;
  /** Absolute scope root on the VPS; every served path is relative to it. */
  root: string;
  /** `sessions.id` (the HASH) of the minting login, or the auth-off marker. */
  sid: string;
  /** Expiry, epoch seconds. */
  exp: number;
};

const PREFIX = 'lp1';
/** Long enough for an afternoon on one page; a reload re-mints. */
export const LIVE_PREVIEW_TTL_SECS = 12 * 60 * 60;

function mac(key: Buffer, body: string): string {
  return crypto.createHmac('sha256', key).update(`${PREFIX}.${body}`).digest('base64url');
}

export function signLivePreviewToken(claims: LivePreviewClaims, key: Buffer): string {
  const body = Buffer.from(JSON.stringify({
    v: claims.vpsId, r: claims.root, s: claims.sid, e: claims.exp,
  })).toString('base64url');
  return `${PREFIX}.${body}.${mac(key, body)}`;
}

/** Claims of a genuine, unexpired token — null for anything else. */
export function verifyLivePreviewToken(
  token: string, key: Buffer, nowSecs = Math.floor(Date.now() / 1000),
): LivePreviewClaims | null {
  if (typeof token !== 'string' || token.length > 12_000) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, sig] = parts;
  const want = Buffer.from(mac(key, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof o.v !== 'string' || typeof o.r !== 'string' || typeof o.s !== 'string'
    || typeof o.e !== 'number' || !Number.isFinite(o.e)) return null;
  if (o.e <= nowSecs) return null;
  if (!o.r.startsWith('/')) return null;
  return { vpsId: o.v, root: o.r, sid: o.s, exp: o.e };
}

/**
 * Derive the signing key from what the hub already keeps secret, with a
 * domain label so it is never the AES key or the session HMAC key itself.
 * No secret at all ⇒ a per-process random key: tokens then die with the
 * process, which is a reload, not a hole.
 */
export function deriveLivePreviewKey(secret: Buffer | string | null): Buffer {
  if (!secret || secret.length === 0) return crypto.randomBytes(32);
  return crypto.createHmac('sha256', secret).update('charon/live-preview/v1').digest();
}
