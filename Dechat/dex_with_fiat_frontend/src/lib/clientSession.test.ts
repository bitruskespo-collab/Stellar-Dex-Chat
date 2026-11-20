import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RateLimitIdentity = {
  clientIp: string;
  walletAddress: string | null;
};

type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type RateLimitModule = {
  deriveRateLimitIdentity: (input: {
    headers: Record<string, string | undefined>;
    trustedProxyIp?: string | null;
    session?: { walletAddress?: string | null; verified?: boolean } | null;
  }) => RateLimitIdentity;
  checkRateLimit: (identity: RateLimitIdentity) => RateLimitDecision;
  resetRateLimitState: () => void;
  RATE_LIMIT_MAX_REQUESTS: number;
};

const loadRateLimitModule = async (): Promise<RateLimitModule> => {
  const mod = (await import('./rateLimit')) as unknown as RateLimitModule;
  return mod;
};

describe('getOrCreateClientSessionId', () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it('returns the same id across repeated calls in a healthy environment', async () => {
    const { getOrCreateClientSessionId } = await import('./clientSession');

    const first = getOrCreateClientSessionId();
    const second = getOrCreateClientSessionId();

    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('reuses an id already stored in sessionStorage', async () => {
    window.sessionStorage.setItem('stellar_client_session_id', 'existing-id');
    const { getOrCreateClientSessionId } = await import('./clientSession');

    expect(getOrCreateClientSessionId()).toBe('existing-id');
  });

  it('regression: stays consistent across calls even when sessionStorage.setItem throws (e.g. private-browsing quota errors)', async () => {
    // Simulate a browser environment where writes to sessionStorage throw
    // (Safari private mode, exhausted quota, sandboxed iframe, etc).
    vi.spyOn(window.sessionStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { getOrCreateClientSessionId, clientSessionUsedFallbackStorage } = await import(
      './clientSession'
    );

    const first = getOrCreateClientSessionId();
    const second = getOrCreateClientSessionId();

    // Before the fix, every call independently generated a new id whenever
    // persistence failed, so `first !== second` here. The fix caches the
    // resolved id in module scope so both calls agree.
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    // The failure is surfaced (not silent) via a console error the caller
    // can observe/monitor, and via the exported fallback-status flag.
    expect(clientSessionUsedFallbackStorage()).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('returns an empty string during SSR (no window)', async () => {
    const { getOrCreateClientSessionId } = await import('./clientSession');
    const originalWindow = globalThis.window;
    // @ts-expect-error - simulating SSR where window is undefined
    delete globalThis.window;

    expect(getOrCreateClientSessionId()).toBe('');

    globalThis.window = originalWindow;
  });
});

describe('rate-limit identity derivation (spoofing regression)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives client IP from the trusted proxy peer, not from client-supplied forwarding headers', async () => {
    const { deriveRateLimitIdentity } = await loadRateLimitModule();

    const identity = deriveRateLimitIdentity({
      headers: {
        // Attacker-controlled headers that must be ignored.
        'x-forwarded-for': '203.0.113.250, 198.51.100.7',
        'x-real-ip': '203.0.113.250',
        'forwarded': 'for=203.0.113.250',
      },
      trustedProxyIp: '192.0.2.10',
      session: null,
    });

    expect(identity.clientIp).toBe('192.0.2.10');
    expect(identity.clientIp).not.toBe('203.0.113.250');
    expect(identity.clientIp).not.toBe('198.51.100.7');
  });

  it('does not let spoofed forwarding headers change the derived IP across repeated calls', async () => {
    const { deriveRateLimitIdentity } = await loadRateLimitModule();

    const baseline = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: null,
    });

    const spoofed = deriveRateLimitIdentity({
      headers: {
        'x-forwarded-for': '203.0.113.250',
        'x-real-ip': '203.0.113.250',
      },
      trustedProxyIp: '192.0.2.10',
      session: null,
    });

    expect(spoofed.clientIp).toBe(baseline.clientIp);
  });

  it('falls back to a bounded placeholder when no trusted proxy peer is available', async () => {
    const { deriveRateLimitIdentity } = await loadRateLimitModule();

    const identity = deriveRateLimitIdentity({
      headers: { 'x-forwarded-for': '203.0.113.250' },
      trustedProxyIp: null,
      session: null,
    });

    // Must never trust the client-supplied header as the identity.
    expect(identity.clientIp).not.toBe('203.0.113.250');
    expect(identity.clientIp).toBeTruthy();
  });

  it('derives wallet identity only from a verified session', async () => {
    const { deriveRateLimitIdentity } = await loadRateLimitModule();

    const verified = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: { walletAddress: 'GTESTWALLET000000000000000000000000000000000000000000', verified: true },
    });
    expect(verified.walletAddress).toBe(
      'GTESTWALLET000000000000000000000000000000000000000000',
    );

    const unverified = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: { walletAddress: 'GTESTWALLET000000000000000000000000000000000000000000', verified: false },
    });
    expect(unverified.walletAddress).toBeNull();
  });

  it('ignores wallet identity supplied via headers or query-style spoofing', async () => {
    const { deriveRateLimitIdentity } = await loadRateLimitModule();

    const identity = deriveRateLimitIdentity({
      headers: {
        'x-wallet-address': 'GSPOOFED000000000000000000000000000000000000000000',
        'x-stellar-account': 'GSPOOFED000000000000000000000000000000000000000000',
      },
      trustedProxyIp: '192.0.2.10',
      session: null,
    });

    expect(identity.walletAddress).toBeNull();
  });

  it('handles identity changes safely by tracking the new identity independently', async () => {
    const { deriveRateLimitIdentity, checkRateLimit, resetRateLimitState } =
      await loadRateLimitModule();
    resetRateLimitState();

    const walletA = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: { walletAddress: 'GTESTWALLETA00000000000000000000000000000000000000000', verified: true },
    });
    const walletB = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: { walletAddress: 'GTESTWALLETB00000000000000000000000000000000000000000', verified: true },
    });

    expect(walletA.walletAddress).not.toBe(walletB.walletAddress);

    // Exhaust the budget for wallet A.
    const max = (await loadRateLimitModule()).RATE_LIMIT_MAX_REQUESTS;
    for (let i = 0; i < max; i += 1) {
      expect(checkRateLimit(walletA).allowed).toBe(true);
    }
    expect(checkRateLimit(walletA).allowed).toBe(false);

    // Wallet B must not inherit wallet A's exhausted budget.
    expect(checkRateLimit(walletB).allowed).toBe(true);
  });

  it('enforces bounded limits before expensive work is performed', async () => {
    const { deriveRateLimitIdentity, checkRateLimit, resetRateLimitState, RATE_LIMIT_MAX_REQUESTS } =
      await loadRateLimitModule();
    resetRateLimitState();

    const identity = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: null,
    });

    const expensiveWork = vi.fn();

    const attempt = () => {
      const decision = checkRateLimit(identity);
      if (!decision.allowed) {
        return decision;
      }
      expensiveWork();
      return decision;
    };

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) {
      expect(attempt().allowed).toBe(true);
    }
    expect(expensiveWork).toHaveBeenCalledTimes(RATE_LIMIT_MAX_REQUESTS);

    const denied = attempt();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    // The expensive work must not run once the limit is exceeded.
    expect(expensiveWork).toHaveBeenCalledTimes(RATE_LIMIT_MAX_REQUESTS);
  });

  it('does not let spoofed headers bypass an exhausted limit', async () => {
    const { deriveRateLimitIdentity, checkRateLimit, resetRateLimitState, RATE_LIMIT_MAX_REQUESTS } =
      await loadRateLimitModule();
    resetRateLimitState();

    const identity = deriveRateLimitIdentity({
      headers: {},
      trustedProxyIp: '192.0.2.10',
      session: null,
    });

    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) {
      checkRateLimit(identity);
    }
    expect(checkRateLimit(identity).allowed).toBe(false);

    // Rotating spoofed forwarding headers must not reset the budget.
    const spoofed = deriveRateLimitIdentity({
      headers: {
        'x-forwarded-for': '203.0.113.250',
        'x-real-ip': '203.0.113.250',
      },
      trustedProxyIp: '192.0.2.10',
      session: null,
    });
    expect(spoofed.clientIp).toBe(identity.clientIp);
    expect(checkRateLimit(spoofed).allowed).toBe(false);
  });
});
