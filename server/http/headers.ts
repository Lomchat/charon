// Security headers on every response (§13): XFO DENY everywhere but the live
// view (§14.110), which Charon frames and which sends its own sandbox CSP and
// `no-referrer`. A header the handler already set wins. No CSP: none needed
// for an admin tool behind login + reverse proxy, and none would survive the
// inline seed/theme scripts without nonces.

export function securityHeaders(pathname: string): Array<[string, string]> {
  const common: Array<[string, string]> = [
    ['X-Content-Type-Options', 'nosniff'],
    ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()'],
  ];
  // HTTPS only in production: dev serves http://127.0.0.1.
  if (process.env.NODE_ENV === 'production') {
    common.push(['Strict-Transport-Security', 'max-age=31536000; includeSubDomains']);
  }
  if (pathname.startsWith('/api/preview/')) return common;
  return [
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ...common,
  ];
}

/** `res` with headers set (only where absent) or appended. A Response whose
 *  headers are immutable (a proxied fetch) is copied first. */
export function withHeaders(res: Response, entries: Array<[string, string]>, mode: 'default' | 'append'): Response {
  const apply = (r: Response) => {
    for (const [k, v] of entries) {
      if (mode === 'append') r.headers.append(k, v);
      else if (!r.headers.has(k)) r.headers.set(k, v);
    }
  };
  try {
    apply(res);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    apply(copy);
    return copy;
  }
}
