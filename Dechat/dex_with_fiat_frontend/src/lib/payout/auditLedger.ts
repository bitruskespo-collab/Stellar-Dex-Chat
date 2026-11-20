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

/**
 * Manifest describing a sealed archive partition. The manifest captures the
 * sequence/hash boundary of the archived segment so that the hash chain can be
 * verified across the hot/archive boundary even after the hot partition is
 * trimmed.
 */
export interface PayoutAuditArchiveManifest {
  archiveId: string;
  partition: 'archive';
  firstSequenceNumber: number;
  lastSequenceNumber: number;
  entryCount: number;
  firstPreviousHash: string;
  lastHash: string;
  archivedAt: string;
  fileName: string;
}

export interface ArchiveOptions {
  /** Archive entries with sequenceNumber <= this value. */
  upToSequenceNumber: number;
  /** Override the archival timestamp (useful for deterministic tests). */
  archivedAt?: string;
}

export interface ArchiveResult {
  manifest: PayoutAuditArchiveManifest;
  archivedCount: number;
}

const ARCHIVE_MANIFEST_FILE = 'payout_audit_archive_manifest.json';
const ARCHIVE_DIR_NAME = 'archive';

export class PayoutAuditLedger {
  private entries: PayoutAuditEntry[] = [];
  private storageFilePath: string | null = null;
  private storageDir: string | null = null;
  private lastHash = '0'.repeat(64);
  private archiveManifests: PayoutAuditArchiveManifest[] = [];

  constructor(storageDir?: string) {
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
      this.storageDir = storageDir;
      this.storageFilePath = path.join(storageDir, 'payout_audit_ledger.jsonl');
      this.loadFromFile();
      this.loadArchiveManifests();
    } catch (err) {
      console.warn('Failed to initialize audit ledger storage:', err);
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

  private getArchiveDir(): string | null {
    if (!this.storageDir) return null;
    return path.join(this.storageDir, ARCHIVE_DIR_NAME);
  }

  private getArchiveManifestPath(): string | null {
    if (!this.storageDir) return null;
    return path.join(this.storageDir, ARCHIVE_MANIFEST_FILE);
  }

  private loadArchiveManifests(): void {
    const manifestPath = this.getArchiveManifestPath();
    if (!manifestPath || !fs.existsSync(manifestPath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as PayoutAuditArchiveManifest[];
      if (Array.isArray(parsed)) {
        this.archiveManifests = parsed;
      }
    } catch (err) {
      console.warn('Failed to load audit archive manifests:', err);
    }
  }

  private persistArchiveManifests(): void {
    const manifestPath = this.getArchiveManifestPath();
    if (!manifestPath) return;

    try {
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(this.archiveManifests, null, 2),
        'utf8',
      );
    } catch (err) {
      console.error('Failed to persist audit archive manifests:', err);
    }
  }

  private readArchiveEntries(
    manifest: PayoutAuditArchiveManifest,
  ): PayoutAuditEntry[] {
    const archiveDir = this.getArchiveDir();
    if (!archiveDir) return [];

    const filePath = path.join(archiveDir, manifest.fileName);
    if (!fs.existsSync(filePath)) return [];

    try {
      const fileData = fs.readFileSync(filePath, 'utf8');
      const loaded: PayoutAuditEntry[] = [];
      for (const line of fileData.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          loaded.push(JSON.parse(line) as PayoutAuditEntry);
        } catch {
          // Skip corrupted line
        }
      }
      return loaded;
    } catch (err) {
      console.warn('Failed to read archived audit partition:', err);
      return [];
    }
  }

  /**
   * All entries visible to queries: archived partitions (oldest first) followed
   * by the hot partition. Sequence numbers remain contiguous across the
   * boundary because archival never renumbers entries.
   */
  private getAllEntries(): PayoutAuditEntry[] {
    const archived: PayoutAuditEntry[] = [];
    for (const manifest of this.archiveManifests) {
      archived.push(...this.readArchiveEntries(manifest));
    }
    return [...archived, ...this.entries];
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
    const raw = `${sequenceNumber}|${previousHash}|${payoutId}|${action}|${actor}|${requestCorrelationId}|${providerReference}|${timestamp}|${JSON.stringify(metadata)}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
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

    return entry;
  }

  /**
   * Filter and paginate audit entries across hot and archived partitions.
   * Read-only. Cursor semantics (page/limit) are preserved across archival
   * because the merged view keeps the original sequence ordering.
   */
  public getEntries(
    filter?: PayoutAuditFilter,
    pagination?: PaginationOptions,
  ): PaginatedPayoutAuditResult {
    let filtered = this.getAllEntries();

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
   * Verify cryptographic integrity of the append-only ledger, including across
   * archival boundaries. Archived entries are verified first, then the hot
   * partition continues the chain from the last archived hash.
   */
  public verifyIntegrity(): { valid: boolean; invalidEntries: string[] } {
    let expectedPrevious = '0'.repeat(64);
    const invalidEntries: string[] = [];

    for (const entry of this.getAllEntries()) {
      if (entry.previousHash !== expectedPrevious) {
        invalidEntries.push(entry.id);
      }

      const calculated = this.computeHash(
        entry.sequenceNumber,
        entry.previousHash,
        entry.payoutId,
        entry.action,
        entry.actor,
        entry.requestCorrelationId,
        entry.providerReference,
        entry.timestamp,
        entry.metadata,
      );

      if (calculated !== entry.hash) {
        invalidEntries.push(entry.id);
      }

      expectedPrevious = entry.hash;
    }

    return {
      valid: invalidEntries.length === 0,
      invalidEntries,
    };
  }

  /**
   * Verify that every archive manifest is internally consistent and that the
   * archived segments chain together and into the hot partition.
   */
  public verifyArchiveManifests(): {
    valid: boolean;
    invalidArchives: string[];
  } {
    const invalidArchives: string[] = [];
    let expectedPrevious = '0'.repeat(64);

    for (const manifest of this.archiveManifests) {
      const entries = this.readArchiveEntries(manifest);

      if (entries.length !== manifest.entryCount) {
        invalidArchives.push(manifest.archiveId);
        continue;
      }

      if (entries.length === 0) {
        if (
          manifest.firstSequenceNumber !== manifest.lastSequenceNumber ||
          manifest.firstPreviousHash !== expectedPrevious
        ) {
          invalidArchives.push(manifest.archiveId);
        }
        expectedPrevious = manifest.lastHash;
        continue;
      }

      const first = entries[0];
      const last = entries[entries.length - 1];

      if (
        first.sequenceNumber !== manifest.firstSequenceNumber ||
        last.sequenceNumber !== manifest.lastSequenceNumber ||
        first.previousHash !== manifest.firstPreviousHash ||
        last.hash !== manifest.lastHash ||
        first.previousHash !== expectedPrevious
      ) {
        invalidArchives.push(manifest.archiveId);
      }

      expectedPrevious = manifest.lastHash;
    }

    // The hot partition must continue the chain from the last archive.
    if (this.entries.length > 0) {
      if (this.entries[0].previousHash !== expectedPrevious) {
        invalidArchives.push('hot_partition');
      }
    }

    return {
      valid: invalidArchives.length === 0,
      invalidArchives,
    };
  }

  /**
   * Return the archive manifest references for audit evidence verification.
   */
  public getArchiveManifests(): PayoutAuditArchiveManifest[] {
    return this.archiveManifests.map((m) => ({ ...m }));
  }

  /**
   * Seal entries up to (and including) `upToSequenceNumber` into an archive
   * partition and trim them from the hot partition. The hash chain is
   * preserved: archived entries keep their original sequence numbers and
   * hashes, and the hot partition's first entry still references the last
   * archived hash.
   */
  public archiveUpTo(options: ArchiveOptions): ArchiveResult {
    const { upToSequenceNumber } = options;
    const archivedAt = options.archivedAt || new Date().toISOString();

    const toArchive = this.entries.filter(
      (e) => e.sequenceNumber <= upToSequenceNumber,
    );
    const remaining = this.entries.filter(
      (e) => e.sequenceNumber > upToSequenceNumber,
    );

    const first = toArchive[0];
    const last = toArchive[toArchive.length - 1];

    const archiveId = `archive_${Date.now()}_${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const fileName = `${archiveId}.jsonl`;

    const manifest: PayoutAuditArchiveManifest = {
      archiveId,
      partition: 'archive',
      firstSequenceNumber: first ? first.sequenceNumber : 0,
      lastSequenceNumber: last ? last.sequenceNumber : 0,
      entryCount: toArchive.length,
      firstPreviousHash: first ? first.previousHash : this.lastHash,
      lastHash: last ? last.hash : this.lastHash,
      archivedAt,
      fileName,
    };

    const archiveDir = this.getArchiveDir();
    if (archiveDir && toArchive.length > 0) {
      try {
        if (!fs.existsSync(archiveDir)) {
          fs.mkdirSync(archiveDir, { recursive: true });
        }
        const payload = toArchive
          .map((e) => JSON.stringify(e))
          .join('\n');
        fs.writeFileSync(
          path.join(archiveDir, fileName),
          payload + '\n',
          'utf8',
        );
      } catch (err) {
        console.error('Failed to write audit archive partition:', err);
        throw err;
      }
    }

    this.archiveManifests.push(manifest);
    this.persistArchiveManifests();

    this.entries = remaining;
    if (this.storageFilePath) {
      try {
        const payload = remaining.map((e) => JSON.stringify(e)).join('\n');
        fs.writeFileSync(
          this.storageFilePath,
          remaining.length > 0 ? payload + '\n' : '',
          'utf8',
        );
      } catch (err) {
        console.error('Failed to rewrite hot audit partition:', err);
      }
    }

    return { manifest, archivedCount: toArchive.length };
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
    this.lastHash = '0'.repeat(64);
    this.storageFilePath = null;
    this.storageDir = null;
    this.archiveManifests = [];
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export const payoutAuditLedger = new PayoutAuditLedger();
