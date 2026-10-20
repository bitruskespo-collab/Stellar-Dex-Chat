import { NextRequest } from 'next/server';
import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import {
  getClientIp,
  applyRateLimit,
  getTrustedIdentity,
  SharedMemoryRateLimitStore,
  setSharedRateLimitStore,
  getSharedRateLimitStore,
  verifyAndExcludeWebhook,
  type RateLimitConfig,
} from './rateLimit';
import crypto from 'crypto';

describe('Rate Limiting & Abuse Controls (#44)', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    setSharedRateLimitStore(new SharedMemoryRateLimitStore());
  });

  describe('Identity Spoofing Protection', () => {
    it('uses verified user identity when authenticated', () => {
      const identity = getTrustedIdentity('192.168.1.1', {
        verifiedUserId: 'user-456',
      });
      expect(identity).toBe('user:user-456');
    });

    it('falls back to client IP and ignores untrusted user spoof headers', () => {
      const req = new NextRequest('http://localhost', {
        headers: {
          'x-user-id': 'admin',
          'x-real-ip': '203.0.113.10',
        },
      });
      const identity = getTrustedIdentity(req);
      expect(identity).toBe('ip:203.0.113.10');
      expect(identity).not.toContain('admin');
    });

    it('ignores spoofed XFF values when no proxy hops are trusted', () => {
      vi.stubEnv('TRUSTED_PROXY_HOPS', '0');
      const first = new NextRequest('http://localhost', {
        headers: { 'x-forwarded-for': '198.51.100.101' },
      });
      const second = new NextRequest('http://localhost', {
        headers: { 'x-forwarded-for': '198.51.100.202' },
      });

      const config = { maxRequests: 1, windowMs: 60_000 };
      const firstResult = applyRateLimit(
        getClientIp(first),
        'rotating-spoof-test',
        config,
      );
      const secondResult = applyRateLimit(
        getClientIp(second),
        'rotating-spoof-test',
        config,
      );

      expect(firstResult).toBeNull();
      expect(secondResult?.status).toBe(429);
      vi.unstubAllEnvs();
    });
  });

  describe('Route-Specific Cost Buckets & Burst Limits', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('enforces cost per request within the bucket', () => {
      const identity = 'user:alice';
      const route = '/api/initiate-transfer';
      const config: RateLimitConfig = {
        maxRequests: 10,
        windowMs: 60_000,
        cost: 3, // each request consumes 3 units
      };

      // 1st request: count = 3 (allowed)
      expect(applyRateLimit(identity, route, config)).toBeNull();
      // 2nd request: count = 6 (allowed)
      expect(applyRateLimit(identity, route, config)).toBeNull();
      // 3rd request: count = 9 (allowed)
      expect(applyRateLimit(identity, route, config)).toBeNull();
      // 4th request: count = 12 (exceeds maxRequests 10 -> blocked)
      const res = applyRateLimit(identity, route, config);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(429);
    });

    it('enforces burst limits for rapid successive calls', () => {
      const identity = 'user:bob';
      const route = '/api/verify-account';
      const config: RateLimitConfig = {
        maxRequests: 20,
        windowMs: 60_000,
        burstLimit: 3, // max 3 requests in the same 1-second burst window
      };

      expect(applyRateLimit(identity, route, config)).toBeNull();
      expect(applyRateLimit(identity, route, config)).toBeNull();
      expect(applyRateLimit(identity, route, config)).toBeNull();

      // 4th request in the same second violates burst limit
      const blocked = applyRateLimit(identity, route, config);
      expect(blocked).not.toBeNull();
      expect(blocked?.status).toBe(429);

      // Advance by 1 second -> burst window resets
      vi.advanceTimersByTime(1100);
      expect(applyRateLimit(identity, route, config)).toBeNull();
    });
  });

  describe('Shared Storage Across Server Instances (Distributed Counters)', () => {
    it('behaves consistently across simulated server instances sharing storage', () => {
      const sharedStore = new SharedMemoryRateLimitStore();
      setSharedRateLimitStore(sharedStore);

      const identity = 'ip:198.51.100.50';
      const route = '/api/verify-account';
      const config: RateLimitConfig = { maxRequests: 2, windowMs: 10_000 };

      // Instance A executes request 1
      const resA1 = applyRateLimit(identity, route, config);
      expect(resA1).toBeNull();

      // Instance B executes request 2 on the same shared store
      const resB1 = applyRateLimit(identity, route, config);
      expect(resB1).toBeNull();

      // Instance C executes request 3 -> blocked by distributed count
      const resC1 = applyRateLimit(identity, route, config);
      expect(resC1).not.toBeNull();
      expect(resC1?.status).toBe(429);
    });
  });

  describe('Safe Recovery After Limit Window', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets and recovers safely after the window duration has elapsed', () => {
      const identity = 'ip:10.0.0.99';
      const route = '/api/banks';
      const config: RateLimitConfig = { maxRequests: 2, windowMs: 5000 };

      applyRateLimit(identity, route, config);
      applyRateLimit(identity, route, config);
      expect(applyRateLimit(identity, route, config)).not.toBeNull(); // Blocked

      // Advance time past the 5-second window
      vi.advanceTimersByTime(5100);

      // Safe recovery
      expect(applyRateLimit(identity, route, config)).toBeNull();
    });
  });

  describe('Standard Retry Metadata', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns standard headers and versioned error response', async () => {
      const identity = 'ip:10.0.0.88';
      const route = '/api/create-recipient';
      const config: RateLimitConfig = { maxRequests: 1, windowMs: 10_000 };

      applyRateLimit(identity, route, config);
      const res = applyRateLimit(identity, route, config);

      expect(res).not.toBeNull();
      expect(res?.status).toBe(429);
      expect(res?.headers.get('Retry-After')).toBe('10');
      expect(res?.headers.get('X-RateLimit-Limit')).toBe('1');
      expect(res?.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(res?.headers.get('X-RateLimit-Reset')).toBeDefined();

      const body = await res?.json();
      expect(body.version).toBe('v1');
      expect(body.success).toBe(false);
      expect(body.retryAfter).toBe(10);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.category).toBe('rate_limit');
      expect(body.error.retryable).toBe(true);
    });
  });

  describe('Trusted Internal Callbacks Signature Verification', () => {
    const secretKey = 'my-webhook-secret';
    const payload = JSON.stringify({ event: 'transfer.success', id: 123 });

    it('excludes trusted internal callbacks only after signature verification', () => {
      const validSig = crypto
        .createHmac('sha512', secretKey)
        .update(payload)
        .digest('hex');

      // Valid signature -> verified and excluded
      expect(verifyAndExcludeWebhook(payload, validSig, secretKey)).toBe(true);

      // Missing signature -> not verified
      expect(verifyAndExcludeWebhook(payload, null, secretKey)).toBe(false);

      // Tampered payload -> not verified
      expect(
        verifyAndExcludeWebhook(payload + 'tampered', validSig, secretKey),
      ).toBe(false);

      // Invalid secret -> not verified
      expect(verifyAndExcludeWebhook(payload, validSig, 'wrong-secret')).toBe(
        false,
      );
    });
  });
});
