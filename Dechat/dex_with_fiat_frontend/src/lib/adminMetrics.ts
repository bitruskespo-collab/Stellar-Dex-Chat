import { ReconciliationRecord } from '../types';

export interface AdminMetrics {
  bridgeBalance: bigint | null;
  totalDeposited: bigint | null;
  pendingPayouts: number;
  failedPayouts: number;
}

/**
 * Default age SLO thresholds (in milliseconds) for unresolved payouts.
 * A payout is considered to breach the SLO once its age exceeds the threshold.
 */
export const DEFAULT_AGE_SLO_MS = {
  pending: 24 * 60 * 60 * 1000, // 24 hours
  unmatched: 48 * 60 * 60 * 1000, // 48 hours
  failed: 12 * 60 * 60 * 1000, // 12 hours
  error: 12 * 60 * 60 * 1000, // 12 hours
} as const;

export interface AgeSloThresholds {
  pending: number;
  unmatched: number;
  failed: number;
  error: number;
}

export interface PayoutSloSummary {
  /** Total amount at risk across unresolved payouts (in minor units). */
  totalAmountAtRisk: bigint;
  /** Number of unresolved payouts that have breached their age SLO. */
  breachingCount: number;
  /** Age (ms) of the oldest unresolved payout, or null if none. */
  oldestUnresolvedAgeMs: number | null;
  /** Number of unresolved payouts considered in the aggregation. */
  unresolvedCount: number;
}

export interface TotalsVerificationResult {
  /** Whether the UI-displayed totals match the DB-query totals. */
  matches: boolean;
  /** Human-readable description of any mismatch, or null when matching. */
  mismatchReason: string | null;
  /** The UI-displayed totals that were verified. */
  displayed: {
    pendingPayouts: number;
    failedPayouts: number;
    totalAmountAtRisk: bigint;
  };
  /** The DB-query totals used for comparison. */
  database: {
    pendingPayouts: number;
    failedPayouts: number;
    totalAmountAtRisk: bigint;
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

function isUnresolved(record: ReconciliationRecord): boolean {
  return (
    record.payoutStatus === 'pending' ||
    record.payoutStatus === 'failed' ||
    record.status === 'unmatched' ||
    record.status === 'error'
  );
}

function getSloThresholdMs(
  record: ReconciliationRecord,
  thresholds: AgeSloThresholds,
): number {
  if (record.payoutStatus === 'pending') return thresholds.pending;
  if (record.payoutStatus === 'failed') return thresholds.failed;
  if (record.status === 'unmatched') return thresholds.unmatched;
  if (record.status === 'error') return thresholds.error;
  return thresholds.pending;
}

function getRecordAgeMs(record: ReconciliationRecord, now: number): number | null {
  const timestamp = record.createdAt ?? record.updatedAt;
  if (!timestamp) return null;
  const parsed = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, now - parsed);
}

function getRecordAmount(record: ReconciliationRecord): bigint {
  const raw = record.amount;
  if (raw === null || raw === undefined) return 0n;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return 0n;
    return BigInt(Math.trunc(raw));
  }
  try {
    return BigInt(String(raw));
  } catch {
    return 0n;
  }
}

/**
 * Computes SLO-oriented aggregates for unresolved payouts:
 * total amount at risk, count of age-SLO breaches, and oldest unresolved age.
 */
export function aggregatePayoutSlo(
  records: ReconciliationRecord[],
  options: {
    now?: number;
    thresholds?: Partial<AgeSloThresholds>;
  } = {},
): PayoutSloSummary {
  const now = options.now ?? Date.now();
  const thresholds: AgeSloThresholds = {
    ...DEFAULT_AGE_SLO_MS,
    ...options.thresholds,
  };

  let totalAmountAtRisk = 0n;
  let breachingCount = 0;
  let oldestUnresolvedAgeMs: number | null = null;
  let unresolvedCount = 0;

  for (const record of records) {
    if (!isUnresolved(record)) continue;
    unresolvedCount += 1;
    totalAmountAtRisk += getRecordAmount(record);

    const ageMs = getRecordAgeMs(record, now);
    if (ageMs === null) continue;

    if (oldestUnresolvedAgeMs === null || ageMs > oldestUnresolvedAgeMs) {
      oldestUnresolvedAgeMs = ageMs;
    }

    if (ageMs > getSloThresholdMs(record, thresholds)) {
      breachingCount += 1;
    }
  }

  return {
    totalAmountAtRisk,
    breachingCount,
    oldestUnresolvedAgeMs,
    unresolvedCount,
  };
}

/**
 * Compares UI-displayed totals against DB-query totals and surfaces mismatches.
 * Used by the admin page and reconciliation API to verify displayed figures.
 */
export function verifyDisplayedTotals(
  displayed: {
    pendingPayouts: number;
    failedPayouts: number;
    totalAmountAtRisk: bigint;
  },
  database: {
    pendingPayouts: number;
    failedPayouts: number;
    totalAmountAtRisk: bigint;
  },
): TotalsVerificationResult {
  const mismatches: string[] = [];

  if (displayed.pendingPayouts !== database.pendingPayouts) {
    mismatches.push(
      `pendingPayouts mismatch: displayed=${displayed.pendingPayouts} database=${database.pendingPayouts}`,
    );
  }
  if (displayed.failedPayouts !== database.failedPayouts) {
    mismatches.push(
      `failedPayouts mismatch: displayed=${displayed.failedPayouts} database=${database.failedPayouts}`,
    );
  }
  if (displayed.totalAmountAtRisk !== database.totalAmountAtRisk) {
    mismatches.push(
      `totalAmountAtRisk mismatch: displayed=${displayed.totalAmountAtRisk.toString()} database=${database.totalAmountAtRisk.toString()}`,
    );
  }

  return {
    matches: mismatches.length === 0,
    mismatchReason: mismatches.length === 0 ? null : mismatches.join('; '),
    displayed,
    database,
  };
}

/**
 * Hook or helper could be added here if needed, 
 * but for now we'll use base logic in the components.
 */