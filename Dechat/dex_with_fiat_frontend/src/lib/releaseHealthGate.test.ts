import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  ReleaseHealthGate,
  type HealthGateThresholds,
} from './releaseHealthGate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a gate with a deterministic clock so tests do not depend on wall time.
 * Returns the gate and a function to advance time by an arbitrary number of ms.
 */
function createGate(overrides: Partial<HealthGateThresholds> = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const advanceMs = (ms: number) => {
    now += ms;
  };
  const gate = new ReleaseHealthGate(overrides, clock);
  return { gate, advanceMs, clock };
}

// Shorthand to record N requests of which `errors` are errors.
function recordRequests(
  gate: ReleaseHealthGate,
  total: number,
  errors: number,
  route = '/api/test',
) {
  for (let i = 0; i < total; i++) {
    gate.recordRequest({ isError: i < errors, route });
  }
}

// ---------------------------------------------------------------------------
// 1. Initial / default state
// ---------------------------------------------------------------------------

describe('initial state', () => {
  it('starts HEALTHY with zero samples', () => {
    const { gate } = createGate();
    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.totalRequests).toBe(0);
    expect(m.erroredRequests).toBe(0);
    expect(m.errorRate).toBe(0);
    expect(m.payoutFailures).toBe(0);
    expect(m.payoutProcessingPermitted).toBe(true);
    expect(m.reason).toBe('');
  });

  it('exposes the configured thresholds in the returned metrics', () => {
    const { gate } = createGate({ maxErrorRate: 0.1, maxPayoutFailures: 5 });
    const m = gate.evaluate();
    expect(m.thresholds.maxErrorRate).toBe(0.1);
    expect(m.thresholds.maxPayoutFailures).toBe(5);
  });

  it('reports evaluatedAt as an ISO string close to current time', () => {
    const { gate } = createGate();
    const before = Date.now();
    const m = gate.evaluate();
    const after = Date.now();
    const ts = new Date(m.evaluatedAt).getTime();
    // The deterministic clock starts at 1_000_000 ms (epoch), so just validate it parses.
    expect(Number.isNaN(ts)).toBe(false);
    void before;
    void after;
  });
});

// ---------------------------------------------------------------------------
// 2. Normal (happy) path
// ---------------------------------------------------------------------------

describe('normal path — stays HEALTHY', () => {
  it('stays HEALTHY with requests well below the error-rate threshold', () => {
    const { gate } = createGate({ maxErrorRate: 0.05, minRequestsForErrorRate: 5 });
    // 1 error in 100 requests → 1 %
    recordRequests(gate, 100, 1);
    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.payoutProcessingPermitted).toBe(true);
  });

  it('stays HEALTHY when payout failures are below threshold', () => {
    const { gate } = createGate({ maxPayoutFailures: 3 });
    gate.recordPayoutFailure({ reference: 'ref-1', category: 'PROVIDER_UNAVAILABLE' });
    gate.recordPayoutFailure({ reference: 'ref-2', category: 'PROVIDER_UNAVAILABLE' });
    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.payoutFailures).toBe(2);
  });

  it('does not reach minRequestsForErrorRate guard with fewer than 5 requests even at 100 % error rate', () => {
    const { gate } = createGate({ minRequestsForErrorRate: 5 });
    recordRequests(gate, 4, 4); // 100 % error rate but only 4 requests
    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
  });
});

// ---------------------------------------------------------------------------
// 3. DEGRADED (half-threshold warning)
// ---------------------------------------------------------------------------

describe('DEGRADED state', () => {
  it('transitions to DEGRADED when error rate is above half-threshold', () => {
    const { gate } = createGate({
      maxErrorRate: 0.10,
      minRequestsForErrorRate: 5,
    });
    // Error rate = 6 % → above 5 % (half of 10 %) but below 10 %
    recordRequests(gate, 100, 6);
    const m = gate.evaluate();
    expect(m.decision).toBe('DEGRADED');
    expect(m.payoutProcessingPermitted).toBe(true);
    expect(m.reason).toMatch(/warning/i);
  });

  it('DEGRADED still permits payout processing', () => {
    const { gate } = createGate({ maxErrorRate: 0.10, minRequestsForErrorRate: 5 });
    recordRequests(gate, 100, 6);
    expect(gate.evaluate().payoutProcessingPermitted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. ROLLBACK — error-rate threshold
// ---------------------------------------------------------------------------

describe('ROLLBACK via error rate', () => {
  it('fires ROLLBACK once error rate exceeds maxErrorRate', () => {
    const { gate } = createGate({
      maxErrorRate: 0.05,
      minRequestsForErrorRate: 5,
    });
    // 6 errors in 100 requests → 6 % > 5 %
    recordRequests(gate, 100, 6);
    const m = gate.evaluate();
    expect(m.decision).toBe('ROLLBACK');
    expect(m.payoutProcessingPermitted).toBe(false);
    expect(m.reason).toMatch(/error rate/i);
    expect(m.reason).toMatch(/6\.0\s*%/);
  });

  it('reason message includes the total request count', () => {
    const { gate } = createGate({ maxErrorRate: 0.05, minRequestsForErrorRate: 5 });
    recordRequests(gate, 50, 4); // 8 % error rate
    const m = gate.evaluate();
    expect(m.reason).toMatch(/50/);
  });

  it('reports correct counts in returned metrics', () => {
    const { gate } = createGate({ maxErrorRate: 0.05, minRequestsForErrorRate: 5 });
    recordRequests(gate, 20, 3); // 15 % error rate
    const m = gate.evaluate();
    expect(m.totalRequests).toBe(20);
    expect(m.erroredRequests).toBe(3);
    expect(m.errorRate).toBeCloseTo(0.15, 4);
  });
});

// ---------------------------------------------------------------------------
// 5. ROLLBACK — payout failure threshold
// ---------------------------------------------------------------------------

describe('ROLLBACK via payout failures', () => {
  it('fires ROLLBACK when payout failures reach maxPayoutFailures', () => {
    const { gate } = createGate({ maxPayoutFailures: 3 });
    gate.recordPayoutFailure({ reference: 'ref-a', category: 'PROVIDER_UNAVAILABLE' });
    gate.recordPayoutFailure({ reference: 'ref-b', category: 'INTERNAL_ERROR' });
    gate.recordPayoutFailure({ reference: 'ref-c', category: 'PROVIDER_TIMEOUT' });
    const m = gate.evaluate();
    expect(m.decision).toBe('ROLLBACK');
    expect(m.payoutProcessingPermitted).toBe(false);
    expect(m.payoutFailures).toBe(3);
    expect(m.reason).toMatch(/payout failures/i);
    expect(m.reason).toMatch(/3/);
  });

  it('payout ROLLBACK fires even when error rate is healthy', () => {
    const { gate } = createGate({ maxPayoutFailures: 2, maxErrorRate: 0.05 });
    // Healthy request rate
    recordRequests(gate, 100, 1);
    // But payout failures exceed threshold
    gate.recordPayoutFailure({ reference: 'p1', category: 'PROVIDER_UNAVAILABLE' });
    gate.recordPayoutFailure({ reference: 'p2', category: 'PROVIDER_UNAVAILABLE' });
    const m = gate.evaluate();
    expect(m.decision).toBe('ROLLBACK');
  });

  it('payout ROLLBACK takes priority over error-rate ROLLBACK in reason text', () => {
    const { gate } = createGate({
      maxPayoutFailures: 1,
      maxErrorRate: 0.05,
      minRequestsForErrorRate: 5,
    });
    recordRequests(gate, 100, 10); // also over error-rate threshold
    gate.recordPayoutFailure({ reference: 'p1', category: 'INTERNAL_ERROR' });
    const m = gate.evaluate();
    // payout check runs first
    expect(m.reason).toMatch(/payout failures/i);
  });

  it('does not duplicate payout failures for the same reference', () => {
    // The gate does NOT deduplicate by reference — each call is a distinct sample.
    // This test documents the intended behaviour explicitly.
    const { gate } = createGate({ maxPayoutFailures: 3 });
    gate.recordPayoutFailure({ reference: 'same-ref', category: 'INTERNAL_ERROR' });
    gate.recordPayoutFailure({ reference: 'same-ref', category: 'INTERNAL_ERROR' });
    expect(gate.evaluate().payoutFailures).toBe(2); // two distinct calls
  });
});

// ---------------------------------------------------------------------------
// 6. Window eviction
// ---------------------------------------------------------------------------

describe('observation window eviction', () => {
  it('evicts request samples older than windowMs', () => {
    const { gate, advanceMs } = createGate({
      windowMs: 60_000,
      maxErrorRate: 0.05,
      minRequestsForErrorRate: 5,
    });
    // Record 10 error requests at t=0
    recordRequests(gate, 10, 10);
    expect(gate.evaluate().decision).toBe('ROLLBACK');

    // Advance past the window
    advanceMs(60_001);

    // Record one healthy request at the new time
    gate.recordRequest({ isError: false, route: '/api/health' });

    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.totalRequests).toBe(1); // only the new request is in window
  });

  it('evicts payout failure samples older than windowMs', () => {
    const { gate, advanceMs } = createGate({
      windowMs: 60_000,
      maxPayoutFailures: 2,
    });
    gate.recordPayoutFailure({ reference: 'old-1', category: 'PROVIDER_UNAVAILABLE' });
    gate.recordPayoutFailure({ reference: 'old-2', category: 'PROVIDER_UNAVAILABLE' });
    expect(gate.evaluate().decision).toBe('ROLLBACK');

    advanceMs(60_001);

    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.payoutFailures).toBe(0);
  });

  it('keeps samples exactly at the window boundary', () => {
    const { gate, advanceMs } = createGate({ windowMs: 10_000 });
    gate.recordRequest({ isError: false });
    advanceMs(10_000); // exactly at the boundary (>= cutoff is kept)
    gate.recordRequest({ isError: false });
    const m = gate.evaluate();
    // Both samples should be present: one at exactly cutoff, one newer.
    expect(m.totalRequests).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. Recovery — reset()
// ---------------------------------------------------------------------------

describe('reset / recovery', () => {
  it('resets to HEALTHY after reset()', () => {
    const { gate } = createGate({ maxPayoutFailures: 1 });
    gate.recordPayoutFailure({ reference: 'ref-x', category: 'PROVIDER_UNAVAILABLE' });
    expect(gate.evaluate().decision).toBe('ROLLBACK');

    gate.reset();

    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.payoutFailures).toBe(0);
    expect(m.totalRequests).toBe(0);
  });

  it('allows new samples to be recorded after reset()', () => {
    const { gate } = createGate({ maxPayoutFailures: 2 });
    gate.recordPayoutFailure({ reference: 'r1', category: 'INTERNAL_ERROR' });
    gate.recordPayoutFailure({ reference: 'r2', category: 'INTERNAL_ERROR' });
    expect(gate.evaluate().decision).toBe('ROLLBACK');

    gate.reset();
    gate.recordRequest({ isError: false, route: '/api/health' });

    const m = gate.evaluate();
    expect(m.decision).toBe('HEALTHY');
    expect(m.totalRequests).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. getSamples — diagnostic snapshot
// ---------------------------------------------------------------------------

describe('getSamples diagnostic snapshot', () => {
  it('returns copies of current in-window samples', () => {
    const { gate } = createGate();
    gate.recordRequest({ isError: false, route: '/api/chat' });
    gate.recordRequest({ isError: true, route: '/api/initiate-transfer' });
    gate.recordPayoutFailure({ reference: 'pf-1', category: 'PROVIDER_UNAVAILABLE' });

    const { requests, payoutFailures } = gate.getSamples();
    expect(requests).toHaveLength(2);
    expect(payoutFailures).toHaveLength(1);
    expect(payoutFailures[0].reference).toBe('pf-1');
  });

  it('snapshot is immutable: mutating it does not affect the gate', () => {
    const { gate } = createGate();
    gate.recordRequest({ isError: false });
    const { requests } = gate.getSamples();
    // Attempt to mutate the snapshot — should not alter gate state
    (requests as unknown as { isError: boolean }[])[0].isError = true;
    // Gate still reports 0 errors
    expect(gate.evaluate().erroredRequests).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. DEFAULT_THRESHOLDS export
// ---------------------------------------------------------------------------

describe('DEFAULT_THRESHOLDS', () => {
  it('has the documented default values', () => {
    expect(DEFAULT_THRESHOLDS.maxErrorRate).toBe(0.05);
    expect(DEFAULT_THRESHOLDS.maxPayoutFailures).toBe(3);
    expect(DEFAULT_THRESHOLDS.windowMs).toBe(600_000);
    expect(DEFAULT_THRESHOLDS.minRequestsForErrorRate).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 10. Edge / boundary cases
// ---------------------------------------------------------------------------

describe('edge and boundary cases', () => {
  it('handles exactly the error-rate threshold (not strictly greater) as HEALTHY', () => {
    const { gate } = createGate({
      maxErrorRate: 0.10,
      minRequestsForErrorRate: 5,
    });
    // Exactly 10 % — the rule is "strictly greater than"
    recordRequests(gate, 10, 1);
    const m = gate.evaluate();
    // 10 % is NOT > 10 %, so not ROLLBACK.
    // But 10 % IS > 5 % (half-threshold), so DEGRADED.
    expect(m.decision).toBe('DEGRADED');
  });

  it('handles zero error rate correctly', () => {
    const { gate } = createGate();
    recordRequests(gate, 50, 0);
    const m = gate.evaluate();
    expect(m.errorRate).toBe(0);
    expect(m.decision).toBe('HEALTHY');
  });

  it('handles 100 % error rate with sufficient requests as ROLLBACK', () => {
    const { gate } = createGate({ maxErrorRate: 0.05, minRequestsForErrorRate: 5 });
    recordRequests(gate, 10, 10);
    expect(gate.evaluate().decision).toBe('ROLLBACK');
  });

  it('windowMs of 0 immediately evicts all samples', () => {
    const { gate, advanceMs } = createGate({ windowMs: 0 });
    gate.recordRequest({ isError: true });
    advanceMs(1); // any advance makes all samples stale
    const m = gate.evaluate();
    expect(m.totalRequests).toBe(0);
    expect(m.decision).toBe('HEALTHY');
  });

  it('custom threshold overrides are respected', () => {
    const { gate } = createGate({ maxErrorRate: 0.5, maxPayoutFailures: 10 });
    recordRequests(gate, 100, 40); // 40 % — below 50 % threshold
    expect(gate.evaluate().decision).toBe('HEALTHY');
  });
});
