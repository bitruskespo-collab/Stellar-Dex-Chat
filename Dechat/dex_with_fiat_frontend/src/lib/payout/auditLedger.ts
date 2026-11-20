import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type PayoutAuditAction =
  | 'payout_initiated'
  | 'payout_provider_accepted'
  | 'payout_succeeded'
  | 'payout_failed'
  | 'payout_reversed'
  | 'payout_event_rejected'
  | 'retry_scheduled'
  | 'retry_attempted'
  | 'retry_exhausted'
  | 'dead_letter_moved'
  | 'dead_letter_replayed'
  | 'operator_intervention';

export interface PayoutAuditEntry {
  id: string;
  sequenceNumber: number;
  payoutId: string;
  action: PayoutAuditAction;
  actor: string;
  requestCorrelationId: string;
  providerReference: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

/**
 * Periodic checkpoint anchoring the chain at a given sequence number.
 * The checkpoint hash commits to the sequence number and the entry hash
 * so that truncation or splicing of the tail is detectable.
 */
export interface PayoutAuditCheckpoint {
  sequenceNumber: number;
  entryHash: string;
  checkpointHash: string;
  createdAt: string;
}

export type PayoutAuditVerificationIssueType =
  | 'deletion'
  | 'reordering'
  | 'payload_modification'
  | 'checkpoint_mismatch'
  | 'missing_checkpoint';

export interface PayoutAuditVerificationIssue {
  type: PayoutAuditVerificationIssueType;
  entryId?: string;
  sequenceNumber?: number;
  detail: string;
}

export interface PayoutAuditVerificationResult {
  valid: boolean;
  entriesChecked: number;
  checkpointsChecked: number;
  issues: PayoutAuditVerificationIssue[];
  /** Convenience list of entry ids implicated in any issue. */
  invalidEntries: string[];
}

export const GENESIS_HASH = '0'.repeat(64);
export const DEFAULT_CHECKPOINT_INTERVAL = 25;

/**
 * Canonical serialization of an audit entry payload (excluding hash fields).
 * Uses an explicit field set and stable key ordering so that the same logical
 * entry always produces the same byte sequence across runtimes.
 */
export function canonicalizeAuditEntry(
  entry: Pick<
    PayoutAuditEntry,
    | 'sequenceNumber'
    | 'payoutId'
    | 'action'
    | 'actor'
    | 'requestCorrelationId'
    | 'providerReference'
    | 'timestamp'
    | 'metadata'
  >,
): string {
  const canonicalMetadata = canonicalizeValue(entry.metadata ?? {});
  return JSON.stringify({
    sequenceNumber: entry.sequenceNumber,
    payoutId: entry.payoutId,
    action: entry.action,
    actor: entry.actor,
    requestCorrelationId: entry.requestCorrelationId,
    providerReference: entry.providerReference,
    timestamp: entry.timestamp,
    metadata: canonicalMetadata,
  });
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalizeValue(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the chain hash for an entry: SHA-256 over previousHash + canonical payload.
 */
export function computeAuditEntryHash(
  previousHash: string,
  entry: Parameters<typeof canonicalizeAuditEntry>[0],
): string {
  const raw = `${previousHash}|${canonicalizeAuditEntry(entry)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function computeCheckpointHash(
  sequenceNumber: number,
  entryHash: string,
): string {
  const raw = `checkpoint|${sequenceNumber}|${entryHash}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface RecordPayoutEventParams {
  payoutId: string;
  action: PayoutAuditAction;
  actor: string;
  requestCorrelationId?: string;
  providerReference?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface PayoutAuditFilter {
  payoutId?: string;
  action?: PayoutAuditAction;
  actor?: string;
  providerReference?: string;
  startDate?: string | Date;
  endDate?: string | Date;
}

export interface PaginationOptions {
  page?: number;
  limit?: number;
}

export interface PaginatedPayoutAuditResult {
  entries: PayoutAuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export class PayoutAuditLedger {
  private entries: PayoutAuditEntry[] = [];
  private checkpoints: PayoutAuditCheckpoint[] = [];
  private storageFilePath: string | null = null;
  private checkpointFilePath: string | null = null;
  private lastHash = GENESIS_HASH;
  private checkpointInterval: number;

  constructor(storageDir?: string, checkpointInterval?: number) {
    const envInterval = Number(process.env.PAYOUT_AUDIT_CHECKPOINT_INTERVAL);
    this.checkpointInterval =
      checkpointInterval && checkpointInterval > 0
        ? checkpointInterval
        : envInterval > 0
          ? envInterval
          : DEFAULT_CHECKPOINT_INTERVAL;

    if (storageDir) {
      this.initStorage(storageDir);
    } else if (process.env.PAYOUT_DATA_DIR) {
      this.initStorage(process.env.PAYOUT_DATA_DIR);
    }
  }

  public initStorage(storageDir: string): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(storageDir, 'payout_audit_ledger.jsonl');
      this.checkpointFilePath = path.join(
        storageDir,
        'payout_audit_checkpoints.jsonl',
      );
      this.loadFromFile();
      this.loadCheckpointsFromFile();
    } catch (err) {
      console.warn('Failed to initialize audit ledger storage:', err);
    }
  }

  private loadCheckpointsFromFile(): void {
    if (!this.checkpointFilePath || !fs.existsSync(this.checkpointFilePath)) {
      return;
    }

    try {
      const fileData = fs.readFileSync(this.checkpointFilePath, 'utf8');
      const lines = fileData
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const loaded: PayoutAuditCheckpoint[] = [];

      for (const line of lines) {
        try {
          loaded.push(JSON.parse(line) as PayoutAuditCheckpoint);
        } catch {
          // Skip corrupted line
        }
      }

      this.checkpoints = loaded;
    } catch (err) {
      console.warn('Failed to load audit checkpoints from file:', err);
    }
  }

  private appendCheckpointToFile(checkpoint: PayoutAuditCheckpoint): void {
    if (!this.checkpointFilePath) return;

    try {
      fs.appendFileSync(
        this.checkpointFilePath,
        JSON.stringify(checkpoint) + '\n',
        'utf8',
      );
    } catch (err) {
      console.error('Failed to append audit checkpoint to file:', err);
    }
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const fileData = fs.readFileSync(this.storageFilePath, 'utf8');
      const lines = fileData
        .split('\n')
        .filter((line) => line.trim().length > 0);
      const loaded: PayoutAuditEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PayoutAuditEntry;
          loaded.push(entry);
        } catch {
          // Skip corrupted line
        }
      }

      this.entries = loaded;
      if (loaded.length > 0) {
        this.lastHash = loaded[loaded.length - 1].hash;
      }
    } catch (err) {
      console.warn('Failed to load audit ledger from file:', err);
    }
  }

  private appendToFile(entry: PayoutAuditEntry): void {
    if (!this.storageFilePath) return;

    try {
      fs.appendFileSync(
        this.storageFilePath,
        JSON.stringify(entry) + '\n',
        'utf8',
      );
    } catch (err) {
      console.error('Failed to append audit record to file:', err);
    }
  }

  private computeHash(
    sequenceNumber: number,
    previousHash: string,
    payoutId: string,
    action: string,
    actor: string,
    requestCorrelationId: string,
    providerReference: string,
    timestamp: string,
    metadata: Record<string, unknown>,
  ): string {
    return computeAuditEntryHash(previousHash, {
      sequenceNumber,
      payoutId,
      action: action as PayoutAuditAction,
      actor,
      requestCorrelationId,
      providerReference,
      timestamp,
      metadata,
    });
  }

  /**
   * Append an immutable audit event to the ledger.
   */
  public recordEvent(params: RecordPayoutEventParams): PayoutAuditEntry {
    const sequenceNumber = this.entries.length + 1;
    const timestamp = params.timestamp || new Date().toISOString();
    const requestCorrelationId = params.requestCorrelationId || 'n/a';
    const providerReference = params.providerReference || params.payoutId;
    const metadata = params.metadata ? { ...params.metadata } : {};
    const previousHash = this.lastHash;

    const hash = this.computeHash(
      sequenceNumber,
      previousHash,
      params.payoutId,
      params.action,
      params.actor,
      requestCorrelationId,
      providerReference,
      timestamp,
      metadata,
    );

    const entry: PayoutAuditEntry = Object.freeze({
      id: `audit_${sequenceNumber}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      sequenceNumber,
      payoutId: params.payoutId,
      action: params.action,
      actor: params.actor,
      requestCorrelationId,
      providerReference,
      timestamp,
      metadata,
      previousHash,
      hash,
    });

    this.entries.push(entry);
    this.lastHash = hash;
    this.appendToFile(entry);

    if (sequenceNumber % this.checkpointInterval === 0) {
      this.createCheckpoint(entry);
    }

    return entry;
  }

  private createCheckpoint(entry: PayoutAuditEntry): PayoutAuditCheckpoint {
    const checkpoint: PayoutAuditCheckpoint = Object.freeze({
      sequenceNumber: entry.sequenceNumber,
      entryHash: entry.hash,
      checkpointHash: computeCheckpointHash(entry.sequenceNumber, entry.hash),
      createdAt: new Date().toISOString(),
    });
    this.checkpoints.push(checkpoint);
    this.appendCheckpointToFile(checkpoint);
    return checkpoint;
  }

  /**
   * Return a copy of the recorded checkpoints (read-only).
   */
  public getCheckpoints(): PayoutAuditCheckpoint[] {
    return this.checkpoints.map((c) => ({ ...c }));
  }

  /**
   * Filter and paginate audit entries. Read-only.
   */
  public getEntries(
    filter?: PayoutAuditFilter,
    pagination?: PaginationOptions,
  ): PaginatedPayoutAuditResult {
    let filtered = [...this.entries];

    if (filter) {
      if (filter.payoutId) {
        filtered = filtered.filter((e) => e.payoutId === filter.payoutId);
      }
      if (filter.action) {
        filtered = filtered.filter((e) => e.action === filter.action);
      }
      if (filter.actor) {
        filtered = filtered.filter((e) => e.actor === filter.actor);
      }
      if (filter.providerReference) {
        filtered = filtered.filter(
          (e) => e.providerReference === filter.providerReference,
        );
      }
      if (filter.startDate) {
        const start = new Date(filter.startDate).getTime();
        filtered = filtered.filter(
          (e) => new Date(e.timestamp).getTime() >= start,
        );
      }
      if (filter.endDate) {
        const end = new Date(filter.endDate).getTime();
        filtered = filtered.filter(
          (e) => new Date(e.timestamp).getTime() <= end,
        );
      }
    }

    // Default newest first
    filtered.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    const total = filtered.length;
    const limit = Math.min(Math.max(pagination?.limit || 20, 1), 100);
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(Math.max(pagination?.page || 1, 1), totalPages);
    const startIndex = (page - 1) * limit;
    const paginatedEntries = filtered.slice(startIndex, startIndex + limit);

    return {
      entries: paginatedEntries,
      total,
      page,
      pageSize: limit,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  /**
   * Export audit log as CSV suitable for reconciliation.
   */
  public exportCsv(filter?: PayoutAuditFilter): string {
    const { entries } = this.getEntries(filter, { limit: 10000 });
    const headers = [
      'id',
      'sequenceNumber',
      'payoutId',
      'action',
      'actor',
      'requestCorrelationId',
      'providerReference',
      'timestamp',
      'metadata',
      'hash',
    ];

    const escapeCsv = (val: unknown): string => {
      if (val === undefined || val === null) return '""';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const rows = entries.map((e) =>
      [
        escapeCsv(e.id),
        escapeCsv(e.sequenceNumber),
        escapeCsv(e.payoutId),
        escapeCsv(e.action),
        escapeCsv(e.actor),
        escapeCsv(e.requestCorrelationId),
        escapeCsv(e.providerReference),
        escapeCsv(e.timestamp),
        escapeCsv(e.metadata),
        escapeCsv(e.hash),
      ].join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Verify cryptographic integrity of the append-only ledger.
   */
  public verifyIntegrity(): { valid: boolean; invalidEntries: string[] } {
    const result = verifyPayoutAuditChain(this.entries, this.checkpoints);
    return {
      valid: result.valid,
      invalidEntries: result.invalidEntries,
    };
  }

  /**
   * Explicitly prevent modification of historical records.
   */
  public update(): never {
    throw new Error(
      'Audit ledger is append-only: modifications are strictly prohibited.',
    );
  }

  public delete(): never {
    throw new Error(
      'Audit ledger is append-only: deletions are strictly prohibited.',
    );
  }

  /**
   * Test-only helper to reset in-memory state or switch directory
   */
  public _resetForTest(newDir?: string): void {
    this.entries = [];
    this.checkpoints = [];
    this.lastHash = GENESIS_HASH;
    this.storageFilePath = null;
    this.checkpointFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

/**
 * Offline verifier for a payout audit chain.
 *
 * Walks the supplied entries in order, recomputes each hash from the
 * canonical payload and previous hash, and validates any supplied
 * checkpoints. Detects:
 *  - deletion: sequence gaps or a chain that no longer starts at genesis
 *  - reordering: sequence numbers out of order or previousHash mismatch
 *  - payload_modification: recomputed hash differs from stored hash
 *  - checkpoint_mismatch: checkpoint hash or anchored entry hash differs
 *  - missing_checkpoint: a checkpoint references an absent sequence number
 *
 * The function is pure and does not touch storage, so it can be run offline
 * against exported ledger data.
 */
export function verifyPayoutAuditChain(
  entries: PayoutAuditEntry[],
  checkpoints: PayoutAuditCheckpoint[] = [],
): PayoutAuditVerificationResult {
  const issues: PayoutAuditVerificationIssue[] = [];
  const invalidEntries = new Set<string>();
  let expectedPrevious = GENESIS_HASH;
  let expectedSequence = 1;

  for (const entry of entries) {
    if (entry.sequenceNumber !== expectedSequence) {
      const isReorder = entry.sequenceNumber < expectedSequence;
      issues.push({
        type: isReorder ? 'reordering' : 'deletion',
        entryId: entry.id,
        sequenceNumber: entry.sequenceNumber,
        detail: isReorder
          ? `Entry sequence ${entry.sequenceNumber} appears after ${expectedSequence - 1}`
          : `Missing sequence number(s) before ${entry.sequenceNumber}`,
      });
      invalidEntries.add(entry.id);
    }

    if (entry.previousHash !== expectedPrevious) {
      issues.push({
        type: 'reordering',
        entryId: entry.id,
        sequenceNumber: entry.sequenceNumber,
        detail: `previousHash does not match prior entry hash at sequence ${entry.sequenceNumber}`,
      });
      invalidEntries.add(entry.id);
    }

    const calculated = computeAuditEntryHash(entry.previousHash, entry);
    if (calculated !== entry.hash) {
      issues.push({
        type: 'payload_modification',
        entryId: entry.id,
        sequenceNumber: entry.sequenceNumber,
        detail: `Recomputed hash does not match stored hash at sequence ${entry.sequenceNumber}`,
      });
      invalidEntries.add(entry.id);
    }

    expectedPrevious = entry.hash;
    expectedSequence = entry.sequenceNumber + 1;
  }

  const entryBySequence = new Map<number, PayoutAuditEntry>();
  for (const entry of entries) {
    entryBySequence.set(entry.sequenceNumber, entry);
  }

  for (const checkpoint of checkpoints) {
    const expectedCheckpointHash = computeCheckpointHash(
      checkpoint.sequenceNumber,
      checkpoint.entryHash,
    );
    if (expectedCheckpointHash !== checkpoint.checkpointHash) {
      issues.push({
        type: 'checkpoint_mismatch',
        sequenceNumber: checkpoint.sequenceNumber,
        detail: `Checkpoint hash invalid at sequence ${checkpoint.sequenceNumber}`,
      });
    }

    const anchored = entryBySequence.get(checkpoint.sequenceNumber);
    if (!anchored) {
      issues.push({
        type: 'missing_checkpoint',
        sequenceNumber: checkpoint.sequenceNumber,
        detail: `Checkpoint references missing sequence ${checkpoint.sequenceNumber}`,
      });
      continue;
    }

    if (anchored.hash !== checkpoint.entryHash) {
      issues.push({
        type: 'checkpoint_mismatch',
        entryId: anchored.id,
        sequenceNumber: checkpoint.sequenceNumber,
        detail: `Entry hash does not match checkpoint at sequence ${checkpoint.sequenceNumber}`,
      });
      invalidEntries.add(anchored.id);
    }
  }

  return {
    valid: issues.length === 0,
    entriesChecked: entries.length,
    checkpointsChecked: checkpoints.length,
    issues,
    invalidEntries: Array.from(invalidEntries),
  };
}

export const payoutAuditLedger = new PayoutAuditLedger();
