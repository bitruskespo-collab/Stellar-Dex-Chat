/**
 * Event Reconciliation Engine
 * Addresses Issue #88: Detect indexer drift by comparing derived records
 * with bounded contract views without mutating source data.
 */

export type DiscrepancyType =
  | 'MISSING_IN_INDEX'
  | 'DUPLICATE_IN_INDEX'
  | 'MALFORMED_RECORD'
  | 'AMOUNT_CONFLICT'
  | 'PROJECTION_VERSION_MISMATCH'
  | 'PROJECTION_CHECKSUM_DRIFT';

export interface DiscrepancyReport {
  recordId: string;
  type: DiscrepancyType;
  ledger: number;
  contractState?: Record<string, unknown>;
  indexedState?: Record<string, unknown>;
  suggestedBackfillRange?: { fromLedger: number; toLedger: number };
}

/**
 * Describes the projection schema version and checksum the index is expected
 * to be serving. `activeChecksum` is the checksum of the currently served
 * projection; `shadowChecksum` (when present) is the checksum of a parallel
 * rebuild that is being validated before swap.
 */
export interface ProjectionVersionExpectation {
  expectedVersion: number;
  activeVersion?: number;
  activeChecksum?: string;
  shadowVersion?: number;
  shadowChecksum?: string;
}

export interface ReconciliationSummary {
  contractId: string;
  fromLedger: number;
  toLedger: number;
  discrepancies: DiscrepancyReport[];
  isConsistent: boolean;
  evaluatedAt: string;
  projectionVersion?: number;
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
    indexedEvents: Map<string, Record<string, unknown>>,
    projection?: ProjectionVersionExpectation
  ): ReconciliationSummary {
    const discrepancies: DiscrepancyReport[] = [];

    // Projection version / checksum checks (read-only, no mutation of source data)
    if (projection) {
      const activeVersion = projection.activeVersion;
      if (activeVersion !== undefined && activeVersion !== projection.expectedVersion) {
        discrepancies.push({
          recordId: `projection:${contractId}`,
          type: 'PROJECTION_VERSION_MISMATCH',
          ledger: fromLedger,
          indexedState: {
            expectedVersion: projection.expectedVersion,
            activeVersion,
            shadowVersion: projection.shadowVersion,
          },
        });
      }

      if (
        projection.activeChecksum !== undefined &&
        projection.shadowChecksum !== undefined &&
        projection.activeChecksum !== projection.shadowChecksum
      ) {
        discrepancies.push({
          recordId: `projection:${contractId}`,
          type: 'PROJECTION_CHECKSUM_DRIFT',
          ledger: fromLedger,
          indexedState: {
            activeChecksum: projection.activeChecksum,
            shadowChecksum: projection.shadowChecksum,
            shadowVersion: projection.shadowVersion,
          },
        });
      }
    }

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
      projectionVersion: projection?.activeVersion ?? projection?.expectedVersion,
    };
  }
}
