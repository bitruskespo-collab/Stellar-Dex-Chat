import { serverEnv as env } from '@/lib/serverEnv';

// Extend global type for cleanup intervals
declare global {
  var sessionCleanupInterval: ReturnType<typeof setInterval> | undefined;
  var nonceCleanupInterval: ReturnType<typeof setInterval> | undefined;
}

// In-memory session store (in production, use Redis or database)
const sessions = new Map<string, { address: string; expires: number }>();

// Bounded rate limiting applied before any expensive work. Keyed by the
// trusted session token (never by client-supplied forwarding headers).
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 30;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function getTrustedRateLimitKey(request: Request): string {
  // Only the session cookie is a trusted identity source for rate limiting.
  // Forwarding headers (x-forwarded-for, x-real-ip, etc.) are client
  // controlled and MUST NOT be used to derive identity or bypass limits.
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const sessionMatch = cookieHeader.match(/admin_session=([^;]+)/);
    if (sessionMatch) {
      return `session:${sessionMatch[1]}`;
    }
  }
  // Unauthenticated requests share a single bounded bucket so spoofed
  // headers cannot be used to obtain fresh quota.
  return 'anonymous';
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX_ATTEMPTS;
}

// Clean up expired rate limit buckets periodically
if (typeof global.nonceCleanupInterval === 'undefined') {
  global.nonceCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of rateLimitBuckets.entries()) {
      if (bucket.resetAt <= now) {
        rateLimitBuckets.delete(key);
      }
    }
  }, 60 * 1000);
}

// Clean up expired sessions periodically
if (typeof global.sessionCleanupInterval === 'undefined') {
  global.sessionCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, data] of sessions.entries()) {
      if (data.expires < now) {
        sessions.delete(token);
      }
    }
  }, 60 * 1000);
}

export function setAdminSession(token: string, address: string, ttlMs: number) {
  sessions.set(token, {
    address,
    expires: Date.now() + ttlMs,
  });
}

export function deleteAdminSession(token: string) {
  sessions.delete(token);
}

export function requireAdminAuth(request: Request): Response | null {
  // Apply bounded rate limiting before any expensive work or secret checks.
  const rateLimitKey = getTrustedRateLimitKey(request);
  if (isRateLimited(rateLimitKey)) {
    return Response.json(
      { error: 'Too Many Requests: rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) } },
    );
  }

  const configuredSecret = env.ADMIN_SECRET;

  const headerToken = request.headers.get('x-admin-token');
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;

  // Basic check: match against secret (header is preferred) - for automation
  if (configuredSecret && (headerToken === configuredSecret || bearerToken === configuredSecret)) {
    return null;
  }

  // Check session cookie
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const sessionMatch = cookieHeader.match(/admin_session=([^;]+)/);
    if (sessionMatch) {
      const sessionToken = sessionMatch[1];
      const session = sessions.get(sessionToken);
      
      if (session && session.expires > Date.now()) {
        // Identity is derived solely from the trusted session record, never
        // from client-supplied headers.
        return null; // Valid session
      }
      
      // Session expired or invalid, delete it
      sessions.delete(sessionToken);
    }
  }

  return Response.json(
    { error: 'Unauthorized: admin authentication required' },
    { status: 401 },
  );
}
