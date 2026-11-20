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

  public _resetForTest(newDir?: string): void {
    this.rejectedEvents = [];
    this.storageFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export const payoutReconciliationService = new PayoutReconciliationService();

/*
 * Threat-model coverage map (see docs/payout-threat-model.md):
 *
 * - TM-RECON-1 (out-of-order / replay regression): a provider event that would
 *   regress a settled or reversed payout is rejected and persisted for
 *   investigation. Covered by "rejects out-of-order transitions" tests.
 * - TM-RECON-2 (duplicate delivery / idempotency): re-delivering the same
 *   terminal event must be a no-op and must not mutate state. Covered by
 *   "treats duplicate terminal events as idempotent no-ops".
 * - TM-RECON-3 (unrecognized / spoofed event types): unknown event types are
 *   never applied and never reach the audit ledger as domain actions. Covered
 *   by "ignores unrecognized event types".
 * - TM-RECON-4 (audit trail integrity): every rejected event is recorded in the
 *   immutable audit ledger with the provider reference and reason so finance
 *   can reconcile. Covered by "records rejected events in the audit ledger".
 *
 * All fixtures use synthetic payout references (e.g. "po_test_...") and never
 * contain real user data or credentials.
 */
export interface ReconciliationThreatCase {
  id: string;
  description: string;
  run: (service: PayoutReconciliationService) => void;
}

export function buildReconciliationThreatCases(): ReconciliationThreatCase[] {
  return [
    {
      id: 'TM-RECON-1',
      description:
        'Out-of-order event attempting to regress a settled payout is rejected',
      run: (service) => {
        const decision = service.reconcileEvent({
          eventId: 'evt_test_regress_001',
          payoutReference: 'po_test_regress_001',
          eventType: 'transfer.failed',
          currentStatus: 'success',
        });
        if (decision.decision !== 'REJECTED_OUT_OF_ORDER') {
          throw new Error(
            `Expected REJECTED_OUT_OF_ORDER, got ${decision.decision}`,
          );
        }
        if (decision.effectiveStatus !== 'success') {
          throw new Error(
            `Effective status must remain success, got ${decision.effectiveStatus}`,
          );
        }
      },
    },
    {
      id: 'TM-RECON-2',
      description: 'Duplicate terminal event is an idempotent no-op',
      run: (service) => {
        const decision = service.reconcileEvent({
          eventId: 'evt_test_dup_001',
          payoutReference: 'po_test_dup_001',
          eventType: 'transfer.success',
          currentStatus: 'success',
        });
        if (decision.decision !== 'IDEMPOTENT_NOOP') {
          throw new Error(
            `Expected IDEMPOTENT_NOOP, got ${decision.decision}`,
          );
        }
        if (decision.effectiveStatus !== 'success') {
          throw new Error(
            `Effective status must remain success, got ${decision.effectiveStatus}`,
          );
        }
      },
    },
    {
      id: 'TM-RECON-3',
      description: 'Unrecognized event type is never applied',
      run: (service) => {
        const decision = service.reconcileEvent({
          eventId: 'evt_test_unknown_001',
          payoutReference: 'po_test_unknown_001',
          eventType: 'transfer.spoofed',
          currentStatus: 'pending',
        });
        if (decision.decision !== 'UNRECOGNIZED_EVENT') {
          throw new Error(
            `Expected UNRECOGNIZED_EVENT, got ${decision.decision}`,
          );
        }
        if (decision.effectiveStatus !== 'pending') {
          throw new Error(
            `Effective status must remain pending, got ${decision.effectiveStatus}`,
          );
        }
      },
    },
    {
      id: 'TM-RECON-4',
      description: 'Rejected events are persisted for audit investigation',
      run: (service) => {
        service.reconcileEvent({
          eventId: 'evt_test_audit_001',
          payoutReference: 'po_test_audit_001',
          eventType: 'transfer.reversed',
          currentStatus: 'reversed',
        });
        service.reconcileEvent({
          eventId: 'evt_test_audit_002',
          payoutReference: 'po_test_audit_001',
          eventType: 'transfer.success',
          currentStatus: 'reversed',
        });
        const rejected = service.getRejectedEvents({
          payoutReference: 'po_test_audit_001',
        });
        if (rejected.length !== 1) {
          throw new Error(
            `Expected 1 rejected event, got ${rejected.length}`,
          );
        }
        if (rejected[0].eventId !== 'evt_test_audit_002') {
          throw new Error(
            `Unexpected rejected event id ${rejected[0].eventId}`,
          );
        }
      },
    },
  ];
}
