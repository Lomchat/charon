/** @type {import('next').NextConfig} */
//
// Headers de sécurité appliqués globalement. Voir :
//   https://nextjs.org/docs/app/api-reference/next-config-js/headers
//
// Notes :
// - `Strict-Transport-Security` : actif uniquement en production (en dev on
//   sert sur http://127.0.0.1, HSTS forcerait HTTPS et casserait le dev).
// - Pas de CSP volontairement : Next.js inline des `<script>` et des styles
//   sans nonce par défaut, une CSP stricte casserait le SSR. À mettre en
//   place avec nonce SSR si besoin un jour — la priorité ici (admin tool
//   derrière login + reverse proxy) est X-Frame-Options + Referrer-Policy.
// - `Permissions-Policy` désactive les API sensibles qu'on n'utilise jamais.
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
  serverExternalPackages: ['better-sqlite3'],
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
