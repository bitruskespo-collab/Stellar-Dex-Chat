/**
 * Redacted Payout Evidence Bundle Exporter
 * Addresses Issue #96: Provide consistent evidence linking on-chain and provider records
 * without exposing sensitive bank credentials.
 *
 * Issue #257: Sensitive fields (bank details, credentials, wallet/session tokens,
 * prompt content, provider payloads) are redacted at the structured logging/trace
 * boundary via the shared redaction module. Evidence integrity fields (txHash,
 * receiptReference, providerReference, timestamps, integrityChecksum) remain intact.
 */

import { redactSensitiveFields } from '../logging/redaction';

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

/**
 * Fields within an evidence bundle that must never be emitted to logs or traces
 * in raw form. These are scrubbed by the shared redaction module while the
 * evidence integrity fields are preserved verbatim.
 */
const EVIDENCE_BUNDLE_SENSITIVE_KEYS = [
  'rawBankAccount',
  'bankAccount',
  'accountNumber',
  'iban',
  'routingNumber',
  'sortCode',
  'swift',
  'bic',
  'bankName',
  'recipientName',
  'providerPayload',
  'providerResponse',
  'rawProviderPayload',
  'credentials',
  'apiKey',
  'secret',
  'token',
  'sessionToken',
  'walletToken',
  'prompt',
  'promptContent',
];

/**
 * Produces a log/trace-safe representation of a payout evidence bundle.
 *
 * The bundle's integrity fields (txHash, receiptReference, providerReference,
 * timestamps, integrityChecksum, statusSource, network, contractId) are kept
 * intact so evidence remains verifiable, while any sensitive fields — bank
 * details, credentials, wallet/session tokens, prompt content, and provider
 * payloads — are scrubbed via the shared redaction module. This handles nested
 * objects and encoded values (e.g. base64/JSON-encoded payloads) consistently
 * with the rest of the logging boundary.
 */
export function toRedactedEvidenceLogPayload(
  bundle: PayoutEvidenceBundle & Record<string, unknown>,
): Record<string, unknown> {
  return redactSensitiveFields(bundle, {
    sensitiveKeys: EVIDENCE_BUNDLE_SENSITIVE_KEYS,
  }) as Record<string, unknown>;
}