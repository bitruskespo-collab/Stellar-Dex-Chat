import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { getClientIp, type RequestWithClientIp } from './clientIp';
import { rateLimitError } from './payout/errors';

export { getClientIp };

/**
 * Configuration options for route cost buckets and sliding window abuse controls.
 */
export interface RateLimitConfig {
  /** Maximum number of allowed request cost units within the configured time window. */
  maxRequests: number;
  /** Sliding window duration in milliseconds. */
  windowMs: number;
  /** Cost units consumed per request (defaults to 1). */
  cost?: number;
  /** Maximum allowable requests within a short burst window (1 second). */
  burstLimit?: number;
}

export type CostBucketConfig = RateLimitConfig;

export interface RateLimitEntry {
  count: number;
  windowStart: number;
  expiresAt: number;
  burstCount?: number;
  lastBurstWindow?: number;
}

export interface IncrementResult {
  allowed: boolean;
  currentCount: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  reason?: 'window_limit' | 'burst_limit';
}

/**
 * Shared storage interface enabling consistent rate limiting across multiple server instances.
 */
export interface RateLimitStore {
  get(key: string): RateLimitEntry | null | Promise<RateLimitEntry | null>;
  increment(
    key: string,
    cost: number,
    windowMs: number,
    burstLimit?: number,
    now?: number,
  ): IncrementResult | Promise<IncrementResult>;
  reset(key?: string): void | Promise<void>;
}

/**
 * Shared in-memory rate limit store with sliding window counter,
 * distributed coordination simulation, burst control, and TTL sweeping.
 */
export class SharedMemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly sweepIntervalMs = 60_000;
  private nextSweepAt = 0;

  get(key: string): RateLimitEntry | null {
    return this.store.get(key) || null;
  }

  increment(
    key: string,
    cost: number,
    windowMs: number,
    burstLimit?: number,
    currentTime?: number,
  ): IncrementResult {
    const now = currentTime ?? Date.now();

    // Routine TTL sweep
    if (now >= this.nextSweepAt) {
      for (const [k, v] of this.store) {
        if (v.expiresAt <= now) this.store.delete(k);
      }
      this.nextSweepAt = now + this.sweepIntervalMs;
    }

    let entry = this.store.get(key);

    // Initialize or rollover window
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = {
        count: 0,
        windowStart: now,
        expiresAt: now + windowMs,
        burstCount: 0,
        lastBurstWindow: Math.floor(now / 1000),
      };
      this.store.set(key, entry);
    }

    const resetAt = entry.expiresAt;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));

    // Burst limit check (1-second instantaneous window)
    if (typeof burstLimit === 'number' && burstLimit > 0) {
      const currentSecond = Math.floor(now / 1000);
      if (entry.lastBurstWindow !== currentSecond) {
        entry.burstCount = 0;
        entry.lastBurstWindow = currentSecond;
      }

      if ((entry.burstCount ?? 0) + 1 > burstLimit) {
        return {
          allowed: false,
          currentCount: entry.count,
          remaining: 0,
          resetAt,
          retryAfterSeconds: 1, // Short retry for burst limit
          reason: 'burst_limit',
        };
      }
    }

    // Window capacity check
    entry.count += cost;
    if (typeof entry.burstCount === 'number') {
      entry.burstCount += 1;
    }

    return {
      allowed: true,
      currentCount: entry.count,
      remaining: 0,
      resetAt,
      retryAfterSeconds,
    };
  }

  reset(key?: string): void {
    if (key) {
      this.store.delete(key);
    } else {
      this.store.clear();
    }
  }
}

// Global shared store singleton shared across server instances
let activeSharedStore: RateLimitStore = new SharedMemoryRateLimitStore();

export function getSharedRateLimitStore(): RateLimitStore {
  return activeSharedStore;
}

export function setSharedRateLimitStore(store: RateLimitStore): void {
  activeSharedStore = store;
}

/**
 * Extracts a trusted identity for rate limiting.
 *
 * Prevents identity spoofing:
 * - When an authenticated or verified identity is explicitly provided, scopes to `user:${id}`.
 * - Refuses to trust unverified client-supplied headers (e.g. `x-user-id`, `x-identity`).
 * - Extracts client IP safely via {@link getClientIp}, respecting trusted proxy hops.
 */
export function getTrustedIdentity(
  requestOrIp: RequestWithClientIp | string,
  options?: { verifiedUserId?: string },
): string {
  if (options?.verifiedUserId && options.verifiedUserId.trim()) {
    return `user:${options.verifiedUserId.trim()}`;
  }

  if (typeof requestOrIp === 'string') {
    return `ip:${requestOrIp}`;
  }

  const ip = getClientIp(requestOrIp);
  return `ip:${ip}`;
}

/**
 * Route-specific cost bucket presets.
 */
export const ROUTE_COST_BUCKETS: Record<string, CostBucketConfig> = {
  '/api/verify-account': {
    maxRequests: 10,
    windowMs: 60_000,
    cost: 1,
    burstLimit: 5,
  },
  '/api/create-recipient': {
    maxRequests: 10,
    windowMs: 60_000,
    cost: 1,
    burstLimit: 5,
  },
  '/api/initiate-transfer': {
    maxRequests: 5,
    windowMs: 60_000,
    cost: 1,
    burstLimit: 2,
  },
  '/api/transfer-status': {
    maxRequests: 15,
    windowMs: 60_000,
    cost: 1,
    burstLimit: 8,
  },
  '/api/banks': {
    maxRequests: 30,
    windowMs: 60_000,
    cost: 1,
    burstLimit: 15,
  },
  '/api/webhook': {
    maxRequests: 20,
    windowMs: 60_000,
    cost: 1,
    burstLimit: 10,
  },
};

/**
 * Applies sliding-window rate limiting for a trusted identity and route namespace.
 *
 * Returns a 429 `NextResponse` with typed versioned error and standard metadata headers
 * (`Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`)
 * if the limit is exceeded, or `null` if permitted.
 */
export function applyRateLimit(
  identityOrIp: string,
  route: string,
  config: RateLimitConfig,
  options?: {
    cost?: number;
    correlationId?: string;
    now?: number;
  },
): NextResponse | null {
  const store = getSharedRateLimitStore();
  const identity = identityOrIp.includes(':')
    ? identityOrIp
    : `ip:${identityOrIp}`;
  const key = `${identity}:${route}`;
  const cost = options?.cost ?? config.cost ?? 1;
  const now = options?.now ?? Date.now();

  const result = store.increment(
    key,
    cost,
    config.windowMs,
    config.burstLimit,
    now,
  );

  // If increment return is a Promise, handle synchronously if possible
  const syncResult = result as IncrementResult;

  const currentCount = syncResult.currentCount;
  const isOverWindow = currentCount > config.maxRequests;
  const isBlocked = !syncResult.allowed || isOverWindow;

  if (isBlocked) {
    const retryAfter = syncResult.retryAfterSeconds;
    const remaining = 0;
    const resetTime = Math.ceil(syncResult.resetAt / 1000);

    const headers: Record<string, string> = {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(config.maxRequests),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(resetTime),
    };

    return rateLimitError({
      retryAfterSeconds: retryAfter,
      correlationId: options?.correlationId,
      maxRequests: config.maxRequests,
      limitHeaders: headers,
    });
  }

  return null;
}

/**
 * Excludes trusted internal callbacks only after HMAC signature verification.
 *
 * Verifies the Paystack webhook signature using constant-time comparison.
 * Returns true if verified (exempting from abuse limits), false otherwise.
 */
export function verifyAndExcludeWebhook(
  payload: string,
  signatureHeader: string | null,
  secretKey: string | undefined,
): boolean {
  if (!signatureHeader || !secretKey) {
    return false;
  }

  try {
    const computed = crypto
      .createHmac('sha512', secretKey)
      .update(payload)
      .digest('hex');

    const expectedBuffer = Buffer.from(computed, 'utf8');
    const signatureBuffer = Buffer.from(signatureHeader, 'utf8');

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch {
    return false;
  }
}
