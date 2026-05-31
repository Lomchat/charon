/** @type {import('next').NextConfig} */
//
// Globally-applied security headers. See:
//   https://nextjs.org/docs/app/api-reference/next-config-js/headers
//
// Notes:
// - `Strict-Transport-Security` is only enabled in production. In dev we
//   serve on http://127.0.0.1 and HSTS would force HTTPS, breaking dev.
// - No CSP on purpose: Next.js inlines `<script>` and style tags without a
//   nonce by default, and a strict CSP would break SSR. Worth implementing
//   with a nonce-aware SSR layer one day — but the priority here, for an
//   admin tool sitting behind login + reverse proxy, is X-Frame-Options
//   and Referrer-Policy.
// - `Permissions-Policy` disables sensitive browser APIs we never use.
// - `reactStrictMode: false` is intentional. Dev double-render duplicates
//   SSE events and races on the interaction queues (permission popups).
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig = {
  // Native modules must stay external so Next doesn't try to bundle their
  // .node binaries (which would break SSR / the server runtime). `node-pty`
  // (remote tmux shells) joins `better-sqlite3` here; both are compiled
  // against the running Node ABI and must be rebuilt on a Node upgrade.
  serverExternalPackages: ['better-sqlite3', 'node-pty'],
  reactStrictMode: false,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
