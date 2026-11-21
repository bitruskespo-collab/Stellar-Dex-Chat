-- Migration 001: Payout state and transitions schema (Issue #97)

CREATE TABLE IF NOT EXISTS payout_intents (
  id VARCHAR(64) PRIMARY KEY,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  contract_tx_hash VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  amount_minor_units BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL,
  provider_reference VARCHAR(128) UNIQUE,
  recipient_account_masked VARCHAR(32) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payout_state_transitions (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) REFERENCES payout_intents(id) ON DELETE CASCADE,
  from_status VARCHAR(32) NOT NULL,
  to_status VARCHAR(32) NOT NULL,
  reason TEXT,
  transitioned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Dual control for high-risk manual payout actions (Issue #229).
-- Each row records a requested retry/release/override action that requires an
-- independent reviewer approval before it is applied to the payout intent.
CREATE TABLE IF NOT EXISTS payout_dual_control_actions (
  id VARCHAR(64) PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  action_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  requester_id VARCHAR(128) NOT NULL,
  approver_id VARCHAR(128),
  reason TEXT NOT NULL,
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT payout_dual_control_action_type_check
    CHECK (action_type IN ('retry', 'release', 'override')),
  CONSTRAINT payout_dual_control_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT payout_dual_control_no_self_approval
    CHECK (approver_id IS NULL OR approver_id <> requester_id),
  CONSTRAINT payout_dual_control_decision_consistency
    CHECK (
      (status = 'pending' AND approver_id IS NULL AND decided_at IS NULL)
      OR (status IN ('approved', 'rejected') AND approver_id IS NOT NULL AND decided_at IS NOT NULL)
      OR (status = 'cancelled' AND decided_at IS NOT NULL)
    )
);

-- Provider reconciliation imports (Issue #230).
-- Each import batch is checksummed so re-imports are detectable, and each
-- imported row retains its provider source identifier for row-level provenance.
-- Reconciliation is read-only with respect to payout_intents: it never mutates
-- payouts implicitly; any payout change must go through an explicit action.
CREATE TABLE IF NOT EXISTS provider_reconciliation_imports (
  id VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(64) NOT NULL,
  statement_reference VARCHAR(128) NOT NULL,
  import_checksum VARCHAR(128) NOT NULL,
  record_count INTEGER NOT NULL,
  imported_by VARCHAR(128) NOT NULL,
  imported_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT provider_reconciliation_imports_checksum_unique
    UNIQUE (provider, import_checksum)
);

CREATE TABLE IF NOT EXISTS provider_reconciliation_records (
  id VARCHAR(64) PRIMARY KEY,
  import_id VARCHAR(64) NOT NULL REFERENCES provider_reconciliation_imports(id) ON DELETE CASCADE,
  source_record_id VARCHAR(128) NOT NULL,
  source_checksum VARCHAR(128) NOT NULL,
  provider_reference VARCHAR(128),
  amount_minor_units BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL,
  status VARCHAR(32) NOT NULL,
  matched_payout_id VARCHAR(64) REFERENCES payout_intents(id) ON DELETE SET NULL,
  conflict_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT provider_reconciliation_records_status_check
    CHECK (status IN ('matched', 'unmatched', 'conflicting')),
  CONSTRAINT provider_reconciliation_records_source_unique
    UNIQUE (import_id, source_record_id),
  CONSTRAINT provider_reconciliation_records_conflict_consistency
    CHECK (
      (status = 'conflicting' AND conflict_reason IS NOT NULL)
      OR (status <> 'conflicting' AND conflict_reason IS NULL)
    )
);

-- Adaptive, bounded payout status polling (Issue #231).
-- Tracks per-payout polling lifecycle so consumers can apply lifecycle-aware
-- backoff, enforce per-provider concurrency limits, and stop polling once a
-- terminal state is reached. last_checked_at and next_retry_at are exposed to
-- the UI; poll_attempts drives the backoff schedule.
CREATE TABLE IF NOT EXISTS payout_status_polls (
  payout_id VARCHAR(64) PRIMARY KEY REFERENCES payout_intents(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  last_observed_status VARCHAR(32),
  terminal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payout_status_polls_attempts_non_negative
    CHECK (poll_attempts >= 0),
  CONSTRAINT payout_status_polls_terminal_consistency
    CHECK (
      (terminal = FALSE AND next_retry_at IS NOT NULL)
      OR (terminal = TRUE AND next_retry_at IS NULL)
    )
);

-- Supported currency minor-unit (precision) metadata (Issue #232).
-- Single source of truth for currency precision used by payout validation.
-- Currencies absent from this table have unknown precision and MUST be
-- rejected by validation rather than defaulted or guessed.
CREATE TABLE IF NOT EXISTS payout_currency_precision (
  currency VARCHAR(8) PRIMARY KEY,
  minor_units SMALLINT NOT NULL,
  provider VARCHAR(64),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payout_currency_precision_minor_units_range
    CHECK (minor_units >= 0 AND minor_units <= 8)
);

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_payout_dual_control_payout_id ON payout_dual_control_actions(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_dual_control_status ON payout_dual_control_actions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_dual_control_pending_unique
  ON payout_dual_control_actions(payout_id, action_type)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_records_import_id
  ON provider_reconciliation_records(import_id);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_records_status
  ON provider_reconciliation_records(status);
CREATE INDEX IF NOT EXISTS idx_provider_reconciliation_records_matched_payout
  ON provider_reconciliation_records(matched_payout_id);
-- Supports per-provider concurrency limits and due-retry lookups for polling.
CREATE INDEX IF NOT EXISTS idx_payout_status_polls_provider_due
  ON payout_status_polls(provider, next_retry_at)
  WHERE terminal = FALSE;
