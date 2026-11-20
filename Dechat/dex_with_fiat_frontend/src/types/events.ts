export interface ContractEvent {
  id: string;
  type: 'deposit' | 'withdraw';
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  actor: string;
  amount: string;
  token?: string;
  version: number;
}

export interface IndexerState {
  lastPagingToken: string;
  lastLedger: number;
  updatedAt: string;
}

/**
 * Durable cursor committed atomically with the batch of events it covers.
 * `ledgerHash` is the authoritative hash of `lastLedger` used for fork detection.
 */
export interface IndexerCheckpoint {
  id: string;
  lastPagingToken: string;
  lastLedger: number;
  ledgerHash: string;
  /** Number of events persisted in the same transaction as this checkpoint. */
  eventCount: number;
  /** Monotonic sequence used to order checkpoint commits. */
  sequence: number;
  updatedAt: string;
}

export type BackfillJobStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed';

/**
 * Bounded, resumable backfill job. Progress is persisted so a restart can
 * resume from `cursorLedger` without re-fetching completed ranges.
 */
export interface BackfillJob {
  id: string;
  contractId: string;
  status: BackfillJobStatus;
  /** Inclusive lower bound of the requested range. */
  fromLedger: number;
  /** Inclusive upper bound of the requested range. */
  toLedger: number;
  /** Next ledger to process; equals fromLedger when not yet started. */
  cursorLedger: number;
  /** Highest ledger successfully persisted by this job. */
  lastProcessedLedger: number;
  /** Maximum ledgers fetched per RPC batch. */
  batchSize: number;
  /** Minimum delay between RPC calls, in milliseconds. */
  throttleMs: number;
  processedEvents: number;
  /** Populated when status is 'failed' or 'cancelled'. */
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type ReorgAuditStatus = 'detected' | 'repairing' | 'repaired' | 'failed';

/**
 * Audit trail entry recording a detected fork/reorganization and the
 * rebuild performed from a trusted checkpoint.
 */
export interface ReorgAuditEntry {
  id: string;
  contractId: string;
  status: ReorgAuditStatus;
  /** First ledger whose stored hash diverged from authoritative RPC data. */
  invalidatedFromLedger: number;
  /** Last ledger that was invalidated (inclusive). */
  invalidatedToLedger: number;
  /** Trusted checkpoint the projections were rebuilt from. */
  trustedCheckpointLedger: number;
  trustedCheckpointHash: string;
  /** Stored hash that no longer matches the authoritative chain. */
  storedHash: string;
  /** Authoritative hash reported by RPC for the same ledger. */
  authoritativeHash: string;
  eventsInvalidated: number;
  eventsRebuilt: number;
  error?: string;
  detectedAt: string;
  repairedAt?: string;
}

export type ReconciliationSloStatus = 'healthy' | 'warning' | 'breached';

/**
 * Reconciliation SLO snapshot for unresolved payouts, surfaced in admin
 * views with age, amount at risk, next action, and source evidence.
 */
export interface ReconciliationSloRecord {
  id: string;
  contractId: string;
  /** Identifier of the unresolved payout or reconciliation item. */
  payoutId: string;
  status: ReconciliationSloStatus;
  /** Age of the unresolved item in seconds. */
  ageSeconds: number;
  /** Amount at risk, as a decimal string in the token's base units. */
  amountAtRisk: string;
  token?: string;
  /** Human-readable next action for operators. */
  nextAction: string;
  /** Link to the documented operator runbook for this state. */
  runbookUrl: string;
  /** Source evidence supporting the record (tx hash, ledger, RPC ref). */
  evidence: ReconciliationSloEvidence[];
  /** SLO threshold in seconds that produced `status`. */
  thresholdSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationSloEvidence {
  kind: 'ledger' | 'transaction' | 'rpc' | 'checkpoint' | 'audit';
  reference: string;
  ledger?: number;
  txHash?: string;
  observedAt: string;
  note?: string;
}