/**
 * Event Reconciliation Engine
 * Addresses Issue #88: Detect indexer drift by comparing derived records
 * with bounded contract views without mutating source data.
 */

export type DiscrepancyType = 'MISSING_IN_INDEX' | 'DUPLICATE_IN_INDEX' | 'MALFORMED_RECORD' | 'AMOUNT_CONFLICT';

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
