import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

// ---------------------------------------------------------------------------
// Content Security Policy (#113)
//
// Origin inventory per environment. Any new third-party origin MUST be added
// here and reviewed before merge (see CSP_ORIGIN_REVIEW.md).
//
//   script-src : self, Sentry (error reporting), Next.js inline bootstrap
//   connect-src: self, Sentry, Stellar Horizon (mainnet + testnet), Freighter
//                wallet bridge, configured RPC/API endpoints
//   img-src    : self, data:, blob:, https: (token/asset icons)
//   frame-src  : self, Freighter wallet bridge
//   form-action: self only
//
// Rollout: start in report-only mode (CSP_REPORT_ONLY=true) with a report
// endpoint, triage violations, then enforce. Nonces are not used because the
// App Router emits inline bootstrap scripts; 'unsafe-inline' is retained for
// script-src until a nonce pipeline is wired through middleware.
// ---------------------------------------------------------------------------

const isDev = process.env.NODE_ENV !== 'production';
const reportOnly = process.env.CSP_REPORT_ONLY === 'true';
const reportUri = process.env.CSP_REPORT_URI ?? '/api/csp-report';

// ---------------------------------------------------------------------------
// Cross-Origin Resource Sharing (#259)
//
// Financial routes (deposits, withdrawals, orders, balances, transfers) are
// browser-facing and must only be reachable from explicitly trusted origins.
// The allow-list is derived from server-side env so production and local
// development can be configured independently:
//
//   FINANCIAL_ALLOWED_ORIGINS  comma-separated list of trusted origins
//                              (e.g. "https://app.example.com,https://admin.example.com")
//   NEXT_PUBLIC_APP_URL        the canonical app origin, always trusted
//
// In development, localhost origins are trusted by default. In production
// they are never trusted unless explicitly listed. Credentials are only
// allowed for explicitly listed origins; wildcard origins are rejected.
// ---------------------------------------------------------------------------

const FINANCIAL_ROUTE_PREFIXES = [
  '/api/financial',
  '/api/deposits',
  '/api/withdrawals',
  '/api/orders',
  '/api/balances',
  '/api/transfers',
];

const DEV_DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== '*');
}

function buildFinancialAllowedOrigins(): string[] {
  const configured = [
    ...parseOrigins(process.env.FINANCIAL_ALLOWED_ORIGINS),
    ...parseOrigins(process.env.NEXT_PUBLIC_APP_URL),
  ];
  const defaults = isDev ? DEV_DEFAULT_ORIGINS : [];
  return Array.from(new Set([...configured, ...defaults]));
}

const financialAllowedOrigins = buildFinancialAllowedOrigins();

function isFinancialRoute(pathname: string): boolean {
  return FINANCIAL_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function financialCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
  };
  if (origin && financialAllowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] =
      'GET, POST, PUT, PATCH, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] =
      'Content-Type, Authorization, X-Requested-With';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(isDev ? ["'unsafe-eval'"] : []),
  'https://*.sentry.io',
];

const connectSrc = [
  "'self'",
  'https://*.sentry.io',
  'https://horizon.stellar.org',
  'https://horizon-testnet.stellar.org',
  'wss://*.freighter.app',
  ...(process.env.NEXT_PUBLIC_RPC_URL ? [process.env.NEXT_PUBLIC_RPC_URL] : []),
  ...(process.env.NEXT_PUBLIC_API_URL ? [process.env.NEXT_PUBLIC_API_URL] : []),
];

const cspDirectives = [
  "default-src 'self'",
  `script-src ${scriptSrc.join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSrc.join(' ')}`,
  "frame-src 'self' https://*.freighter.app",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  `report-uri ${reportUri}`,
];

const cspValue = cspDirectives.join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Financial routes: restrictive CORS. Untrusted origins receive no
        // Access-Control-Allow-* headers, so browsers block the response.
        source: '/api/:path*',
        headers: Object.entries(
          financialCorsHeaders(null),
        ).map(([key, value]) => ({ key, value })),
      },
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          {
            key: reportOnly
              ? 'Content-Security-Policy-Report-Only'
              : 'Content-Security-Policy',
            value: cspValue,
          },
        ],
      },
    ];
  },
};

export { financialAllowedOrigins, isFinancialRoute, financialCorsHeaders };

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: '/monitoring',
  // `disableLogger` is deprecated in @sentry/nextjs v10; use the
  // webpack.treeshake option instead (#1490).
  webpack: {
    treeshake: {
      removeDebugLogging: true,
    },
  },
});
