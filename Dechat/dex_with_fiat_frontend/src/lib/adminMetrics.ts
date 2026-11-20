import { ReconciliationRecord } from '../types';

export interface AdminMetrics {
  bridgeBalance: bigint | null;
  totalDeposited: bigint | null;
  pendingPayouts: number;
  failedPayouts: number;
}

/**
 * Bounded indexer health snapshot.
 *
 * This is the single source of truth for indexer health diagnostics. It must
 * never contain customer identifiers (addresses, emails, account ids, tx
 * hashes tied to a user, etc.). Only bounded, aggregate, or operational
 * values are permitted here.
 */
export interface IndexerHealthSnapshot {
  /** Last successfully processed ledger sequence, or null if unknown. */
  cursor: number | null;
  /** Difference between the network tip ledger and the indexer cursor. */
  ledgerLag: number | null;
  /** Number of retries currently queued/observed for the indexer. */
  retryCount: number | null;
  /** Age in seconds of the oldest unprocessed event, or null if none. */
  oldestUnprocessedEventAgeSeconds: number | null;
}

export type HealthSeverity = 'ok' | 'warning' | 'critical';

export interface HealthThreshold {
  /** Value at or above which the metric is considered a warning. */
  warning: number;
  /** Value at or above which the metric is considered critical. */
  critical: number;
}

/**
 * Alert thresholds for indexer health metrics. Shared by the health route and
 * operational alerting so both evaluate against the same bounds.
 */
export const THRESHOLDS: {
  ledgerLag: HealthThreshold;
  retryCount: HealthThreshold;
  oldestUnprocessedEventAgeSeconds: HealthThreshold;
} = {
  ledgerLag: { warning: 50, critical: 200 },
  retryCount: { warning: 5, critical: 20 },
  oldestUnprocessedEventAgeSeconds: { warning: 300, critical: 900 },
};

/**
 * Evaluates a metric value against a threshold and returns a bounded severity.
 * Missing (null/undefined/NaN) values are treated as 'ok' so that a degraded
 * dependency does not spuriously page; callers can surface unknown state
 * separately via the snapshot fields.
 */
export function severityFor(
  value: number | null | undefined,
  threshold: HealthThreshold,
): HealthSeverity {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'ok';
  }
  if (value >= threshold.critical) {
    return 'critical';
  }
  if (value >= threshold.warning) {
    return 'warning';
  }
  return 'ok';
}

export interface IndexerHealthEvaluation {
  cursor: number | null;
  ledgerLag: number | null;
  retryCount: number | null;
  oldestUnprocessedEventAgeSeconds: number | null;
  severity: {
    ledgerLag: HealthSeverity;
    retryCount: HealthSeverity;
    oldestUnprocessedEventAgeSeconds: HealthSeverity;
  };
  /** Overall severity, the maximum of the individual metric severities. */
  overall: HealthSeverity;
}

const SEVERITY_ORDER: Record<HealthSeverity, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
};

function maxSeverity(a: HealthSeverity, b: HealthSeverity): HealthSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * Evaluates an indexer health snapshot against the shared thresholds and
 * returns bounded severities. The output contains no customer identifiers.
 */
export function evaluateIndexerHealth(
  snapshot: IndexerHealthSnapshot,
): IndexerHealthEvaluation {
  const ledgerLag = severityFor(snapshot.ledgerLag, THRESHOLDS.ledgerLag);
  const retryCount = severityFor(snapshot.retryCount, THRESHOLDS.retryCount);
  const oldestUnprocessedEventAgeSeconds = severityFor(
    snapshot.oldestUnprocessedEventAgeSeconds,
    THRESHOLDS.oldestUnprocessedEventAgeSeconds,
  );

  const overall = maxSeverity(
    maxSeverity(ledgerLag, retryCount),
    oldestUnprocessedEventAgeSeconds,
  );

  return {
    cursor: snapshot.cursor,
    ledgerLag: snapshot.ledgerLag,
    retryCount: snapshot.retryCount,
    oldestUnprocessedEventAgeSeconds: snapshot.oldestUnprocessedEventAgeSeconds,
    severity: {
      ledgerLag,
      retryCount,
      oldestUnprocessedEventAgeSeconds,
    },
    overall,
  };
}

/**
 * Aggregates payout status metrics from reconciliation records
 */
export function aggregatePayoutMetrics(records: ReconciliationRecord[]) {
  return {
    pendingPayouts: records.filter(r => r.payoutStatus === 'pending' || r.status === 'unmatched').length,
    failedPayouts: records.filter(r => r.payoutStatus === 'failed' || r.status === 'error').length,
  };
}

/**
 * Hook or helper could be added here if needed, 
 * but for now we'll use base logic in the components.
 */