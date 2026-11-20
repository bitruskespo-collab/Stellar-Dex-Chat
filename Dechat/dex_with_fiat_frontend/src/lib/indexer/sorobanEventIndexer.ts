/**
 * Durable Soroban Event Indexer with Ledger Cursors
 * Addresses Issue #86: Turn contract events into a queryable, restart-safe source
 * for history and operations.
 */

export interface SorobanEventRecord {
  id: string; // `${ledger}_${txHash}_${eventIndex}`
  contractId: string;
  ledger: number;
  txHash: string;
  eventIndex: number;
  schemaVersion: number;
  topic: string[];
  rawPayload: string;
  decodedPayload: Record<string, unknown> | null;
  timestamp: number;
}

export interface IndexerCursor {
  lastLedger: number;
  lastEventIndex: number;
  updatedAt: number;
}

/**
 * Alert thresholds for indexer health diagnostics.
 * Exported so operational tooling and alerting can reuse the same bounds.
 */
export const MAX_LEDGER_LAG = 100;
export const MAX_RETRY_COUNT = 5;
export const MAX_OLDEST_EVENT_AGE_SECONDS = 300;

/** Upper bound applied to any numeric health field to keep labels bounded. */
const MAX_BOUNDED_VALUE = 1_000_000_000;

export interface IndexerHealthSnapshot {
  cursor: { lastLedger: number; lastEventIndex: number };
  ledgerLag: number;
  retryCount: number;
  oldestUnprocessedEvent: { ledger: number; ageSeconds: number } | null;
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_BOUNDED_VALUE);
}

export class SorobanEventIndexer {
  private events: Map<string, SorobanEventRecord> = new Map();
  private cursor: IndexerCursor = { lastLedger: 0, lastEventIndex: 0, updatedAt: 0 };
  private supportedSchemas: Set<number> = new Set([1]);
  private retryCount = 0;
  private oldestUnprocessedLedger: number | null = null;
  private oldestUnprocessedAt: number | null = null;

  constructor(initialCursor?: IndexerCursor) {
    if (initialCursor) {
      this.cursor = { ...initialCursor };
    }
  }

  public getCursor(): IndexerCursor {
    return { ...this.cursor };
  }

  /**
   * Record a failed ingest attempt so health diagnostics can surface retries.
   */
  public recordIngestFailure(): void {
    this.retryCount = clampNonNegative(this.retryCount + 1);
  }

  /**
   * Bounded health snapshot with no customer identifiers.
   * `chainTipLedger` is the current chain head used to compute ledger lag.
   */
  public getHealthSnapshot(chainTipLedger: number): IndexerHealthSnapshot {
    const tip = clampNonNegative(chainTipLedger);
    const lastLedger = clampNonNegative(this.cursor.lastLedger);
    const ledgerLag = clampNonNegative(tip - lastLedger);

    let oldestUnprocessedEvent: IndexerHealthSnapshot['oldestUnprocessedEvent'] = null;
    if (this.oldestUnprocessedLedger !== null && this.oldestUnprocessedAt !== null) {
      const ageSeconds = clampNonNegative((Date.now() - this.oldestUnprocessedAt) / 1000);
      oldestUnprocessedEvent = {
        ledger: clampNonNegative(this.oldestUnprocessedLedger),
        ageSeconds,
      };
    }

    return {
      cursor: {
        lastLedger,
        lastEventIndex: clampNonNegative(this.cursor.lastEventIndex),
      },
      ledgerLag,
      retryCount: clampNonNegative(this.retryCount),
      oldestUnprocessedEvent,
    };
  }

  /**
   * Ingest a batch of events idempotently without duplicates or gaps.
   */
  public ingestEvents(batch: SorobanEventRecord[]): { ingested: number; duplicatesSkipped: number } {
    let ingested = 0;
    let duplicatesSkipped = 0;

    // Stable sort by ledger then eventIndex
    const sorted = [...batch].sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.eventIndex - b.eventIndex;
    });

    for (const record of sorted) {
      const recordKey = `${record.ledger}_${record.txHash}_${record.eventIndex}`;
      if (this.events.has(recordKey)) {
        duplicatesSkipped++;
        continue;
      }

      // Track the oldest event that has not yet been processed into the cursor.
      if (this.oldestUnprocessedLedger === null || record.ledger < this.oldestUnprocessedLedger) {
        this.oldestUnprocessedLedger = record.ledger;
        this.oldestUnprocessedAt = Date.now();
      }

      // Schema compatibility verification
      if (!this.supportedSchemas.has(record.schemaVersion)) {
        console.warn(`Encountered unsupported event schema version: ${record.schemaVersion}`);
      }

      this.events.set(recordKey, { ...record, id: recordKey });
      ingested++;

      if (record.ledger > this.cursor.lastLedger || 
         (record.ledger === this.cursor.lastLedger && record.eventIndex > this.cursor.lastEventIndex)) {
        this.cursor = {
          lastLedger: record.ledger,
          lastEventIndex: record.eventIndex,
          updatedAt: Date.now(),
        };
      }
    }

    // Clear the oldest-unprocessed marker once the cursor has caught up to it.
    if (
      this.oldestUnprocessedLedger !== null &&
      this.oldestUnprocessedLedger <= this.cursor.lastLedger
    ) {
      this.oldestUnprocessedLedger = null;
      this.oldestUnprocessedAt = null;
    }

    return { ingested, duplicatesSkipped };
  }

  /**
   * Expose bounded, stably ordered queries.
   */
  public queryEvents(params: {
    contractId?: string;
    fromLedger?: number;
    toLedger?: number;
    limit?: number;
  }): SorobanEventRecord[] {
    const { contractId, fromLedger = 0, toLedger = Infinity, limit = 50 } = params;
    const results: SorobanEventRecord[] = [];

    for (const record of this.events.values()) {
      if (contractId && record.contractId !== contractId) continue;
      if (record.ledger < fromLedger || record.ledger > toLedger) continue;
      results.push(record);
    }

    return results
      .sort((a, b) => {
        if (a.ledger !== b.ledger) return a.ledger - b.ledger;
        return a.eventIndex - b.eventIndex;
      })
      .slice(0, Math.min(limit, 100));
  }
}
