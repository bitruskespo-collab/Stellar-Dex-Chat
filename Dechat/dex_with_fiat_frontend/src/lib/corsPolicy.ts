// CORS policy for browser-facing financial routes.
//
// This module centralizes the cross-origin policy for routes that touch
// financial state (balances, orders, withdrawals, deposits, etc.). Each route
// is mapped to an explicit set of allowed origins and a credential behavior.
// Helpers evaluate preflight and state-changing requests and reject untrusted
// origins.
//
// Design notes:
// - Policies are restrictive by default: a route must be explicitly listed to
//   be reachable cross-origin. Unknown routes fall back to a deny-all policy.
// - Production and local-development origin sets are kept separate so that
//   localhost origins never leak into production configuration.
// - Credentialed requests are only allowed for explicitly trusted origins.

export type CorsCredentialMode = 'omit' | 'include';

export interface CorsRoutePolicy {
  /** Route path (or path prefix when `prefix` is true). */
  readonly path: string;
  /** When true, `path` is treated as a prefix match. */
  readonly prefix: boolean;
  /** Allowed origins for this route. Empty means no cross-origin access. */
  readonly allowedOrigins: readonly string[];
  /** Whether browsers may send credentials (cookies, auth headers). */
  readonly credentials: CorsCredentialMode;
  /** HTTP methods permitted for this route. */
  readonly methods: readonly string[];
  /** Request headers permitted for this route. */
  readonly allowedHeaders: readonly string[];
}

export type CorsEnvironment = 'production' | 'development';

// Origins trusted in production. These must be exact scheme+host+port matches.
export const PRODUCTION_ORIGINS: readonly string[] = [
  'https://app.dechat.io',
  'https://dechat.io',
];

// Origins trusted only in local development.
export const DEVELOPMENT_ORIGINS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
];

const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS'];
const STATE_CHANGING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

const DEFAULT_ALLOWED_HEADERS: readonly string[] = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
];

/**
 * Returns the set of origins trusted for the given environment.
 */
export function getAllowedOriginsForEnvironment(
  environment: CorsEnvironment,
): readonly string[] {
  return environment === 'production' ? PRODUCTION_ORIGINS : DEVELOPMENT_ORIGINS;
}

/**
 * Builds the per-route policy table for the given environment.
 *
 * Financial routes are enumerated explicitly. Anything not listed here is
 * denied by `resolvePolicy`.
 */
export function buildRoutePolicies(
  environment: CorsEnvironment,
): readonly CorsRoutePolicy[] {
  const origins = getAllowedOriginsForEnvironment(environment);

  return [
    {
      path: '/api/finance/balances',
      prefix: false,
      allowedOrigins: origins,
      credentials: 'include',
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    },
    {
      path: '/api/finance/orders',
      prefix: true,
      allowedOrigins: origins,
      credentials: 'include',
      methods: ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    },
    {
      path: '/api/finance/deposits',
      prefix: true,
      allowedOrigins: origins,
      credentials: 'include',
      methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    },
    {
      path: '/api/finance/withdrawals',
      prefix: true,
      allowedOrigins: origins,
      credentials: 'include',
      methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    },
    {
      path: '/api/finance/transactions',
      prefix: true,
      allowedOrigins: origins,
      credentials: 'include',
      methods: ['GET', 'HEAD', 'OPTIONS'],
      allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    },
  ];
}

const DENY_ALL_POLICY: CorsRoutePolicy = {
  path: '',
  prefix: true,
  allowedOrigins: [],
  credentials: 'omit',
  methods: [],
  allowedHeaders: [],
};

/**
 * Resolves the policy for a request path. Unknown routes get a deny-all policy.
 */
export function resolvePolicy(
  path: string,
  policies: readonly CorsRoutePolicy[],
): CorsRoutePolicy {
  const normalized = normalizePath(path);
  for (const policy of policies) {
    if (policy.prefix) {
      if (normalized === policy.path || normalized.startsWith(policy.path + '/')) {
        return policy;
      }
    } else if (normalized === policy.path) {
      return policy;
    }
  }
  return DENY_ALL_POLICY;
}

function normalizePath(path: string): string {
  if (!path) return '/';
  // Strip query string and fragment, collapse duplicate slashes, drop trailing slash.
  const withoutQuery = path.split('?')[0].split('#')[0];
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

function isOriginAllowed(origin: string | undefined, policy: CorsRoutePolicy): boolean {
  if (!origin) return false;
  return policy.allowedOrigins.includes(origin);
}

function isMethodAllowed(method: string, policy: CorsRoutePolicy): boolean {
  return policy.methods.includes(method.toUpperCase());
}

export interface CorsRequest {
  readonly method: string;
  readonly path: string;
  readonly origin?: string;
  readonly requestedHeaders?: readonly string[];
}

export type CorsDecision =
  | { readonly allowed: true; readonly policy: CorsRoutePolicy }
  | { readonly allowed: false; readonly reason: CorsRejectionReason; readonly policy: CorsRoutePolicy };

export type CorsRejectionReason =
  | 'unknown-route'
  | 'missing-origin'
  | 'untrusted-origin'
  | 'method-not-allowed'
  | 'header-not-allowed';

/**
 * Evaluates a CORS preflight (OPTIONS) request.
 *
 * A preflight is allowed only when:
 * - the route has a policy,
 * - the origin is trusted for that route,
 * - the requested method is permitted,
 * - every requested header is permitted.
 */
export function evaluatePreflight(
  request: CorsRequest,
  policies: readonly CorsRoutePolicy[],
): CorsDecision {
  const policy = resolvePolicy(request.path, policies);

  if (policy.allowedOrigins.length === 0) {
    return { allowed: false, reason: 'unknown-route', policy };
  }
  if (!request.origin) {
    return { allowed: false, reason: 'missing-origin', policy };
  }
  if (!isOriginAllowed(request.origin, policy)) {
    return { allowed: false, reason: 'untrusted-origin', policy };
  }
  if (!isMethodAllowed(request.method, policy)) {
    return { allowed: false, reason: 'method-not-allowed', policy };
  }
  const requestedHeaders = request.requestedHeaders ?? [];
  const allowedHeaderSet = new Set(policy.allowedHeaders.map((h) => h.toLowerCase()));
  for (const header of requestedHeaders) {
    if (!allowedHeaderSet.has(header.toLowerCase())) {
      return { allowed: false, reason: 'header-not-allowed', policy };
    }
  }
  return { allowed: true, policy };
}

/**
 * Evaluates a state-changing (non-safe) request.
 *
 * State-changing requests must come from a trusted origin and use a permitted
 * method. Requests without an Origin header are rejected because browsers
 * always attach one for cross-origin state-changing requests; a missing origin
 * indicates a non-browser or spoofed client.
 */
export function evaluateStateChangingRequest(
  request: CorsRequest,
  policies: readonly CorsRoutePolicy[],
): CorsDecision {
  const policy = resolvePolicy(request.path, policies);

  if (policy.allowedOrigins.length === 0) {
    return { allowed: false, reason: 'unknown-route', policy };
  }
  if (!request.origin) {
    return { allowed: false, reason: 'missing-origin', policy };
  }
  if (!isOriginAllowed(request.origin, policy)) {
    return { allowed: false, reason: 'untrusted-origin', policy };
  }
  if (!isMethodAllowed(request.method, policy)) {
    return { allowed: false, reason: 'method-not-allowed', policy };
  }
  return { allowed: true, policy };
}

/**
 * Returns true when the method is considered safe (no state change).
 */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.includes(method.toUpperCase());
}

/**
 * Returns true when the method is considered state-changing.
 */
export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.includes(method.toUpperCase());
}

/**
 * Builds the response headers for an allowed CORS decision.
 *
 * Returns an empty object when the decision is a rejection, so callers can
 * simply spread the result into their response headers.
 */
export function buildCorsResponseHeaders(
  decision: CorsDecision,
  origin: string | undefined,
): Record<string, string> {
  if (!decision.allowed || !origin) {
    return {};
  }
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  };
  if (decision.policy.credentials === 'include') {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * Builds the response headers for a preflight response.
 */
export function buildPreflightResponseHeaders(
  decision: CorsDecision,
  origin: string | undefined,
): Record<string, string> {
  const headers = buildCorsResponseHeaders(decision, origin);
  if (!decision.allowed) {
    return headers;
  }
  headers['Access-Control-Allow-Methods'] = decision.policy.methods.join(', ');
  headers['Access-Control-Allow-Headers'] = decision.policy.allowedHeaders.join(', ');
  headers['Access-Control-Max-Age'] = '600';
  return headers;
}

/**
 * Convenience guard: throws when a state-changing request is rejected.
 * Intended for use in route handlers that want a hard failure.
 */
export function assertStateChangingRequestAllowed(
  request: CorsRequest,
  policies: readonly CorsRoutePolicy[],
): CorsRoutePolicy {
  const decision = evaluateStateChangingRequest(request, policies);
  if (!decision.allowed) {
    throw new CorsPolicyError(decision.reason);
  }
  return decision.policy;
}

export class CorsPolicyError extends Error {
  readonly reason: CorsRejectionReason;

  constructor(reason: CorsRejectionReason) {
    super(`CORS request rejected: ${reason}`);
    this.name = 'CorsPolicyError';
    this.reason = reason;
  }
}