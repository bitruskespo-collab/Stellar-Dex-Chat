-- Migration 001: Payout state and transitions schema (Issue #97)
--
-- This file is applied by the checksummed migration runner in
-- `payoutMigrations.ts`. The runner records the SHA-256 checksum of this file
-- in `schema_migrations` and refuses to re-apply a migration whose checksum
-- has changed (see Issue #247). Keep this file immutable once applied; make
-- schema changes in a new numbered migration instead.

-- ---------------------------------------------------------------------------
-- Migration metadata (Issue #247)
-- ---------------------------------------------------------------------------
-- Records every applied migration together with its checksum so that repeat
-- applies are idempotent and drift is detected. `rollback_evidence` documents
-- the forward-recovery / rollback procedure for the migration.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rollback_evidence TEXT
);

-- Coordination lock so concurrent runners cannot apply migrations in
-- parallel. A single row (id = 1) is used as an advisory lock; runners acquire
-- it with `SELECT ... FOR UPDATE` inside a transaction and release it on
-- commit/rollback.
CREATE TABLE IF NOT EXISTS migration_lock (
  id SMALLINT PRIMARY KEY,
  locked_by VARCHAR(128),
  locked_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT migration_lock_singleton CHECK (id = 1)
);

INSERT INTO migration_lock (id, locked_by, locked_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Payout schema (Issue #97)
-- ---------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);