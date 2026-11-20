import fs from 'fs';
import path from 'path';
import { payoutAuditLedger, PayoutAuditLedger } from './auditLedger';

export type DomainPayoutStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export interface RejectedEventRecord {
  id: string;
  eventId: string;
  payoutReference: string;
  eventType: string;
  currentStatus?: DomainPayoutStatus;
  targetStatus?: DomainPayoutStatus;
  reason: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export type ReconciliationDecisionType =
  | 'APPLIED'
  | 'IDEMPOTENT_NOOP'
  | 'REJECTED_OUT_OF_ORDER'
  | 'UNRECOGNIZED_EVENT';

export interface ReconciliationDecision {
  decision: ReconciliationDecisionType;
  currentStatus?: DomainPayoutStatus;
  targetStatus?: DomainPayoutStatus;
  effectiveStatus: DomainPayoutStatus;
  reason?: string;
}

export type ReconciliationAlertState =
  | 'OK'
  | 'PENDING_AGING'
  | 'FAILED_UNRESOLVED'
  | 'REVERSED_UNRESOLVED'
  | 'TOTALS_MISMATCH';

export interface ReconciliationSourceEvidence {
  providerReferences: string[];
  transactionHashes: string[];
  auditEntryIds: string[];
}

export interface UnresolvedPayoutRecord {
  payoutReference: string;
  status: DomainPayoutStatus;
  amountMinor: number;
  currency?: string;
  createdAt: string;
  providerReference?: string;
  transactionHash?: string;
  auditEntryIds?: string[];
}

export interface ReconciliationSloEntry {
  payoutReference: string;
  status: DomainPayoutStatus;
  ageSeconds: number;
  ageHours: number;
  amountAtRiskMinor: number;
  currency?: string;
  nextAction: string;
  alertState: ReconciliationAlertState;
  runbookUrl: string;
  evidence: ReconciliationSourceEvidence;
}

export interface ReconciliationSloThresholds {
  pendingAgingSeconds: number;
  failedUnresolvedSeconds: number;
  reversedUnresolvedSeconds: number;
}

export const DEFAULT_RECONCILIATION_SLO_THRESHOLDS: ReconciliationSloThresholds =
  {
    pendingAgingSeconds: 60 * 60,
    failedUnresolvedSeconds: 24 * 60 * 60,
    reversedUnresolvedSeconds: 24 * 60 * 60,
  };

export const RECONCILIATION_RUNBOOK_BASE_URL =
  'https://github.com/Dechat/dex_with_fiat_frontend/blob/main/docs/runbooks/payout-reconciliation.md';

export function getRunbookUrlForAlertState(
  alertState: ReconciliationAlertState,
): string {
  const anchorByState: Record<ReconciliationAlertState, string> = {
    OK: 'healthy-state',
    PENDING_AGING: 'pending-payout-aging',
    FAILED_UNRESOLVED: 'failed-payout-unresolved',
    REVERSED_UNRESOLVED: 'reversed-payout-unresolved',
    TOTALS_MISMATCH: 'reconciliation-totals-mismatch',
  };
  return `${RECONCILIATION_RUNBOOK_BASE_URL}#${anchorByState[alertState]}`;
}

export interface ReconciliationTotals {
  pendingCount: number;
  pendingAmountMinor: number;
  failedCount: number;
  failedAmountMinor: number;
  atRiskCount: number;
  atRiskAmountMinor: number;
}

export interface ReconciliationTotalsMismatch {
  field: keyof ReconciliationTotals;
  expected: number;
  actual: number;
  delta: number;
}

export interface ReconciliationTotalsVerification {
  ok: boolean;
  computed: ReconciliationTotals;
  db: ReconciliationTotals;
  mismatches: ReconciliationTotalsMismatch[];
  runbookUrl: string;
}

export class PayoutReconciliationService {
  private rejectedEvents: RejectedEventRecord[] = [];
  private storageFilePath: string | null = null;
  private auditLedger: PayoutAuditLedger;

  constructor(storageDir?: string, auditLedgerInstance?: PayoutAuditLedger) {
    this.auditLedger = auditLedgerInstance || payoutAuditLedger;
    const dir = storageDir || process.env.PAYOUT_DATA_DIR;
    if (dir) {
      this.initStorage(dir);
    }
  }

  public initStorage(storageDir: string): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(
        storageDir,
        'payout_rejected_events.jsonl',
      );
      this.loadFromFile();
    } catch (err) {
      console.warn('Failed to initialize reconciliation storage:', err);
    }
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.storageFilePath, 'utf8');
      const lines = data.split('\n').filter((l) => l.trim().length > 0);
      this.rejectedEvents = lines.map(
        (l) => JSON.parse(l) as RejectedEventRecord,
      );
    } catch (err) {
      console.warn('Failed to load rejected events from disk:', err);
    }
  }

  private appendRejectedRecord(record: RejectedEventRecord): void {
    this.rejectedEvents.push(record);
    if (!this.storageFilePath) return;

    try {
      fs.appendFileSync(
        this.storageFilePath,
        JSON.stringify(record) + '\n',
        'utf8',
      );
    } catch (err) {
      console.error('Failed to append rejected event to disk:', err);
    }
  }

  /**
   * Maps incoming provider event string to domain payout status.
   */
  public mapEventToStatus(eventType: string): DomainPayoutStatus | null {
    switch (eventType) {
      case 'transfer.success':
        return 'success';
      case 'transfer.failed':
        return 'failed';
      case 'transfer.reversed':
        return 'reversed';
      default:
        return null;
    }
  }

  /**
   * Determines if transition from currentStatus to targetStatus satisfies
   * monotonic precedence rules.
   */
  public evaluateTransition(
    currentStatus: DomainPayoutStatus | undefined,
    targetStatus: DomainPayoutStatus,
  ): { allowed: boolean; reason?: string } {
    if (!currentStatus) {
      return { allowed: true };
    }

    if (currentStatus === targetStatus) {
      return { allowed: true, reason: 'IDEMPOTENT_SAME_STATE' };
    }

    // Monotonic domain rules:
    // 1. Terminal / reversed state cannot regress to anything else
    if (currentStatus === 'reversed') {
      return {
        allowed: false,
        reason: `Monotonic violation: payout is already reversed and cannot transition to ${targetStatus}`,
      };
    }

    // 2. Settled success can only transition to reversed
    if (currentStatus === 'success') {
      if (targetStatus === 'reversed') {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Monotonic violation: settled payout cannot regress to ${targetStatus}`,
      };
    }

    // 3. Terminal failure cannot regress to pending or settled
    if (currentStatus === 'failed') {
      return {
        allowed: false,
        reason: `Monotonic violation: failed payout cannot regress to ${targetStatus}`,
      };
    }

    // 4. Pending can transition to success, failed, reversed, or cancelled
    if (currentStatus === 'pending') {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Invalid transition from ${currentStatus} to ${targetStatus}`,
    };
  }

  /**
   * Reconciles an incoming provider event against current payout state.
   */
  public reconcileEvent(params: {
    eventId: string;
    payoutReference: string;
    eventType: string;
    currentStatus?: DomainPayoutStatus;
    payload?: Record<string, unknown>;
    correlationId?: string;
  }): ReconciliationDecision {
    const {
      eventId,
      payoutReference,
      eventType,
      currentStatus,
      payload,
      correlationId,
    } = params;
    const targetStatus = this.mapEventToStatus(eventType);

    if (!targetStatus) {
      return {
        decision: 'UNRECOGNIZED_EVENT',
        currentStatus,
        effectiveStatus: currentStatus || 'pending',
        reason: `Unrecognized event type: ${eventType}`,
      };
    }

    if (currentStatus === targetStatus) {
      return {
        decision: 'IDEMPOTENT_NOOP',
        currentStatus,
        targetStatus,
        effectiveStatus: currentStatus,
        reason: 'Current state already matches event status',
      };
    }

    const { allowed, reason } = this.evaluateTransition(
      currentStatus,
      targetStatus,
    );

    if (!allowed) {
      const rejectedRecord: RejectedEventRecord = {
        id: `rej_${Date.now()}_${eventId}`,
        eventId,
        payoutReference,
        eventType,
        currentStatus,
        targetStatus,
        reason: reason || 'Out-of-order transition rejected',
        payload: payload || {},
        timestamp: new Date().toISOString(),
      };

      this.appendRejectedRecord(rejectedRecord);

      // Record in immutable audit ledger for finance/audit traceability
      this.auditLedger.recordEvent({
        payoutId: payoutReference,
        action: 'payout_event_rejected',
        actor: 'system:reconciliation',
        requestCorrelationId: correlationId || eventId,
        providerReference: eventId,
        metadata: {
          eventId,
          eventType,
          currentStatus,
          targetStatus,
          reason,
        },
      });

      return {
        decision: 'REJECTED_OUT_OF_ORDER',
        currentStatus,
        targetStatus,
        effectiveStatus: currentStatus || 'pending',
        reason,
      };
    }

    // Transition is allowed: audit record is created for domain action
    let auditAction: 'payout_succeeded' | 'payout_failed' | 'payout_reversed' =
      'payout_succeeded';
    if (targetStatus === 'failed') auditAction = 'payout_failed';
    if (targetStatus === 'reversed') auditAction = 'payout_reversed';

    this.auditLedger.recordEvent({
      payoutId: payoutReference,
      action: auditAction,
      actor: `webhook:${eventType}`,
      requestCorrelationId: correlationId || eventId,
      providerReference: eventId,
      metadata: {
        eventId,
        eventType,
        previousStatus: currentStatus,
        newStatus: targetStatus,
      },
    });

    return {
      decision: 'APPLIED',
      currentStatus,
      targetStatus,
      effectiveStatus: targetStatus,
    };
  }

  /**
   * Retrieve stored rejected or deferred events for investigation.
   */
  public getRejectedEvents(filter?: {
    eventId?: string;
    payoutReference?: string;
  }): RejectedEventRecord[] {
    let result = [...this.rejectedEvents];
    if (filter?.eventId) {
      result = result.filter((r) => r.eventId === filter.eventId);
    }
    if (filter?.payoutReference) {
      result = result.filter(
        (r) => r.payoutReference === filter.payoutReference,
      );
    }
    return result;
  }

  /**
   * Computes reconciliation SLO data (age, amount at risk, next action,
   * source evidence) for a set of unresolved payout records.
   */
  public computeSloEntries(
    records: UnresolvedPayoutRecord[],
    options?: {
      now?: Date;
      thresholds?: Partial<ReconciliationSloThresholds>;
    },
  ): ReconciliationSloEntry[] {
    const now = options?.now ?? new Date();
    const thresholds: ReconciliationSloThresholds = {
      ...DEFAULT_RECONCILIATION_SLO_THRESHOLDS,
      ...(options?.thresholds || {}),
    };

    return records.map((record) => {
      const createdAtMs = Date.parse(record.createdAt);
      const ageSeconds = Number.isFinite(createdAtMs)
        ? Math.max(0, Math.floor((now.getTime() - createdAtMs) / 1000))
        : 0;
      const ageHours = Math.round((ageSeconds / 3600) * 100) / 100;

      let alertState: ReconciliationAlertState = 'OK';
      let nextAction = 'No action required; payout is settled.';

      if (record.status === 'pending') {
        if (ageSeconds >= thresholds.pendingAgingSeconds) {
          alertState = 'PENDING_AGING';
          nextAction =
            'Investigate stalled pending payout: confirm provider transfer status and re-drive or cancel.';
        } else {
          nextAction = 'Monitor pending payout until provider confirmation.';
        }
      } else if (record.status === 'failed') {
        if (ageSeconds >= thresholds.failedUnresolvedSeconds) {
          alertState = 'FAILED_UNRESOLVED';
          nextAction =
            'Resolve failed payout: verify funds returned, notify user, and mark reconciled.';
        } else {
          nextAction = 'Confirm failed payout refund and notify user.';
        }
      } else if (record.status === 'reversed') {
        if (ageSeconds >= thresholds.reversedUnresolvedSeconds) {
          alertState = 'REVERSED_UNRESOLVED';
          nextAction =
            'Reconcile reversed payout: confirm clawback settled and update ledger.';
        } else {
          nextAction = 'Confirm reversed payout clawback completion.';
        }
      } else if (record.status === 'cancelled') {
        nextAction = 'No action required; payout was cancelled before settlement.';
      }

      const amountAtRiskMinor =
        record.status === 'success' || record.status === 'cancelled'
          ? 0
          : Math.max(0, Math.trunc(record.amountMinor));

      const evidence: ReconciliationSourceEvidence = {
        providerReferences: record.providerReference
          ? [record.providerReference]
          : [],
        transactionHashes: record.transactionHash
          ? [record.transactionHash]
          : [],
        auditEntryIds: record.auditEntryIds ? [...record.auditEntryIds] : [],
      };

      return {
        payoutReference: record.payoutReference,
        status: record.status,
        ageSeconds,
        ageHours,
        amountAtRiskMinor,
        currency: record.currency,
        nextAction,
        alertState,
        runbookUrl: getRunbookUrlForAlertState(alertState),
        evidence,
      };
    });
  }

  /**
   * Aggregates reconciliation totals from unresolved payout records.
   */
  public computeTotals(records: UnresolvedPayoutRecord[]): ReconciliationTotals {
    const totals: ReconciliationTotals = {
      pendingCount: 0,
      pendingAmountMinor: 0,
      failedCount: 0,
      failedAmountMinor: 0,
      atRiskCount: 0,
      atRiskAmountMinor: 0,
    };

    for (const record of records) {
      const amount = Math.max(0, Math.trunc(record.amountMinor));
      if (record.status === 'pending') {
        totals.pendingCount += 1;
        totals.pendingAmountMinor += amount;
      }
      if (record.status === 'failed') {
        totals.failedCount += 1;
        totals.failedAmountMinor += amount;
      }
      if (
        record.status === 'pending' ||
        record.status === 'failed' ||
        record.status === 'reversed'
      ) {
        totals.atRiskCount += 1;
        totals.atRiskAmountMinor += amount;
      }
    }

    return totals;
  }

  /**
   * Verifies displayed totals against authoritative database counts.
   * Returns a mismatch report with a runbook link when discrepancies exist.
   */
  public verifyTotals(
    records: UnresolvedPayoutRecord[],
    dbCounts: ReconciliationTotals,
  ): ReconciliationTotalsVerification {
    const computed = this.computeTotals(records);
    const fields: (keyof ReconciliationTotals)[] = [
      'pendingCount',
      'pendingAmountMinor',
      'failedCount',
      'failedAmountMinor',
      'atRiskCount',
      'atRiskAmountMinor',
    ];

    const mismatches: ReconciliationTotalsMismatch[] = [];
    for (const field of fields) {
      const expected = dbCounts[field] ?? 0;
      const actual = computed[field] ?? 0;
      if (expected !== actual) {
        mismatches.push({
          field,
          expected,
          actual,
          delta: actual - expected,
        });
      }
    }

    return {
      ok: mismatches.length === 0,
      computed,
      db: dbCounts,
      mismatches,
      runbookUrl: getRunbookUrlForAlertState(
        mismatches.length === 0 ? 'OK' : 'TOTALS_MISMATCH',
      ),
    };
  }

  public _resetForTest(newDir?: string): void {
    this.rejectedEvents = [];
    this.storageFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export const payoutReconciliationService = new PayoutReconciliationService();
