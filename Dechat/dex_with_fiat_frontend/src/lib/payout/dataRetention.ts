import crypto from 'crypto';

/**
 * Sensitivity level classifications for payout and financial data.
 */
export type SensitivityLevel =
  | 'RESTRICTED_PII'   // Sensitive personally identifiable info (account number, name, BVN)
  | 'OPERATIONAL'        // Transient provider credentials & identifiers (recipient_code, transfer_code)
  | 'AUDIT_FINANCIAL';   // Minimal non-identifying financial data preserved for compliance and accounting

export type PayoutStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type DeletionTrigger =
  | 'automated_expiry'
  | 'user_request'
  | 'admin_cleanup'
  | 'compliance_mandate';

export interface FieldPolicy {
  sensitivity: SensitivityLevel;
  redactInLogs: boolean;
  encryptAtRest: boolean;
  wipeOnDeletion: boolean;
  description: string;
}

/**
 * Declarative field classification registry.
 */
export const FIELD_CLASSIFICATIONS: Record<string, FieldPolicy> = {
  // RESTRICTED_PII: Highly sensitive personal and banking identifiers
  account_number: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Bank account number of beneficiary',
  },
  account_name: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Full legal name associated with bank account',
  },
  bvn: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Bank verification number or national tax identifier',
  },
  phone_number: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Beneficiary telephone contact number',
  },
  email: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Beneficiary email address',
  },

  // OPERATIONAL: Provider identifiers needed during execution but not for long-term audit
  recipient_code: {
    sensitivity: 'OPERATIONAL',
    redactInLogs: true,
    encryptAtRest: false,
    wipeOnDeletion: true,
    description: 'Provider recipient reference token (e.g., Paystack RCP_xxx)',
  },
  transfer_code: {
    sensitivity: 'OPERATIONAL',
    redactInLogs: true,
    encryptAtRest: false,
    wipeOnDeletion: true,
    description: 'Provider internal transfer transaction identifier',
  },
  bank_code: {
    sensitivity: 'OPERATIONAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Routing or institution code of beneficiary bank',
  },

  // AUDIT_FINANCIAL: Non-identifying minimal audit data preserved indefinitely
  reference: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Unique non-identifying transfer reference',
  },
  amount: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Numeric transfer amount in stroops or smallest fiat unit',
  },
  currency: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'ISO 4217 fiat or Stellar asset code',
  },
  fee: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Transaction processing fee',
  },
  status: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Current lifecycle state of payout',
  },
  createdAt: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Timestamp when payout was requested',
  },
  settledAt: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Timestamp when payout was settled or reached terminal status',
  },
  bankToken: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Non-reversible deterministic token of bank identifier for deduplication',
  },
};

/**
 * Retention periods (in milliseconds) before automatic deletion triggers.
 */
export const RETENTION_PERIODS_MS: Record<PayoutStatus, number> = {
  completed: 24 * 60 * 60 * 1000,      // 24 hours after completion
  failed: 48 * 60 * 60 * 1000,         // 48 hours to facilitate retry/support
  cancelled: 24 * 60 * 60 * 1000,      // 24 hours
  rejected: 24 * 60 * 60 * 1000,       // 24 hours
  pending: Number.POSITIVE_INFINITY,   // Active transfers must never be auto-deleted
};

/**
 * Retention horizons for high-volume audit and event data.
 * Each horizon defines how long rows remain in the hot (queryable) partition
 * before being moved to archive storage. Audit evidence is never destroyed.
 */
export type RetentionHorizon = 'HOT' | 'WARM' | 'ARCHIVE';

export interface RetentionHorizonPolicy {
  horizon: RetentionHorizon;
  /** Maximum age (ms) of rows kept in this horizon. */
  maxAgeMs: number;
  /** Whether rows in this horizon are still served by default queries. */
  queryable: boolean;
  description: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Declarative retention horizon registry for audit/event tables.
 * - HOT: last 30 days, fully queryable.
 * - WARM: 30-180 days, queryable with explicit horizon selection.
 * - ARCHIVE: older than 180 days, retrievable only via archive lookups.
 */
export const RETENTION_HORIZONS: Record<RetentionHorizon, RetentionHorizonPolicy> = {
  HOT: {
    horizon: 'HOT',
    maxAgeMs: 30 * DAY_MS,
    queryable: true,
    description: 'Recent audit/event rows served by default queries',
  },
  WARM: {
    horizon: 'WARM',
    maxAgeMs: 180 * DAY_MS,
    queryable: true,
    description: 'Aged rows queryable only with explicit horizon selection',
  },
  ARCHIVE: {
    horizon: 'ARCHIVE',
    maxAgeMs: Number.POSITIVE_INFINITY,
    queryable: false,
    description: 'Archived audit evidence retrievable via archive lookups only',
  },
};

/**
 * Resolves the retention horizon for a row based on its age relative to `now`.
 * Boundary semantics: a row exactly at a horizon boundary belongs to the
 * *older* horizon (age >= maxAgeMs moves it out of the current horizon).
 */
export function resolveRetentionHorizon(
  timestamp: number,
  now: number = Date.now(),
): RetentionHorizon {
  const age = now - timestamp;
  if (age < RETENTION_HORIZONS.HOT.maxAgeMs) {
    return 'HOT';
  }
  if (age < RETENTION_HORIZONS.WARM.maxAgeMs) {
    return 'WARM';
  }
  return 'ARCHIVE';
}

export interface PartitionBoundary {
  horizon: RetentionHorizon;
  /** Inclusive lower bound (epoch ms) of rows in this partition. */
  fromMs: number;
  /** Exclusive upper bound (epoch ms) of rows in this partition. */
  toMs: number;
}

/**
 * Computes time-based partition boundaries for the given reference time.
 * Partitions are contiguous and non-overlapping: [fromMs, toMs).
 */
export function computePartitionBoundaries(
  now: number = Date.now(),
): PartitionBoundary[] {
  return [
    {
      horizon: 'HOT',
      fromMs: now - RETENTION_HORIZONS.HOT.maxAgeMs,
      toMs: now,
    },
    {
      horizon: 'WARM',
      fromMs: now - RETENTION_HORIZONS.WARM.maxAgeMs,
      toMs: now - RETENTION_HORIZONS.HOT.maxAgeMs,
    },
    {
      horizon: 'ARCHIVE',
      fromMs: Number.NEGATIVE_INFINITY,
      toMs: now - RETENTION_HORIZONS.WARM.maxAgeMs,
    },
  ];
}

/**
 * A single audit/event row subject to retention partitioning.
 */
export interface AuditEventRow {
  id: string;
  reference: string;
  eventType: string;
  occurredAt: number;
  payload: Record<string, unknown>;
}

export interface ArchivedRow extends AuditEventRow {
  archivedAt: string;
  horizon: RetentionHorizon;
}

export interface ArchiveManifestEntry {
  id: string;
  reference: string;
  occurredAt: number;
  rowHash: string;
}

export interface ArchiveManifest {
  manifestId: string;
  createdAt: string;
  cutoffMs: number;
  rowCount: number;
  entries: ArchiveManifestEntry[];
  /** SHA-256 over the canonical manifest content for integrity verification. */
  integrityHash: string;
}

/**
 * Computes a deterministic SHA-256 hash of an audit row's canonical content.
 */
export function hashAuditRow(row: AuditEventRow): string {
  const canonical = JSON.stringify({
    id: row.id,
    reference: row.reference,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    payload: row.payload,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Computes the integrity hash of an archive manifest from its entries.
 */
export function computeManifestIntegrityHash(
  manifestId: string,
  createdAt: string,
  cutoffMs: number,
  entries: ArchiveManifestEntry[],
): string {
  const canonical = JSON.stringify({
    manifestId,
    createdAt,
    cutoffMs,
    entries,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verifies that a manifest's integrity hash matches its entries.
 */
export function verifyArchiveManifest(manifest: ArchiveManifest): boolean {
  const expected = computeManifestIntegrityHash(
    manifest.manifestId,
    manifest.createdAt,
    manifest.cutoffMs,
    manifest.entries,
  );
  return expected === manifest.integrityHash;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

const DEFAULT_ENCRYPTION_SECRET =
  process.env.PAYOUT_ENCRYPTION_KEY ||
  'default-test-secret-key-32-chars-long!';

/**
 * Derives a 32-byte key from the configured secret.
 */
function getDerivedKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts sensitive string data at rest using AES-256-GCM.
 */
export function encryptAtRest(
  plaintext: string,
  secretKey: string = DEFAULT_ENCRYPTION_SECRET,
): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const key = getDerivedKey(secretKey);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext,
    iv: iv.toString('hex'),
    tag,
  };
}

/**
 * Decrypts AES-256-GCM encrypted payload at rest.
 */
export function decryptAtRest(
  payload: EncryptedPayload,
  secretKey: string = DEFAULT_ENCRYPTION_SECRET,
): string {
  const key = getDerivedKey(secretKey);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Deterministically tokenizes a bank account identifier for reconciliation and deduplication.
 * This is an irreversible, salted cryptographic hash that prevents storing raw account numbers.
 */
export function tokenizeBankIdentifier(
  accountNumber: string,
  bankCode: string,
  salt: string = 'stellar-payout-token-salt',
): string {
  const cleanAccount = accountNumber.replace(/\D/g, '');
  const cleanBank = bankCode.trim().toLowerCase();
  const hash = crypto
    .createHmac('sha256', salt)
    .update(`${cleanBank}:${cleanAccount}`)
    .digest('hex');
  return `tok_bank_${hash.slice(0, 16)}`;
}

/**
 * Masks a bank account number, retaining only the last 4 digits.
 */
export function maskAccountNumber(accountNumber: string): string {
  const cleaned = accountNumber.trim();
  if (cleaned.length <= 4) {
    return '****';
  }
  const lastFour = cleaned.slice(-4);
  return `${'*'.repeat(cleaned.length - 4)}${lastFour}`;
}

/**
 * Redacts sensitive payout PII from logs, analytics, and telemetry objects.
 * Recursively scrubs fields classified as sensitive and replaces them with [REDACTED].
 */
export function redactSensitivePayoutData<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitivePayoutData(item)) as unknown as T;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const policy = FIELD_CLASSIFICATIONS[key];
    const isSensitiveKey =
      (policy && policy.redactInLogs) ||
      /account_?number|account_?name|bvn|recipient_?code|transfer_?code|phone|email/i.test(
        key,
      );

    if (isSensitiveKey) {
      if (typeof value === 'string' && /account_?number/i.test(key)) {
        redacted[key] = maskAccountNumber(value);
      } else {
        redacted[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitivePayoutData(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted as T;
}

export interface MinimalFinancialAuditSummary {
  reference: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  bankToken: string;
  createdAt: number;
  settledAt?: number;
}

export interface DeletionProof {
  deletionProofId: string;
  reference: string;
  deletedAt: string;
  reason: DeletionTrigger;
  requestedBy?: string;
  fieldsWiped: string[];
  auditHash: string;
  preservedAuditReference: MinimalFinancialAuditSummary;
}

export interface PayoutRecord {
  reference: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  createdAt: number;
  settledAt?: number;
  bankCode: string;
  bankToken: string;

  // Sensitive PII fields (cleared upon verifiable deletion)
  accountNumber?: string;
  accountName?: string;
  bvn?: string;
  encryptedPii?: EncryptedPayload;
  recipientCode?: string;
  transferCode?: string;

  // Deletion metadata
  isPiiDeleted?: boolean;
  deletionProof?: DeletionProof;
}

/**
 * Computes a verifiable cryptographic SHA-256 hash certificate for deletion.
 */
export function generateAuditHash(
  reference: string,
  deletedAt: string,
  summary: MinimalFinancialAuditSummary,
): string {
  const content = JSON.stringify({
    reference,
    deletedAt,
    summary,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verifiable deletion workflow:
 * Eradicates all restricted PII and operational identifiers while preserving
 * an immutable, non-identifying financial audit summary and verifiable cryptographic proof.
 *
 * Implements strict idempotency: if already deleted, returns the existing proof.
 */
export function deletePayoutPii(
  record: PayoutRecord,
  reason: DeletionTrigger,
  options?: { requestedBy?: string },
): { updatedRecord: PayoutRecord; proof: DeletionProof } {
  // Idempotency: If already deleted, return existing proof without altering history
  if (record.isPiiDeleted && record.deletionProof) {
    return {
      updatedRecord: record,
      proof: record.deletionProof,
    };
  }

  // Active pending transfers cannot be deleted
  if (record.status === 'pending') {
    throw new Error(
      `Cannot execute PII deletion on pending transfer ${record.reference}. Payout must reach terminal status before data retention deletion.`,
    );
  }

  const deletedAt = new Date().toISOString();
  const fieldsWiped: string[] = [];

  if (record.accountNumber !== undefined) fieldsWiped.push('account_number');
  if (record.accountName !== undefined) fieldsWiped.push('account_name');
  if (record.bvn !== undefined) fieldsWiped.push('bvn');
  if (record.encryptedPii !== undefined) fieldsWiped.push('encrypted_pii');
  if (record.recipientCode !== undefined) fieldsWiped.push('recipient_code');
  if (record.transferCode !== undefined) fieldsWiped.push('transfer_code');

  const preservedAuditReference: MinimalFinancialAuditSummary = {
    reference: record.reference,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    bankToken: record.bankToken,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
  };

  const auditHash = generateAuditHash(
    record.reference,
    deletedAt,
    preservedAuditReference,
  );

  const proof: DeletionProof = {
    deletionProofId: `proof_${crypto.randomBytes(8).toString('hex')}`,
    reference: record.reference,
    deletedAt,
    reason,
    requestedBy: options?.requestedBy,
    fieldsWiped,
    auditHash,
    preservedAuditReference,
  };

  const updatedRecord: PayoutRecord = {
    reference: record.reference,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    bankCode: record.bankCode,
    bankToken: record.bankToken,
    isPiiDeleted: true,
    deletionProof: proof,
    // Sensitive fields explicitly scrubbed
    accountNumber: undefined,
    accountName: undefined,
    bvn: undefined,
    encryptedPii: undefined,
    recipientCode: undefined,
    transferCode: undefined,
  };

  return { updatedRecord, proof };
}

/**
 * Service managing payout data lifecycle, tokenization, encryption at rest,
 * automated retention pruning, and verifiable deletion workflows.
 */
export class PayoutRetentionService {
  private records = new Map<string, PayoutRecord>();
  private deletionProofs = new Map<string, DeletionProof>();
  private encryptionSecret: string;

  constructor(encryptionSecret: string = DEFAULT_ENCRYPTION_SECRET) {
    this.encryptionSecret = encryptionSecret;
  }

  /**
   * Securely saves a payout record, tokenizing bank details and encrypting sensitive PII at rest.
   */
  public savePayout(input: {
    reference: string;
    amount: number;
    currency: string;
    status: PayoutStatus;
    accountNumber: string;
    accountName: string;
    bankCode: string;
    bvn?: string;
    recipientCode?: string;
    transferCode?: string;
    createdAt?: number;
    settledAt?: number;
  }): PayoutRecord {
    const bankToken = tokenizeBankIdentifier(input.accountNumber, input.bankCode);

    // Encrypt sensitive PII blob at rest
    const piiPayload = JSON.stringify({
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      bvn: input.bvn,
    });
    const encryptedPii = encryptAtRest(piiPayload, this.encryptionSecret);

    const record: PayoutRecord = {
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      status: input.status,
      createdAt: input.createdAt || Date.now(),
      settledAt: input.settledAt,
      bankCode: input.bankCode,
      bankToken,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      bvn: input.bvn,
      encryptedPii,
      recipientCode: input.recipientCode,
      transferCode: input.transferCode,
      isPiiDeleted: false,
    };

    this.records.set(record.reference, record);
    return record;
  }

  public getRecord(
    reference: string,
    options?: { includeDecryptedPii?: boolean },
  ): PayoutRecord | null {
    const record = this.records.get(reference);
    if (!record) return null;

    if (!options?.includeDecryptedPii || record.isPiiDeleted) {
      return {
        ...record,
        // Redact in memory unless explicitly authorized
        accountNumber: record.accountNumber
          ? maskAccountNumber(record.accountNumber)
          : undefined,
        accountName: record.accountName ? '[REDACTED]' : undefined,
        bvn: record.bvn ? '[REDACTED]' : undefined,
      };
    }

    return record;
  }

  /**
   * Executes verifiable deletion workflow for a specific payout reference.
   */
  public deletePayoutPii(
    reference: string,
    reason: DeletionTrigger,
    options?: { requestedBy?: string },
  ): DeletionProof {
    const existing = this.records.get(reference);
    if (!existing) {
      throw new Error(`Payout record not found for reference: ${reference}`);
    }

    const { updatedRecord, proof } = deletePayoutPii(existing, reason, options);
    this.records.set(reference, updatedRecord);
    this.deletionProofs.set(reference, proof);
    return proof;
  }

  /**
   * Scans all stored records and prunes expired records based on retention policy.
   */
  public pruneExpiredPayouts(now: number = Date.now()): {
    prunedProofs: DeletionProof[];
    activeCount: number;
  } {
    const prunedProofs: DeletionProof[] = [];

    for (const [reference, record] of this.records.entries()) {
      if (record.isPiiDeleted) {
        continue;
      }

      const retentionPeriod = RETENTION_PERIODS_MS[record.status];
      if (retentionPeriod === Number.POSITIVE_INFINITY) {
        continue;
      }

      const timestamp = record.settledAt || record.createdAt;
      if (now - timestamp >= retentionPeriod) {
        const proof = this.deletePayoutPii(reference, 'automated_expiry');
        prunedProofs.push(proof);
      }
    }

    const activeCount = Array.from(this.records.values()).filter(
      (r) => !r.isPiiDeleted,
    ).length;

    return { prunedProofs, activeCount };
  }

  public getDeletionProof(reference: string): DeletionProof | null {
    return this.deletionProofs.get(reference) || null;
  }

  public getAllDeletionProofs(): DeletionProof[] {
    return Array.from(this.deletionProofs.values());
  }

  public clear(): void {
    this.records.clear();
    this.deletionProofs.clear();
  }
}

/**
 * Online partition/archive service for high-volume audit and event tables.
 *
 * Rows are partitioned by retention horizon based on `occurredAt`. The archive
 * job moves rows that have crossed the WARM boundary into archive storage,
 * emitting a manifest with per-row and aggregate integrity hashes. Archived
 * audit evidence remains retrievable via `getArchivedRow` / `queryArchive`.
 */
export class AuditArchiveService {
  private hotRows = new Map<string, AuditEventRow>();
  private archivedRows = new Map<string, ArchivedRow>();
  private manifests = new Map<string, ArchiveManifest>();

  /**
   * Ingests an audit/event row into the hot partition.
   */
  public ingest(row: AuditEventRow): void {
    if (this.archivedRows.has(row.id)) {
      throw new Error(
        `Cannot re-ingest archived audit row ${row.id}; archive evidence is immutable.`,
      );
    }
    this.hotRows.set(row.id, row);
  }

  /**
   * Returns the retention horizon currently applicable to a row.
   */
  public horizonFor(rowId: string, now: number = Date.now()): RetentionHorizon | null {
    const hot = this.hotRows.get(rowId);
    if (hot) {
      return resolveRetentionHorizon(hot.occurredAt, now);
    }
    const archived = this.archivedRows.get(rowId);
    if (archived) {
      return 'ARCHIVE';
    }
    return null;
  }

  /**
   * Queries live (non-archived) rows within an optional horizon filter.
   * By default only HOT rows are returned; WARM requires explicit selection.
   */
  public queryLive(
    options: { horizon?: RetentionHorizon; now?: number } = {},
  ): AuditEventRow[] {
    const now = options.now ?? Date.now();
    const horizon = options.horizon ?? 'HOT';
    if (horizon === 'ARCHIVE') {
      return [];
    }
    const result: AuditEventRow[] = [];
    for (const row of this.hotRows.values()) {
      if (resolveRetentionHorizon(row.occurredAt, now) === horizon) {
        result.push(row);
      }
    }
    return result.sort((a, b) => a.occurredAt - b.occurredAt);
  }

  /**
   * Online archive job: moves rows older than the WARM boundary into archive
   * storage and produces a manifest with integrity hashes.
   *
   * Boundary semantics: rows with age >= WARM.maxAgeMs are archived.
   * Returns an empty manifest (rowCount 0) when nothing is eligible.
   */
  public runArchiveJob(now: number = Date.now()): ArchiveManifest {
    const cutoffMs = now - RETENTION_HORIZONS.WARM.maxAgeMs;
    const eligible: AuditEventRow[] = [];

    for (const [id, row] of this.hotRows.entries()) {
      if (row.occurredAt <= cutoffMs) {
        eligible.push(row);
        this.hotRows.delete(id);
      }
    }

    eligible.sort((a, b) => a.occurredAt - b.occurredAt);

    const archivedAt = new Date(now).toISOString();
    const entries: ArchiveManifestEntry[] = eligible.map((row) => {
      const rowHash = hashAuditRow(row);
      this.archivedRows.set(row.id, {
        ...row,
        archivedAt,
        horizon: 'ARCHIVE',
      });
      return {
        id: row.id,
        reference: row.reference,
        occurredAt: row.occurredAt,
        rowHash,
      };
    });

    const manifestId = `manifest_${crypto.randomBytes(8).toString('hex')}`;
    const integrityHash = computeManifestIntegrityHash(
      manifestId,
      archivedAt,
      cutoffMs,
      entries,
    );

    const manifest: ArchiveManifest = {
      manifestId,
      createdAt: archivedAt,
      cutoffMs,
      rowCount: entries.length,
      entries,
      integrityHash,
    };

    this.manifests.set(manifestId, manifest);
    return manifest;
  }

  /**
   * Retrieves an archived audit row by id. Archived evidence is immutable.
   */
  public getArchivedRow(rowId: string): ArchivedRow | null {
    return this.archivedRows.get(rowId) || null;
  }

  /**
   * Queries archived rows by reference and/or time range (inclusive bounds).
   */
  public queryArchive(options: {
    reference?: string;
    fromMs?: number;
    toMs?: number;
  } = {}): ArchivedRow[] {
    const result: ArchivedRow[] = [];
    for (const row of this.archivedRows.values()) {
      if (options.reference !== undefined && row.reference !== options.reference) {
        continue;
      }
      if (options.fromMs !== undefined && row.occurredAt < options.fromMs) {
        continue;
      }
      if (options.toMs !== undefined && row.occurredAt > options.toMs) {
        continue;
      }
      result.push(row);
    }
    return result.sort((a, b) => a.occurredAt - b.occurredAt);
  }

  public getManifest(manifestId: string): ArchiveManifest | null {
    return this.manifests.get(manifestId) || null;
  }

  public getAllManifests(): ArchiveManifest[] {
    return Array.from(this.manifests.values());
  }

  public clear(): void {
    this.hotRows.clear();
    this.archivedRows.clear();
    this.manifests.clear();
  }
}
