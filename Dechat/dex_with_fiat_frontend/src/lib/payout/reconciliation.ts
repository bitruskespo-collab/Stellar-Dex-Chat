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

/**
 * Confidence classification for cross-source payout reconciliation.
 *
 * - `matched`: all present sources agree on identifiers, amount and currency.
 * - `ambiguous`: a stable identifier maps to more than one record, so the
 *   correct counterpart cannot be determined automatically.
 * - `unmatched`: at least one expected source is missing, so the payout cannot
 *   be confirmed.
 * - `conflict`: sources disagree on amount or currency.
 */
export type ReconciliationConfidence =
  | 'matched'
  | 'ambiguous'
  | 'unmatched'
  | 'conflict';

export interface ContractPayoutEvent {
  txHash: string;
  payoutReference: string;
  /** Amount in minor units of `currency`. */
  amountMinor: string | number | bigint;
  currency: string;
  eventType?: string;
}

export interface InternalPayoutRecord {
  payoutReference: string;
  /** Amount in minor units of `currency`. */
  amountMinor: string | number | bigint;
  currency: string;
  status?: DomainPayoutStatus;
}

export interface ProviderPayoutEvidence {
  providerReference: string;
  payoutReference: string;
  /** Amount in minor units of `currency`. */
  amountMinor: string | number | bigint;
  currency: string;
  eventType?: string;
}

export interface ReconciliationRecord {
  /** Deterministic key derived from the stable identifiers. */
  id: string;
  txHash?: string;
  payoutReference?: string;
  providerReference?: string;
  confidence: ReconciliationConfidence;
  /** Normalized amount in minor units (string) when determinable. */
  amountMinor?: string;
  currency?: string;
  /** True only when confidence is `matched`; never auto-settle otherwise. */
  autoSettled: boolean;
  reasons: string[];
  contractEvent?: ContractPayoutEvent;
  internalRecord?: InternalPayoutRecord;
  providerEvidence?: ProviderPayoutEvidence;
  createdAt: string;
}

export interface ReconciliationInput {
  contractEvents?: ContractPayoutEvent[];
  internalRecords?: InternalPayoutRecord[];
  providerEvidence?: ProviderPayoutEvidence[];
}

export interface ReconciliationResult {
  records: ReconciliationRecord[];
  /** Records that require manual review (ambiguous/unmatched/conflict). */
  reviewQueue: ReconciliationRecord[];
}

/**
 * Normalizes an amount to a canonical minor-unit string.
 * Accepts decimal strings, numbers and bigints. Rejects non-integer or
 * negative values so that fractional minor units never silently round.
 */
export function normalizeAmountMinor(
  amount: string | number | bigint,
): string | null {
  if (typeof amount === 'bigint') {
    return amount >= 0n ? amount.toString() : null;
  }
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      return null;
    }
    return BigInt(amount).toString();
  }
  const trimmed = amount.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return BigInt(trimmed).toString();
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

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
   * Reconciles contract events, internal payout records and provider evidence
   * across sources using stable identifiers (txHash, payoutReference,
   * providerReference) and normalized amount/currency checks.
   *
   * Only `matched` records are eligible for auto-settlement. Ambiguous,
   * unmatched and conflicting records are routed to the review queue.
   */
  public reconcileSources(input: ReconciliationInput): ReconciliationResult {
    const contractEvents = input.contractEvents || [];
    const internalRecords = input.internalRecords || [];
    const providerEvidence = input.providerEvidence || [];

    const internalByRef = new Map<string, InternalPayoutRecord[]>();
    for (const rec of internalRecords) {
      const key = rec.payoutReference;
      const list = internalByRef.get(key) || [];
      list.push(rec);
      internalByRef.set(key, list);
    }

    const providerByRef = new Map<string, ProviderPayoutEvidence[]>();
    for (const ev of providerEvidence) {
      const key = ev.payoutReference;
      const list = providerByRef.get(key) || [];
      list.push(ev);
      providerByRef.set(key, list);
    }

    const contractByRef = new Map<string, ContractPayoutEvent[]>();
    for (const ev of contractEvents) {
      const key = ev.payoutReference;
      const list = contractByRef.get(key) || [];
      list.push(ev);
      contractByRef.set(key, list);
    }

    const payoutReferences = new Set<string>([
      ...contractByRef.keys(),
      ...internalByRef.keys(),
      ...providerByRef.keys(),
    ]);

    const records: ReconciliationRecord[] = [];
    const reviewQueue: ReconciliationRecord[] = [];

    for (const payoutReference of Array.from(payoutReferences).sort()) {
      const record = this.reconcileOne(
        payoutReference,
        contractByRef.get(payoutReference) || [],
        internalByRef.get(payoutReference) || [],
        providerByRef.get(payoutReference) || [],
      );
      records.push(record);
      if (record.confidence !== 'matched') {
        reviewQueue.push(record);
      }
    }

    return { records, reviewQueue };
  }

  private reconcileOne(
    payoutReference: string,
    contractEvents: ContractPayoutEvent[],
    internalRecords: InternalPayoutRecord[],
    providerEvidence: ProviderPayoutEvidence[],
  ): ReconciliationRecord {
    const reasons: string[] = [];
    const base: ReconciliationRecord = {
      id: `rec_${payoutReference}`,
      payoutReference,
      confidence: 'unmatched',
      autoSettled: false,
      reasons,
      createdAt: new Date().toISOString(),
    };

    // Duplicate stable identifiers make the match ambiguous.
    if (internalRecords.length > 1) {
      reasons.push(
        `Ambiguous: ${internalRecords.length} internal records share payoutReference ${payoutReference}`,
      );
    }
    if (providerEvidence.length > 1) {
      reasons.push(
        `Ambiguous: ${providerEvidence.length} provider evidence entries share payoutReference ${payoutReference}`,
      );
    }
    if (contractEvents.length > 1) {
      reasons.push(
        `Ambiguous: ${contractEvents.length} contract events share payoutReference ${payoutReference}`,
      );
    }
    if (reasons.length > 0) {
      return {
        ...base,
        confidence: 'ambiguous',
        txHash: contractEvents[0]?.txHash,
        providerReference: providerEvidence[0]?.providerReference,
        contractEvent: contractEvents[0],
        internalRecord: internalRecords[0],
        providerEvidence: providerEvidence[0],
      };
    }

    const contractEvent = contractEvents[0];
    const internalRecord = internalRecords[0];
    const provider = providerEvidence[0];

    const missing: string[] = [];
    if (!contractEvent) missing.push('contract event');
    if (!internalRecord) missing.push('internal payout record');
    if (!provider) missing.push('provider evidence');

    const enriched: ReconciliationRecord = {
      ...base,
      txHash: contractEvent?.txHash,
      providerReference: provider?.providerReference,
      contractEvent,
      internalRecord,
      providerEvidence: provider,
    };

    if (missing.length > 0) {
      reasons.push(`Missing source(s): ${missing.join(', ')}`);
      return { ...enriched, confidence: 'unmatched' };
    }

    // Normalize amounts and currencies from all three sources.
    const sources: Array<{
      name: string;
      amount: string | number | bigint;
      currency: string;
    }> = [
      {
        name: 'contract event',
        amount: contractEvent!.amountMinor,
        currency: contractEvent!.currency,
      },
      {
        name: 'internal payout record',
        amount: internalRecord!.amountMinor,
        currency: internalRecord!.currency,
      },
      {
        name: 'provider evidence',
        amount: provider!.amountMinor,
        currency: provider!.currency,
      },
    ];

    const normalized: Array<{ name: string; amount: string; currency: string }> =
      [];
    for (const source of sources) {
      const amount = normalizeAmountMinor(source.amount);
      if (amount === null) {
        reasons.push(
          `Invalid amount from ${source.name}: ${String(source.amount)}`,
        );
        return { ...enriched, confidence: 'conflict' };
      }
      normalized.push({
        name: source.name,
        amount,
        currency: normalizeCurrency(source.currency),
      });
    }

    const amounts = new Set(normalized.map((n) => n.amount));
    const currencies = new Set(normalized.map((n) => n.currency));

    if (amounts.size > 1) {
      reasons.push(
        `Amount mismatch: ${normalized
          .map((n) => `${n.name}=${n.amount}`)
          .join(', ')}`,
      );
    }
    if (currencies.size > 1) {
      reasons.push(
        `Currency mismatch: ${normalized
          .map((n) => `${n.name}=${n.currency}`)
          .join(', ')}`,
      );
    }

    const canonical = normalized[0];
    if (amounts.size > 1 || currencies.size > 1) {
      return {
        ...enriched,
        confidence: 'conflict',
        amountMinor: canonical.amount,
        currency: canonical.currency,
      };
    }

    return {
      ...enriched,
      confidence: 'matched',
      amountMinor: canonical.amount,
      currency: canonical.currency,
      autoSettled: true,
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
