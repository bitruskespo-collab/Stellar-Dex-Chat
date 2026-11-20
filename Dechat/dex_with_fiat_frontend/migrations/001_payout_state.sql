-- Migration 001: Payout state and transitions schema (Issue #97)
-- Extended (Issue #258): cryptographic key-rotation metadata for stored payout fields.
-- Only key *identifiers* are persisted here; key material must never be stored in the database.

CREATE TABLE IF NOT EXISTS payout_intents (
  id VARCHAR(64) PRIMARY KEY,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  contract_tx_hash VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  amount_minor_units BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL,
  provider_reference VARCHAR(128) UNIQUE,
  recipient_account_masked VARCHAR(32) NOT NULL,
  -- Key identifier (not key material) used to encrypt recipient_account_masked.
  -- NULL means the value predates encryption-at-rest and must be treated as legacy.
  recipient_account_key_id VARCHAR(64),
  -- Key identifier (not key material) used to encrypt provider_reference.
  provider_reference_key_id VARCHAR(64),
  -- Rotation bookkeeping: which key the row is being migrated to, and progress state.
  -- rotation_state: NULL (not rotating), 'pending', 'in_progress', 'completed', 'rolled_back'
  rotation_state VARCHAR(32),
  rotation_target_key_id VARCHAR(64),
  rotation_started_at TIMESTAMP WITH TIME ZONE,
  rotation_completed_at TIMESTAMP WITH TIME ZONE,
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

-- Backward-compatible column additions for databases created before Issue #258.
-- ADD COLUMN IF NOT EXISTS keeps this migration idempotent and safe to re-run.
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS recipient_account_key_id VARCHAR(64);
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS provider_reference_key_id VARCHAR(64);
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS rotation_state VARCHAR(32);
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS rotation_target_key_id VARCHAR(64);
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS rotation_started_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE payout_intents ADD COLUMN IF NOT EXISTS rotation_completed_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);
-- Supports resumable re-encryption scans and rollback queries.
CREATE INDEX IF NOT EXISTS idx_payout_intents_rotation_state ON payout_intents(rotation_state);
CREATE INDEX IF NOT EXISTS idx_payout_intents_recipient_account_key_id ON payout_intents(recipient_account_key_id);
CREATE INDEX IF NOT EXISTS idx_payout_intents_provider_reference_key_id ON payout_intents(provider_reference_key_id);