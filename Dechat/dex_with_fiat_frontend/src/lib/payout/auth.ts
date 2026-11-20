/**
 * @fileoverview Server-verifiable wallet identity binding, session management,
 * and ownership authorization for payout and receipt routes.
 *
 * Enforces authenticated ownership against an authenticated wallet address
 * or an authorized operator, preventing insecure direct object references (IDOR).
 */

import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { serverEnv as env } from '@/lib/serverEnv';
import { verifySignature } from '@/lib/stellarSignature';
import { requireAdminAuth } from '@/app/api/admin/_utils/requireAdminAuth';
import { checkRateLimit } from '@/lib/rateLimit';

export type CallerIdentity =
  | { type: 'wallet'; address: string; isOperator: false }
  | { type: 'operator'; address?: string; isOperator: true };

const WALLET_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SIGNATURE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Bounded limits applied before any expensive verification work (HMAC,
 * signature checks) so spoofed or abusive requests cannot exhaust resources.
 */
export const AUTH_RATE_LIMITS = {
  /** Per client IP, across all identity resolution attempts. */
  perIp: { limit: 60, windowMs: 60 * 1000 },
  /** Per claimed wallet address, to bound signature-verification work. */
  perWallet: { limit: 20, windowMs: 60 * 1000 },
} as const;

/**
 * Derives the client IP from trusted proxy headers only.
 *
 * The left-most `x-forwarded-for` entry is attacker-controlled unless a
 * trusted proxy overwrites the header, so we only honor it when the request
 * carries the shared proxy secret. Otherwise we fall back to the
 * platform-provided `x-real-ip` header, and finally to a constant bucket so
 * limits still apply (fail closed) when no trusted source is available.
 */
export function getTrustedClientIp(request: Request): string {
  const proxySecret = env.TRUSTED_PROXY_SECRET;
  const presentedSecret = request.headers.get('x-trusted-proxy-secret');

  if (proxySecret && presentedSecret && presentedSecret === proxySecret) {
    const forwarded = request.headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) {
        return first;
      }
    }
  }

  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}

/**
 * Applies bounded rate limits keyed by trusted client IP and (optionally) the
 * claimed wallet address before expensive identity verification runs.
 *
 * Returns a 429 response when a limit is exceeded, otherwise `null`.
 */
export function enforceAuthRateLimits(
  request: Request,
  claimedWalletAddress?: string | null,
): NextResponse | null {
  const ip = getTrustedClientIp(request);
  const ipResult = checkRateLimit(
    `payout-auth:ip:${ip}`,
    AUTH_RATE_LIMITS.perIp.limit,
    AUTH_RATE_LIMITS.perIp.windowMs,
  );
  if (!ipResult.allowed) {
    return rateLimitedResponse(ipResult.retryAfterMs);
  }

  const wallet = claimedWalletAddress?.trim();
  if (wallet) {
    const walletResult = checkRateLimit(
      `payout-auth:wallet:${wallet}`,
      AUTH_RATE_LIMITS.perWallet.limit,
      AUTH_RATE_LIMITS.perWallet.windowMs,
    );
    if (!walletResult.allowed) {
      return rateLimitedResponse(walletResult.retryAfterMs);
    }
  }

  return null;
}

function rateLimitedResponse(retryAfterMs?: number): NextResponse {
  const headers: Record<string, string> = {};
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    headers['Retry-After'] = String(Math.ceil(retryAfterMs / 1000));
  }
  return NextResponse.json(
    {
      success: false,
      message: 'Too many authentication attempts. Please retry later.',
    },
    { status: 429, headers },
  );
}

function getAuthSecret(): string {
  return env.ADMIN_SECRET || 'dechat-wallet-session-secret-key-32chars';
}

/**
 * Creates a cryptographically signed, server-verifiable session token bound to a wallet address.
 */
export function createWalletSessionToken(
  walletAddress: string,
  ttlMs = WALLET_SESSION_TTL_MS,
): { sessionToken: string; expiresAt: number; address: string } {
  const normalizedAddress = walletAddress.trim();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const payload = `${normalizedAddress}:${issuedAt}:${expiresAt}`;
  const hmac = crypto
    .createHmac('sha256', getAuthSecret())
    .update(payload)
    .digest('hex');

  const sessionToken = Buffer.from(
    JSON.stringify({
      address: normalizedAddress,
      issuedAt,
      expiresAt,
      sig: hmac,
    }),
  ).toString('base64url');

  return { sessionToken, expiresAt, address: normalizedAddress };
}

/**
 * Verifies a server-verifiable session token.
 */
export function verifyWalletSessionToken(
  token: string,
): { address: string; expiresAt: number } | null {
  if (!token || typeof token !== 'string') {
    return null;
  }

  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as {
      address?: string;
      issuedAt?: number;
      expiresAt?: number;
      sig?: string;
    };

    if (
      !parsed.address ||
      !parsed.issuedAt ||
      !parsed.expiresAt ||
      !parsed.sig
    ) {
      return null;
    }

    if (parsed.expiresAt < Date.now()) {
      return null; // Expired
    }

    const payload = `${parsed.address}:${parsed.issuedAt}:${parsed.expiresAt}`;
    const expectedSig = crypto
      .createHmac('sha256', getAuthSecret())
      .update(payload)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSig);
    const actualBuf = Buffer.from(parsed.sig);

    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return null; // Tampered or invalid signature
    }

    return { address: parsed.address, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/**
 * Resolves caller identity from incoming Request.
 * Supports:
 * 1. Operator auth (x-admin-token or admin_session cookie)
 * 2. Server-verified wallet session token (x-wallet-session header, authorization header, or cookie)
 * 3. Direct Stellar signature headers (x-wallet-address, x-wallet-signature, x-wallet-timestamp)
 */
export async function resolveCallerIdentity(
  request: Request,
): Promise<CallerIdentity | null> {
  // 1. Check operator role first (cheap, constant-time token comparison).
  const adminError = requireAdminAuth(request);
  if (!adminError) {
    const adminAddress = request.headers.get('x-admin-address') || undefined;
    return { type: 'operator', address: adminAddress, isOperator: true };
  }

  // 2. Check signed wallet session token. Identity is derived exclusively
  //    from the verified token payload, never from caller-supplied address
  //    headers, so spoofed forwarding/identity headers cannot impersonate.
  const sessionHeader =
    request.headers.get('x-wallet-session') ||
    extractBearerToken(request.headers.get('authorization'));

  if (sessionHeader) {
    const verified = verifyWalletSessionToken(sessionHeader);
    if (verified) {
      return { type: 'wallet', address: verified.address, isOperator: false };
    }
  }

  // Check cookie: wallet_session
  const cookieHeader = request.headers.get('cookie');
  if (cookieHeader) {
    const match = cookieHeader.match(/wallet_session=([^;]+)/);
    if (match && match[1]) {
      const verified = verifyWalletSessionToken(match[1]);
      if (verified) {
        return { type: 'wallet', address: verified.address, isOperator: false };
      }
    }
  }

  // 3. Check direct Stellar wallet signature headers. Apply bounded limits
  //    keyed by trusted IP and claimed wallet before the expensive signature
  //    verification so spoofed headers cannot drive unbounded work.
  const walletAddress = request.headers.get('x-wallet-address');
  const signature = request.headers.get('x-wallet-signature');
  const timestampHeader = request.headers.get('x-wallet-timestamp');

  if (walletAddress && signature && timestampHeader) {
    const limited = enforceAuthRateLimits(request, walletAddress);
    if (limited) {
      return null;
    }

    const timestamp = Number.parseInt(timestampHeader, 10);
    if (Number.isFinite(timestamp)) {
      const now = Date.now();
      if (Math.abs(now - timestamp) <= SIGNATURE_TIMESTAMP_WINDOW_MS) {
        const message = `authenticate:${walletAddress}:${timestamp}`;
        const isValid = await verifySignature(
          message,
          signature,
          walletAddress,
        );
        if (isValid) {
          return { type: 'wallet', address: walletAddress, isOperator: false };
        }
      }
    }
  }

  return null;
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7).trim();
}

/**
 * Returns a standardized non-enumerating 404 response for unknown OR unauthorized resource IDs.
 * Prevents attackers from probing which resource references exist.
 */
export function nonEnumeratingNotFoundResponse(
  resourceType = 'Transfer',
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      message: `${resourceType} not found`,
    },
    { status: 404 },
  );
}

/**
 * Returns a 401 Unauthorized response when request lacks valid authentication.
 */
export function unauthorizedResponse(
  message = 'Authentication required',
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      message,
    },
    { status: 401 },
  );
}

/**
 * Returns a 429 Too Many Requests response when auth rate limits are exceeded.
 */
export function tooManyRequestsResponse(
  retryAfterMs?: number,
): NextResponse {
  return rateLimitedResponse(retryAfterMs);
}
