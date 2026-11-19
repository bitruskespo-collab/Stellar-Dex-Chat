import { NextRequest, NextResponse } from 'next/server';
import {
  ReleaseHealthGate,
  DEFAULT_THRESHOLDS,
  type HealthGateThresholds,
  type ReleaseHealthDecision,
} from '@/lib/releaseHealthGate';

export const runtime = 'edge';

// ---------------------------------------------------------------------------
// Process-level gate singleton.
//
// In a standard Node.js / long-lived server process this accumulates samples
// across requests.  In edge/serverless deployments each invocation is
// isolated, so the CI health-gate workflow (release-health-gate.yml) is the
// authoritative cross-deployment check; this endpoint feeds that workflow.
// ---------------------------------------------------------------------------
const gate = new ReleaseHealthGate();

/**
 * Parse optional threshold overrides from query parameters.
 * Only values that are valid numbers in range are accepted; malformed
 * or out-of-range values fall back to the compiled-in defaults.
 */
function parseThresholdOverrides(
  searchParams: URLSearchParams,
): Partial<HealthGateThresholds> {
  const overrides: Partial<HealthGateThresholds> = {};

  const errorRate = Number(searchParams.get('maxErrorRate'));
  if (!Number.isNaN(errorRate) && errorRate > 0 && errorRate <= 1) {
    overrides.maxErrorRate = errorRate;
  }

  const payoutFailures = Number(searchParams.get('maxPayoutFailures'));
  if (
    Number.isInteger(payoutFailures) &&
    payoutFailures > 0
  ) {
    overrides.maxPayoutFailures = payoutFailures;
  }

  const windowMs = Number(searchParams.get('windowMs'));
  if (!Number.isNaN(windowMs) && windowMs > 0) {
    overrides.windowMs = windowMs;
  }

  return overrides;
}

/** Map gate decision to an HTTP status code. */
function decisionToStatus(decision: ReleaseHealthDecision): number {
  switch (decision) {
    case 'HEALTHY':
      return 200;
    case 'DEGRADED':
      return 200; // still serving; callers inspect the body for the warning
    case 'ROLLBACK':
      return 503;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const overrides = parseThresholdOverrides(searchParams);

    // If threshold overrides were supplied create a fresh one-shot gate so the
    // caller can probe what the decision would be under different thresholds
    // without affecting the shared singleton.
    const evaluatingGate =
      Object.keys(overrides).length > 0
        ? new ReleaseHealthGate(overrides)
        : gate;

    const metrics = evaluatingGate.evaluate();
    const httpStatus = decisionToStatus(metrics.decision);

    return NextResponse.json(
      {
        status: metrics.decision === 'HEALTHY' ? 'ok' : metrics.decision.toLowerCase(),
        timestamp: metrics.evaluatedAt,
        releaseHealth: {
          decision: metrics.decision,
          payoutProcessingPermitted: metrics.payoutProcessingPermitted,
          reason: metrics.reason || null,
          metrics: {
            totalRequests: metrics.totalRequests,
            erroredRequests: metrics.erroredRequests,
            errorRate: metrics.errorRate,
            payoutFailures: metrics.payoutFailures,
          },
          thresholds: metrics.thresholds,
          windowMs: metrics.thresholds.windowMs,
        },
      },
      { status: httpStatus },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Health check failed',
      },
      { status: 503 },
    );
  }
}

// ---------------------------------------------------------------------------
// Thin instrumentation helpers — called by other route handlers to feed the
// singleton gate without importing it directly everywhere.
// ---------------------------------------------------------------------------

/**
 * Record the outcome of an API request into the shared health gate.
 * Call this from route middleware or individual handlers.
 *
 * @example
 * ```ts
 * import { recordApiRequest } from '@/app/api/health/route';
 * // Inside a route handler:
 * recordApiRequest(response.status >= 500, '/api/initiate-transfer');
 * ```
 */
export function recordApiRequest(isError: boolean, route?: string): void {
  gate.recordRequest({ isError, route });
}

/**
 * Record a payout processing failure into the shared health gate.
 * Pass only sanitised identifiers — no account numbers, amounts, or PII.
 *
 * @example
 * ```ts
 * import { recordPayoutFailure } from '@/app/api/health/route';
 * recordPayoutFailure(job.idempotencyKey, 'PROVIDER_UNAVAILABLE');
 * ```
 */
export function recordPayoutFailure(
  reference: string,
  category: string,
): void {
  gate.recordPayoutFailure({ reference, category });
}

/**
 * Evaluate the current health gate decision without exposing the full
 * metrics object.  Suitable for inline payout-processing guards.
 *
 * @returns `true` when payout processing is permitted.
 */
export function isPayoutProcessingPermitted(): boolean {
  return gate.evaluate().payoutProcessingPermitted;
}

// Exported for tests that need to inject samples into the module-level gate.
export { gate as _healthGateForTesting, DEFAULT_THRESHOLDS };
