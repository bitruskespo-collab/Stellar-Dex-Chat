import fs from 'fs';
import path from 'path';
import { payoutAuditLedger, PayoutAuditLedger } from './auditLedger';
import {
  PayoutEvidence,
  PayoutEvidenceResolution,
  payoutEvidenceConflictResolver,
} from './evidenceConflictResolver';
import { getAllTransfers, setTransferStatus } from '../transferStore';
import { getPayoutProvider } from './providers/registry';

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

  /**
   * Resolves signed webhook, provider polling, and imported statement evidence.
   * Conflicting evidence is persisted for review and never silently overwrites
   * the effective status.
   */
  public reconcileEvidence(params: {
    payoutReference: string;
    evidence: PayoutEvidence[];
  }): PayoutEvidenceResolution {
    const resolution = payoutEvidenceConflictResolver.resolve(params);
    if (resolution.conflict) {
      this.auditLedger.recordEvent({
        payoutId: params.payoutReference,
        action: 'payout_event_rejected',
        actor: 'system:evidence-resolution',
        requestCorrelationId: resolution.conflictId,
        providerReference: resolution.effectiveStatus,
        metadata: {
          conflictId: resolution.conflictId,
          effectiveStatus: resolution.effectiveStatus,
          precedenceSource: resolution.precedenceSource,
          evidenceSources: params.evidence.map((item) => item.source),
          reason: resolution.reason,
        },
      });
    }
    return resolution;
  }

  public getEvidenceConflicts(payoutReference?: string) {
    return payoutEvidenceConflictResolver.getConflicts(payoutReference);
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

export function reconcileEvidence(params: {
  payoutReference: string;
  evidence: PayoutEvidence[];
}): PayoutEvidenceResolution {
  return payoutReconciliationService.reconcileEvidence(params);
}

export async function reconcileStalePayouts(params?: {
  staleAgeMs?: number;
  batchSize?: number;
}): Promise<{
  processed: number;
  transitioned: number;
  noChange: number;
  providerUnavailable: number;
  conflicts: number;
  errors: number;
  results: Array<{
    payoutReference: string;
    outcome:
      | 'transitioned'
      | 'no_change'
      | 'provider_unavailable'
      | 'conflict'
      | 'error';
  }>;
  timestamp: number;
}> {
  const staleAgeMs = params?.staleAgeMs ?? 5 * 60 * 1000;
  const batchSize = params?.batchSize ?? 25;
  const now = Date.now();
  const candidates = getAllTransfers()
    .filter(
      (record) =>
        record.status !== 'success' &&
        record.status !== 'failed' &&
        record.status !== 'reversed' &&
        record.status !== 'cancelled' &&
        now - Date.parse(record.updatedAt) >= staleAgeMs,
    )
    .slice(0, batchSize);

  const summary = {
    processed: candidates.length,
    transitioned: 0,
    noChange: 0,
    providerUnavailable: 0,
    conflicts: 0,
    errors: 0,
    results: [] as Array<{
      payoutReference: string;
      outcome:
        | 'transitioned'
        | 'no_change'
        | 'provider_unavailable'
        | 'conflict'
        | 'error';
    }>,
    timestamp: now,
  };

  for (const record of candidates) {
    try {
      const provider = getPayoutProvider();
      const providerStatus = await provider.checkTransferStatus({
        reference: record.reference,
      });
      const resolution = payoutReconciliationService.reconcileEvidence({
        payoutReference: record.reference,
        evidence: [
          {
            source: 'provider_poll',
            status: providerStatus.status,
            observedAt: new Date().toISOString(),
            reference: record.reference,
            evidenceId: providerStatus.providerReference || record.reference,
            amountMinor: providerStatus.amountMinor?.toString(),
            currency: providerStatus.currency,
          },
        ],
      });

      if (resolution.conflict) {
        summary.conflicts++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'conflict',
        });
        continue;
      }

      if (resolution.effectiveStatus === record.status) {
        summary.noChange++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'no_change',
        });
        continue;
      }

      setTransferStatus({
        ...record,
        status: resolution.effectiveStatus,
        updatedAt: new Date().toISOString(),
      });
      summary.transitioned++;
      summary.results.push({
        payoutReference: record.reference,
        outcome: 'transitioned',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.toLowerCase().includes('unavailable') ||
          error.message.toLowerCase().includes('timeout'))
      ) {
        summary.providerUnavailable++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'provider_unavailable',
        });
      } else {
        summary.errors++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'error',
        });
      }
    }
  }

  return summary;
}
