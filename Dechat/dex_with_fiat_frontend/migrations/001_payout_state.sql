-- Migration 001: Payout state and transitions schema (Issue #97)
-- Updated for Issue #250: unique constraints and locking semantics mirrored
-- from payoutMigrations so the production schema matches the tested
-- concurrency constraints (idempotency_key, provider_reference, webhook
-- event id, retry job key).

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

-- Webhook events: the event id is the natural idempotency key for inbound
-- provider callbacks. The unique constraint guarantees a replayed webhook
-- cannot create a second event row under concurrent delivery.
CREATE TABLE IF NOT EXISTS payout_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(128) UNIQUE NOT NULL,
  payout_id VARCHAR(64) REFERENCES payout_intents(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  payload TEXT,
  received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Retry jobs: the retry key is unique so concurrent schedulers cannot enqueue
-- duplicate retry work for the same payout/attempt.
CREATE TABLE IF NOT EXISTS payout_retry_jobs (
  id BIGSERIAL PRIMARY KEY,
  retry_key VARCHAR(160) UNIQUE NOT NULL,
  payout_id VARCHAR(64) REFERENCES payout_intents(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status VARCHAR(32) NOT NULL,
  scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_payout_intents_provider_reference ON payout_intents(provider_reference);
CREATE INDEX IF NOT EXISTS idx_payout_webhook_events_payout_id ON payout_webhook_events(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_retry_jobs_payout_id ON payout_retry_jobs(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_retry_jobs_status ON payout_retry_jobs(status);