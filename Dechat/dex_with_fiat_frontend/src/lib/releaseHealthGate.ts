/**
 * Release Health Gate — Issue #284
 *
 * Collects bounded post-deployment error-rate and payout-failure metrics and
 * decides whether to signal a rollback.  Intentionally has no external
 * dependencies so it can run in both Node and Edge runtimes.
 *
 * Design constraints:
 *  - All windows are time-bounded (default 10 min) to prevent unbounded growth.
 *  - Thresholds are configurable so the gate can be tuned per environment.
 *  - Financial-safety properties are preserved: a ROLLBACK decision blocks
 *    further payout processing, it does NOT itself trigger any financial mutation.
 *  - No credentials or real user data are stored; only counters and timestamps.
 */

export type ReleaseHealthDecision = 'HEALTHY' | 'DEGRADED' | 'ROLLBACK';

export interface HealthGateThresholds {
  /**
   * Maximum fraction of requests that may error before the gate fires.
   * Range [0, 1].  Default: 0.05 (5 %).
   */
  maxErrorRate: number;

  /**
   * Absolute count of payout-processing failures within the observation
   * window that triggers rollback.  Default: 3.
   */
  maxPayoutFailures: number;

  /**
   * Observation window in milliseconds.  Samples older than this are
   * discarded on each evaluation.  Default: 600_000 (10 min).
   */
  windowMs: number;

  /**
   * Minimum number of requests that must have been recorded before the
   * error-rate threshold is applied.  Prevents a 100 % error-rate on the
   * very first request from triggering rollback.  Default: 5.
   */
  minRequestsForErrorRate: number;
}

export const DEFAULT_THRESHOLDS: HealthGateThresholds = {
  maxErrorRate: 0.05,
  maxPayoutFailures: 3,
  windowMs: 600_000,
  minRequestsForErrorRate: 5,
};

export interface HealthSample {
  /** Unix timestamp (ms) when the sample was recorded. */
  timestamp: number;
  /** Whether this request resulted in an error (HTTP 5xx or unhandled exception). */
  isError: boolean;
  /** Route or operation label for structured logging. */
  route?: string;
}

export interface PayoutFailureSample {
  /** Unix timestamp (ms) when the failure was recorded. */
  timestamp: number;
  /** Payout provider reference or idempotency key (must NOT contain PII). */
  reference: string;
  /** Error category, e.g. PROVIDER_UNAVAILABLE, INTERNAL_ERROR. */
  category: string;
}

export interface HealthGateMetrics {
  /** Number of request samples in the current window. */
  totalRequests: number;
  /** Number of errored requests in the current window. */
  erroredRequests: number;
  /** Current error rate [0, 1]. */
  errorRate: number;
  /** Number of payout failures in the current window. */
  payoutFailures: number;
  /** Current gate decision. */
  decision: ReleaseHealthDecision;
  /** ISO timestamp when the metrics were evaluated. */
  evaluatedAt: string;
  /** Active threshold configuration. */
  thresholds: HealthGateThresholds;
  /**
   * Human-readable reason when decision is DEGRADED or ROLLBACK.
   * Empty string when HEALTHY.
   */
  reason: string;
  /**
   * Whether new payout processing is permitted under the current decision.
   * false when decision is ROLLBACK.
   */
  payoutProcessingPermitted: boolean;
}

/**
 * ReleaseHealthGate tracks post-deployment health samples and produces a
 * bounded rollback decision.
 *
 * Usage:
 * ```ts
 * const gate = new ReleaseHealthGate();
 *
 * // Record outcomes from API middleware:
 * gate.recordRequest({ isError: res.status >= 500, route: '/api/initiate-transfer' });
 *
 * // Record payout processing failures:
 * gate.recordPayoutFailure({ reference: job.idempotencyKey, category: 'PROVIDER_UNAVAILABLE' });
 *
 * // Evaluate before accepting a new payout:
 * const { decision, payoutProcessingPermitted } = gate.evaluate();
 * if (!payoutProcessingPermitted) throw new ProviderOutageError();
 * ```
 */
export class ReleaseHealthGate {
  private readonly thresholds: HealthGateThresholds;
  private readonly clock: () => number;

  private requestSamples: HealthSample[] = [];
  private payoutFailureSamples: PayoutFailureSample[] = [];

  constructor(
    thresholds: Partial<HealthGateThresholds> = {},
    clock: () => number = Date.now,
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.clock = clock;
  }

  /**
   * Record the outcome of an API request.  Call this from route handlers or
   * middleware for every request that should contribute to health metrics.
   */
  recordRequest(sample: Omit<HealthSample, 'timestamp'>): void {
    this.requestSamples.push({ ...sample, timestamp: this.clock() });
    this.evict();
  }

  /**
   * Record a payout processing failure.  Triggers rollback once
   * `maxPayoutFailures` is reached within the window.
   *
   * Only pass a sanitised reference — no account numbers, amounts, or PII.
   */
  recordPayoutFailure(
    sample: Omit<PayoutFailureSample, 'timestamp'>,
  ): void {
    this.payoutFailureSamples.push({ ...sample, timestamp: this.clock() });
    this.evict();
  }

  /**
   * Evaluate current health and return a gate decision.
   *
   * Decision rules (in priority order):
   *  1. ROLLBACK if payout failures ≥ maxPayoutFailures.
   *  2. ROLLBACK if error rate > maxErrorRate AND requests ≥ minRequestsForErrorRate.
   *  3. DEGRADED if error rate > maxErrorRate / 2 (half-threshold warning).
   *  4. HEALTHY otherwise.
   */
  evaluate(): HealthGateMetrics {
    this.evict();

    const now = this.clock();
    const totalRequests = this.requestSamples.length;
    const erroredRequests = this.requestSamples.filter((s) => s.isError).length;
    const errorRate = totalRequests > 0 ? erroredRequests / totalRequests : 0;
    const payoutFailures = this.payoutFailureSamples.length;

    let decision: ReleaseHealthDecision = 'HEALTHY';
    let reason = '';

    if (payoutFailures >= this.thresholds.maxPayoutFailures) {
      decision = 'ROLLBACK';
      reason = `Payout failures (${payoutFailures}) reached threshold (${this.thresholds.maxPayoutFailures}) within the observation window.`;
    } else if (
      totalRequests >= this.thresholds.minRequestsForErrorRate &&
      errorRate > this.thresholds.maxErrorRate
    ) {
      decision = 'ROLLBACK';
      reason = `Error rate (${(errorRate * 100).toFixed(1)} %) exceeded threshold (${(this.thresholds.maxErrorRate * 100).toFixed(1)} %) over ${totalRequests} requests.`;
    } else if (
      totalRequests >= this.thresholds.minRequestsForErrorRate &&
      errorRate > this.thresholds.maxErrorRate / 2
    ) {
      decision = 'DEGRADED';
      reason = `Error rate (${(errorRate * 100).toFixed(1)} %) is above the warning level (${((this.thresholds.maxErrorRate / 2) * 100).toFixed(1)} %).`;
    }

    return {
      totalRequests,
      erroredRequests,
      errorRate,
      payoutFailures,
      decision,
      evaluatedAt: new Date(now).toISOString(),
      thresholds: { ...this.thresholds },
      reason,
      payoutProcessingPermitted: decision !== 'ROLLBACK',
    };
  }

  /**
   * Discard samples outside the observation window.
   * Called automatically on every record/evaluate.
   */
  private evict(): void {
    const cutoff = this.clock() - this.thresholds.windowMs;
    this.requestSamples = this.requestSamples.filter(
      (s) => s.timestamp >= cutoff,
    );
    this.payoutFailureSamples = this.payoutFailureSamples.filter(
      (s) => s.timestamp >= cutoff,
    );
  }

  /**
   * Reset all samples.  Intended for testing and operator-initiated
   * post-rollback recovery sequences.
   */
  reset(): void {
    this.requestSamples = [];
    this.payoutFailureSamples = [];
  }

  /** Snapshot of raw samples for diagnostic purposes. */
  getSamples(): {
    requests: Readonly<HealthSample>[];
    payoutFailures: Readonly<PayoutFailureSample>[];
  } {
    return {
      requests: [...this.requestSamples],
      payoutFailures: [...this.payoutFailureSamples],
    };
  }
}

/**
 * Process-level singleton.  Import and use this across API route handlers
 * so all metrics accumulate in one place.
 *
 * In edge/serverless deployments each invocation runs in its own context, so
 * this will be a fresh instance per request there — that is acceptable because
 * the CI health-gate workflow is the authoritative cross-deployment check.
 */
export const releaseHealthGate = new ReleaseHealthGate();
