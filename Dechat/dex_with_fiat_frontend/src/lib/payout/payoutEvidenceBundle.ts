/**
 * Redacted Payout Evidence Bundle Exporter
 * Addresses Issue #96: Provide consistent evidence linking on-chain and provider records
 * without exposing sensitive bank credentials.
 */

export interface PayoutEvidenceBundle {
  bundleVersion: number;
  exportedAt: string;
  network: string;
  contractId: string;
  txHash: string;
  receiptReference: string;
  providerReference: string;
  statusSource: 'authoritative_contract' | 'provider_webhook';
  timestamps: {
    initiatedAt: number;
    confirmedOnChainAt?: number;
    providerDispatchedAt?: number;
    settledAt?: number;
  };
  recipient: {
    accountMasked: string; // e.g. "******7890"
    bankName: string;
  };
  integrityChecksum: string;
}

/**
 * Retention tiers for archived payout evidence (Issue #251).
 * - audit: long-lived compliance record of the payout decision trail.
 * - webhook: provider callback payloads retained for dispute resolution.
 * - provider: provider-side dispatch/settlement evidence.
 */
export type EvidenceRetentionTier = 'audit' | 'webhook' | 'provider';

export interface EvidenceRetentionPolicy {
  tier: EvidenceRetentionTier;
  /** Retention window in days. */
  retentionDays: number;
}

export const DEFAULT_RETENTION_POLICIES: Record<EvidenceRetentionTier, EvidenceRetentionPolicy> = {
  audit: { tier: 'audit', retentionDays: 2555 }, // ~7 years
  webhook: { tier: 'webhook', retentionDays: 365 },
  provider: { tier: 'provider', retentionDays: 365 },
};

export interface ArchivedEvidenceRecord {
  /** Stable identifier used to reconcile against active payout state. */
  payoutId: string;
  tier: EvidenceRetentionTier;
  bundle: PayoutEvidenceBundle;
}

export interface EvidenceManifestEntry {
  payoutId: string;
  tier: EvidenceRetentionTier;
  checksum: string;
}

export interface EvidenceBundleArchive {
  archiveVersion: number;
  exportedAt: string;
  retentionPolicies: EvidenceRetentionPolicy[];
  manifest: EvidenceManifestEntry[];
  /** SHA-256 over the canonical manifest, used to detect tampering. */
  bundleChecksum: string;
  records: ArchivedEvidenceRecord[];
}

export interface EvidenceImportResult {
  records: ArchivedEvidenceRecord[];
  retentionPolicies: EvidenceRetentionPolicy[];
}

export interface EvidenceReconciliationMismatch {
  payoutId: string;
  field: string;
  archivedValue: unknown;
  activeValue: unknown;
}

export interface EvidenceReconciliationResult {
  reconciled: boolean;
  mismatches: EvidenceReconciliationMismatch[];
}

export class EvidenceBundleVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceBundleVerificationError';
  }
}

/**
 * Minimal synchronous SHA-256 implementation (FIPS 180-4) so export/import
 * verification works in any JS runtime without depending on WebCrypto.
 */
function sha256Hex(input: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Array<number>(64);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

/** Deterministic JSON serialization so checksums are stable across key ordering. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`).join(',')}}`;
}

function checksumRecord(record: ArchivedEvidenceRecord): string {
  return `sha256:${sha256Hex(canonicalize(record))}`;
}

function checksumManifest(manifest: EvidenceManifestEntry[]): string {
  return `sha256:${sha256Hex(canonicalize(manifest))}`;
}

/**
 * Exports archived evidence records into a checksummed, tamper-evident bundle.
 * Each record gets its own SHA-256 checksum and the manifest is checksummed too.
 */
export function exportEvidenceBundle(
  records: ArchivedEvidenceRecord[],
  options: { retentionPolicies?: EvidenceRetentionPolicy[]; exportedAt?: string } = {},
): EvidenceBundleArchive {
  const retentionPolicies = options.retentionPolicies
    ? [...options.retentionPolicies]
    : Object.values(DEFAULT_RETENTION_POLICIES).map((policy) => ({ ...policy }));

  const manifest: EvidenceManifestEntry[] = records.map((record) => ({
    payoutId: record.payoutId,
    tier: record.tier,
    checksum: checksumRecord(record),
  }));

  return {
    archiveVersion: 1,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    retentionPolicies,
    manifest,
    bundleChecksum: checksumManifest(manifest),
    records: records.map((record) => ({
      payoutId: record.payoutId,
      tier: record.tier,
      bundle: { ...record.bundle, timestamps: { ...record.bundle.timestamps }, recipient: { ...record.bundle.recipient } },
    })),
  };
}

/**
 * Verifies and restores an evidence bundle. Throws EvidenceBundleVerificationError
 * when the bundle checksum or any per-record checksum does not match.
 */
export function importEvidenceBundle(archive: EvidenceBundleArchive): EvidenceImportResult {
  if (!archive || typeof archive !== 'object') {
    throw new EvidenceBundleVerificationError('Evidence bundle is missing or malformed');
  }
  if (archive.archiveVersion !== 1) {
    throw new EvidenceBundleVerificationError(`Unsupported archive version: ${String(archive.archiveVersion)}`);
  }
  if (!Array.isArray(archive.records) || !Array.isArray(archive.manifest)) {
    throw new EvidenceBundleVerificationError('Evidence bundle is missing records or manifest');
  }
  if (archive.records.length !== archive.manifest.length) {
    throw new EvidenceBundleVerificationError('Manifest length does not match record count');
  }

  const expectedBundleChecksum = checksumManifest(archive.manifest);
  if (expectedBundleChecksum !== archive.bundleChecksum) {
    throw new EvidenceBundleVerificationError('Bundle checksum mismatch: archive may have been tampered with');
  }

  const restored: ArchivedEvidenceRecord[] = archive.records.map((record, index) => {
    const entry = archive.manifest[index];
    if (!entry || entry.payoutId !== record.payoutId || entry.tier !== record.tier) {
      throw new EvidenceBundleVerificationError(`Manifest entry ${index} does not match record`);
    }
    const actual = checksumRecord(record);
    if (actual !== entry.checksum) {
      throw new EvidenceBundleVerificationError(`Checksum mismatch for payout ${record.payoutId}`);
    }
    return {
      payoutId: record.payoutId,
      tier: record.tier,
      bundle: { ...record.bundle, timestamps: { ...record.bundle.timestamps }, recipient: { ...record.bundle.recipient } },
    };
  });

  return {
    records: restored,
    retentionPolicies: Array.isArray(archive.retentionPolicies)
      ? archive.retentionPolicies.map((policy) => ({ ...policy }))
      : [],
  };
}

export interface ActivePayoutState {
  payoutId: string;
  txHash: string;
  receiptReference: string;
  providerReference: string;
  statusSource: 'authoritative_contract' | 'provider_webhook';
}

/**
 * Reconciles restored evidence records against active payout state.
 * Returns every mismatch so operators can investigate rather than failing fast.
 */
export function reconcileEvidenceWithActiveState(
  records: ArchivedEvidenceRecord[],
  activeState: ActivePayoutState[],
): EvidenceReconciliationResult {
  const activeById = new Map(activeState.map((state) => [state.payoutId, state]));
  const mismatches: EvidenceReconciliationMismatch[] = [];

  for (const record of records) {
    const active = activeById.get(record.payoutId);
    if (!active) {
      mismatches.push({
        payoutId: record.payoutId,
        field: 'payoutId',
        archivedValue: record.payoutId,
        activeValue: undefined,
      });
      continue;
    }

    const fields: Array<keyof ActivePayoutState> = [
      'txHash',
      'receiptReference',
      'providerReference',
      'statusSource',
    ];
    for (const field of fields) {
      const archivedValue = record.bundle[field];
      const activeValue = active[field];
      if (archivedValue !== activeValue) {
        mismatches.push({ payoutId: record.payoutId, field, archivedValue, activeValue });
      }
    }
  }

  return { reconciled: mismatches.length === 0, mismatches };
}

/**
 * Creates a sanitized, verifiable evidence bundle with recipient account masking.
 */
export function createRedactedEvidenceBundle(params: {
  network: string;
  contractId: string;
  txHash: string;
  receiptReference: string;
  providerReference: string;
  timestamps: { initiatedAt: number; confirmedOnChainAt?: number; providerDispatchedAt?: number; settledAt?: number };
  rawBankAccount: string;
  bankName: string;
}): PayoutEvidenceBundle {
  const maskedAccount = params.rawBankAccount.length > 4
    ? `******${params.rawBankAccount.slice(-4)}`
    : '****';

  const rawPayloadForChecksum = `${params.txHash}:${params.receiptReference}:${params.providerReference}:${params.timestamps.initiatedAt}`;
  
  // Simple deterministic hash for tamper check
  let hash = 0;
  for (let i = 0; i < rawPayloadForChecksum.length; i++) {
    hash = (hash << 5) - hash + rawPayloadForChecksum.charCodeAt(i);
    hash |= 0;
  }
  const integrityChecksum = `sha256_${Math.abs(hash).toString(16)}`;

  return {
    bundleVersion: 1,
    exportedAt: new Date().toISOString(),
    network: params.network,
    contractId: params.contractId,
    txHash: params.txHash,
    receiptReference: params.receiptReference,
    providerReference: params.providerReference,
    statusSource: 'authoritative_contract',
    timestamps: params.timestamps,
    recipient: {
      accountMasked: maskedAccount,
      bankName: params.bankName,
    },
    integrityChecksum,
  };
}
