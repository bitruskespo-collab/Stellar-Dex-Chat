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
