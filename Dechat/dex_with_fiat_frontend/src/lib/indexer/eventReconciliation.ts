/**
 * Event Reconciliation Engine
 * Addresses Issue #88: Detect indexer drift by comparing derived records
 * with bounded contract views without mutating source data.
 */

export type DiscrepancyType = 'MISSING_IN_INDEX' | 'DUPLICATE_IN_INDEX' | 'MALFORMED_RECORD' | 'AMOUNT_CONFLICT';

export type ForkReason = 'HASH_MISMATCH' | 'MISSING_HASH' | 'RPC_HASH_MISSING';

export interface LedgerHashComparison {
  /** First ledger at which stored and authoritative hashes diverge, or null if consistent. */
  firstDivergentLedger: number | null;
  /** Inclusive range of ledgers invalidated by the divergence, or null if consistent. */
  invalidatedRange: { fromLedger: number; toLedger: number } | null;
  /** Per-ledger reasons for divergence, keyed by ledger. */
  reasons: Map<number, ForkReason>;
  isConsistent: boolean;
}

export interface AuditEntry {
  action: 'FORK_DETECTED' | 'REBUILD_STARTED' | 'REBUILD_COMPLETED' | 'REBUILD_FAILED';
  contractId: string;
  fromLedger: number;
  toLedger: number;
  reason: string;
  actor: string;
  recordedAt: string;
  metadata?: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void> | void;
}

export interface IndexerRollback {
  /** Rolls back indexed projections to (and including) the given ledger. */
  rollbackTo(contractId: string, trustedLedger: number): Promise<void>;
  /** Re-ingests ledgers in the inclusive range from the authoritative source. */
  reingest(contractId: string, fromLedger: number, toLedger: number): Promise<void>;
}

export interface RebuildResult {
  contractId: string;
  trustedLedger: number;
  rebuiltRange: { fromLedger: number; toLedger: number } | null;
  success: boolean;
  error?: string;
  auditEntries: AuditEntry[];
}

/**
 * Pure helper: computes the first divergent ledger and invalidated range from
 * two ledger->hash maps. Stored hashes are compared against authoritative RPC
 * hashes; any ledger present in one map but not the other is divergent.
 */
export function computeDivergence(
  storedHashes: Map<number, string>,
  rpcHashes: Map<number, string>,
  toLedger: number
): LedgerHashComparison {
  const reasons = new Map<number, ForkReason>();
  const ledgers = new Set<number>([...storedHashes.keys(), ...rpcHashes.keys()]);

  for (const ledger of ledgers) {
    const stored = storedHashes.get(ledger);
    const rpc = rpcHashes.get(ledger);
    if (stored === undefined) {
      reasons.set(ledger, 'MISSING_HASH');
    } else if (rpc === undefined) {
      reasons.set(ledger, 'RPC_HASH_MISSING');
    } else if (stored !== rpc) {
      reasons.set(ledger, 'HASH_MISMATCH');
    }
  }

  if (reasons.size === 0) {
    return { firstDivergentLedger: null, invalidatedRange: null, reasons, isConsistent: true };
  }

  const firstDivergentLedger = Math.min(...reasons.keys());
  return {
    firstDivergentLedger,
    invalidatedRange: { fromLedger: firstDivergentLedger, toLedger },
    reasons,
    isConsistent: false,
  };
}

/**
 * Pure helper: given a trusted checkpoint ledger and the latest indexed ledger,
 * returns the inclusive range that must be rebuilt, or null if nothing to do.
 */
export function computeRebuildRange(
  trustedLedger: number,
  latestIndexedLedger: number
): { fromLedger: number; toLedger: number } | null {
  if (!Number.isFinite(trustedLedger) || !Number.isFinite(latestIndexedLedger)) {
    return null;
  }
  if (latestIndexedLedger <= trustedLedger) {
    return null;
  }
  return { fromLedger: trustedLedger + 1, toLedger: latestIndexedLedger };
}

export interface DiscrepancyReport {
  recordId: string;
  type: DiscrepancyType;
  ledger: number;
  contractState?: Record<string, unknown>;
  indexedState?: Record<string, unknown>;
  suggestedBackfillRange?: { fromLedger: number; toLedger: number };
}

export interface ReconciliationSummary {
  contractId: string;
  fromLedger: number;
  toLedger: number;
  discrepancies: DiscrepancyReport[];
  isConsistent: boolean;
  evaluatedAt: string;
}

export class EventReconciliationEngine {
  private readonly auditSink?: AuditSink;

  constructor(auditSink?: AuditSink) {
    this.auditSink = auditSink;
  }

  /**
   * Compares stored ledger hashes against authoritative RPC hashes and reports
   * the first divergent ledger plus the invalidated range.
   */
  public compareLedgerHashes(
    storedHashes: Map<number, string>,
    rpcHashes: Map<number, string>,
    toLedger: number
  ): LedgerHashComparison {
    return computeDivergence(storedHashes, rpcHashes, toLedger);
  }

  /**
   * Rebuilds indexed projections from a trusted checkpoint: rolls back the
   * indexer to the trusted ledger, re-ingests the affected range, and records
   * each step in the audit trail.
   */
  public async rebuildFromCheckpoint(
    contractId: string,
    trustedLedger: number,
    latestIndexedLedger: number,
    indexer: IndexerRollback,
    actor: string,
    reason: string = 'FORK_REPAIR'
  ): Promise<RebuildResult> {
    const auditEntries: AuditEntry[] = [];
    const range = computeRebuildRange(trustedLedger, latestIndexedLedger);

    const emit = async (entry: AuditEntry): Promise<void> => {
      auditEntries.push(entry);
      if (this.auditSink) {
        await this.auditSink.record(entry);
      }
    };

    if (!range) {
      return {
        contractId,
        trustedLedger,
        rebuiltRange: null,
        success: true,
        auditEntries,
      };
    }

    await emit({
      action: 'REBUILD_STARTED',
      contractId,
      fromLedger: range.fromLedger,
      toLedger: range.toLedger,
      reason,
      actor,
      recordedAt: new Date().toISOString(),
    });

    try {
      await indexer.rollbackTo(contractId, trustedLedger);
      await indexer.reingest(contractId, range.fromLedger, range.toLedger);

      await emit({
        action: 'REBUILD_COMPLETED',
        contractId,
        fromLedger: range.fromLedger,
        toLedger: range.toLedger,
        reason,
        actor,
        recordedAt: new Date().toISOString(),
      });

      return {
        contractId,
        trustedLedger,
        rebuiltRange: range,
        success: true,
        auditEntries,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit({
        action: 'REBUILD_FAILED',
        contractId,
        fromLedger: range.fromLedger,
        toLedger: range.toLedger,
        reason,
        actor,
        recordedAt: new Date().toISOString(),
        metadata: { error: message },
      });

      return {
        contractId,
        trustedLedger,
        rebuiltRange: range,
        success: false,
        error: message,
        auditEntries,
      };
    }
  }

  /**
   * Records a fork detection event in the audit trail.
   */
  public async recordForkDetection(
    contractId: string,
    comparison: LedgerHashComparison,
    actor: string
  ): Promise<AuditEntry | null> {
    if (!comparison.invalidatedRange) {
      return null;
    }
    const entry: AuditEntry = {
      action: 'FORK_DETECTED',
      contractId,
      fromLedger: comparison.invalidatedRange.fromLedger,
      toLedger: comparison.invalidatedRange.toLedger,
      reason: `FORK_DETECTED:${[...new Set(comparison.reasons.values())].join(',')}`,
      actor,
      recordedAt: new Date().toISOString(),
    };
    if (this.auditSink) {
      await this.auditSink.record(entry);
    }
    return entry;
  }
  /**
   * Compares authoritative contract state snapshots against indexed records.
   */
  public reconcileRange(
    contractId: string,
    fromLedger: number,
    toLedger: number,
    authoritativeEvents: Map<string, Record<string, unknown>>,
    indexedEvents: Map<string, Record<string, unknown>>
  ): ReconciliationSummary {
    const discrepancies: DiscrepancyReport[] = [];

    // Check for events present on-chain but missing or conflicting in index
    for (const [id, authRecord] of authoritativeEvents.entries()) {
      const indexed = indexedEvents.get(id);
      const ledger = (authRecord.ledger as number) || fromLedger;

      if (!indexed) {
        discrepancies.push({
          recordId: id,
          type: 'MISSING_IN_INDEX',
          ledger,
          contractState: authRecord,
          suggestedBackfillRange: { fromLedger: ledger, toLedger: ledger },
        });
      } else if (JSON.stringify(authRecord.payload) !== JSON.stringify(indexed.payload)) {
        discrepancies.push({
          recordId: id,
          type: 'AMOUNT_CONFLICT',
          ledger,
          contractState: authRecord,
          indexedState: indexed,
          suggestedBackfillRange: { fromLedger: ledger, toLedger: ledger },
        });
      }
    }

    return {
      contractId,
      fromLedger,
      toLedger,
      discrepancies,
      isConsistent: discrepancies.length === 0,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
