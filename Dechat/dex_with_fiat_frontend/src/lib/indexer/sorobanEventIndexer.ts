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

export type ProjectionStatus = 'active' | 'building' | 'validated' | 'failed';

export interface ProjectionVersion {
  version: number;
  status: ProjectionStatus;
  checksum: string;
  eventCount: number;
  createdAt: number;
}

interface ProjectionState {
  events: Map<string, SorobanEventRecord>;
  cursor: IndexerCursor;
  meta: ProjectionVersion;
}

export class SorobanEventIndexer {
  private projections: Map<number, ProjectionState> = new Map();
  private activeVersion: number = 1;
  private nextVersion: number = 2;
  private shadowVersion: number | null = null;
  private supportedSchemas: Set<number> = new Set([1]);

  constructor(initialCursor?: IndexerCursor) {
    const cursor: IndexerCursor = initialCursor
      ? { ...initialCursor }
      : { lastLedger: 0, lastEventIndex: 0, updatedAt: 0 };
    this.projections.set(1, {
      events: new Map(),
      cursor,
      meta: {
        version: 1,
        status: 'active',
        checksum: computeChecksum([]),
        eventCount: 0,
        createdAt: Date.now(),
      },
    });
  }

  private getActive(): ProjectionState {
    const state = this.projections.get(this.activeVersion);
    if (!state) {
      throw new Error(`Active projection version ${this.activeVersion} is missing`);
    }
    return state;
  }

  public getActiveVersion(): ProjectionVersion {
    return { ...this.getActive().meta };
  }

  public getProjectionVersion(version: number): ProjectionVersion | null {
    const state = this.projections.get(version);
    return state ? { ...state.meta } : null;
  }

  public getCursor(): IndexerCursor {
    return { ...this.getActive().cursor };
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

    const active = this.getActive();

    for (const record of sorted) {
      const recordKey = `${record.ledger}_${record.txHash}_${record.eventIndex}`;
      if (active.events.has(recordKey)) {
        duplicatesSkipped++;
        continue;
      }

      // Schema compatibility verification
      if (!this.supportedSchemas.has(record.schemaVersion)) {
        console.warn(`Encountered unsupported event schema version: ${record.schemaVersion}`);
      }

      active.events.set(recordKey, { ...record, id: recordKey });
      ingested++;

      if (record.ledger > active.cursor.lastLedger || 
         (record.ledger === active.cursor.lastLedger && record.eventIndex > active.cursor.lastEventIndex)) {
        active.cursor = {
          lastLedger: record.ledger,
          lastEventIndex: record.eventIndex,
          updatedAt: Date.now(),
        };
      }
    }

    active.meta.eventCount = active.events.size;
    active.meta.checksum = computeChecksum(active.events.values());

    return { ingested, duplicatesSkipped };
  }

  /**
   * Begin a parallel rebuild into a fresh shadow projection namespace.
   * The active projection remains untouched and fully readable.
   */
  public beginRebuild(): ProjectionVersion {
    if (this.shadowVersion !== null) {
      throw new Error(`Rebuild already in progress for version ${this.shadowVersion}`);
    }
    const version = this.nextVersion++;
    const active = this.getActive();
    const shadow: ProjectionState = {
      events: new Map(),
      cursor: { ...active.cursor },
      meta: {
        version,
        status: 'building',
        checksum: computeChecksum([]),
        eventCount: 0,
        createdAt: Date.now(),
      },
    };
    this.projections.set(version, shadow);
    this.shadowVersion = version;
    return { ...shadow.meta };
  }

  /**
   * Ingest events into the shadow projection only. Never mutates the active projection.
   */
  public ingestIntoShadow(batch: SorobanEventRecord[]): { ingested: number; duplicatesSkipped: number } {
    if (this.shadowVersion === null) {
      throw new Error('No rebuild in progress; call beginRebuild() first');
    }
    const shadow = this.projections.get(this.shadowVersion);
    if (!shadow) {
      throw new Error(`Shadow projection version ${this.shadowVersion} is missing`);
    }

    let ingested = 0;
    let duplicatesSkipped = 0;

    const sorted = [...batch].sort((a, b) => {
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;
      return a.eventIndex - b.eventIndex;
    });

    for (const record of sorted) {
      const recordKey = `${record.ledger}_${record.txHash}_${record.eventIndex}`;
      if (shadow.events.has(recordKey)) {
        duplicatesSkipped++;
        continue;
      }
      if (!this.supportedSchemas.has(record.schemaVersion)) {
        console.warn(`Encountered unsupported event schema version: ${record.schemaVersion}`);
      }
      shadow.events.set(recordKey, { ...record, id: recordKey });
      ingested++;

      if (record.ledger > shadow.cursor.lastLedger ||
         (record.ledger === shadow.cursor.lastLedger && record.eventIndex > shadow.cursor.lastEventIndex)) {
        shadow.cursor = {
          lastLedger: record.ledger,
          lastEventIndex: record.eventIndex,
          updatedAt: Date.now(),
        };
      }
    }

    shadow.meta.eventCount = shadow.events.size;
    shadow.meta.checksum = computeChecksum(shadow.events.values());

    return { ingested, duplicatesSkipped };
  }

  /**
   * Validate the shadow projection against the source (active) projection.
   * Compares event counts and checksums. On failure the shadow is marked
   * 'failed' and the active projection is left untouched.
   */
  public validateShadow(): { valid: boolean; reason?: string } {
    if (this.shadowVersion === null) {
      throw new Error('No rebuild in progress; call beginRebuild() first');
    }
    const shadow = this.projections.get(this.shadowVersion);
    if (!shadow) {
      throw new Error(`Shadow projection version ${this.shadowVersion} is missing`);
    }
    const active = this.getActive();

    const shadowChecksum = computeChecksum(shadow.events.values());
    const activeChecksum = computeChecksum(active.events.values());

    if (shadow.events.size !== active.events.size) {
      shadow.meta.status = 'failed';
      return {
        valid: false,
        reason: `event count mismatch: shadow=${shadow.events.size} active=${active.events.size}`,
      };
    }
    if (shadowChecksum !== activeChecksum) {
      shadow.meta.status = 'failed';
      return {
        valid: false,
        reason: `checksum mismatch: shadow=${shadowChecksum} active=${activeChecksum}`,
      };
    }

    shadow.meta.checksum = shadowChecksum;
    shadow.meta.eventCount = shadow.events.size;
    shadow.meta.status = 'validated';
    return { valid: true };
  }

  /**
   * Atomically flip the active projection pointer to the validated shadow.
   * Throws (leaving the active projection untouched) if validation has not
   * succeeded.
   */
  public commitSwap(): ProjectionVersion {
    if (this.shadowVersion === null) {
      throw new Error('No rebuild in progress; call beginRebuild() first');
    }
    const shadow = this.projections.get(this.shadowVersion);
    if (!shadow) {
      throw new Error(`Shadow projection version ${this.shadowVersion} is missing`);
    }
    if (shadow.meta.status !== 'validated') {
      throw new Error(`Cannot swap: shadow version ${shadow.meta.version} is not validated (status=${shadow.meta.status})`);
    }

    const previousActive = this.activeVersion;
    shadow.meta.status = 'active';
    this.activeVersion = shadow.meta.version;
    this.shadowVersion = null;

    const prev = this.projections.get(previousActive);
    if (prev) {
      prev.meta.status = 'failed';
    }

    return { ...shadow.meta };
  }

  /**
   * Abort an in-progress rebuild, discarding the shadow projection.
   */
  public abortRebuild(): void {
    if (this.shadowVersion === null) return;
    const shadow = this.projections.get(this.shadowVersion);
    if (shadow) {
      shadow.meta.status = 'failed';
    }
    this.projections.delete(this.shadowVersion);
    this.shadowVersion = null;
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
    const active = this.getActive();

    for (const record of active.events.values()) {
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

/**
 * Deterministic checksum over a set of event records, independent of
 * insertion order. Used to compare shadow and active projections.
 */
function computeChecksum(records: Iterable<SorobanEventRecord>): string {
  const keys: string[] = [];
  for (const record of records) {
    keys.push(record.id);
  }
  keys.sort();
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
