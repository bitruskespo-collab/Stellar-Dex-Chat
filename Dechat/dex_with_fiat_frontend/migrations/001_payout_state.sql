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

-- Transactional outbox for payout side effects (Issue #222).
-- Rows are written in the same DB transaction as the payout state mutation so
-- the state change and the outbound provider command commit or roll back
-- together. A dispatcher delivers pending rows asynchronously (at-least-once)
-- using the stable idempotency_key so provider retries and replays are safe.
CREATE TABLE IF NOT EXISTS payout_outbox (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  command_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP WITH TIME ZONE
);

-- Provider capability contract for reversals and recalls (Issue #223).
-- Each provider adapter declares which cancellation, recall, and status
-- semantics it supports. Actions a provider does not support are routed to an
-- explicit manual-review outcome instead of reporting a false success.
CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider_id VARCHAR(64) PRIMARY KEY,
  supports_cancel BOOLEAN NOT NULL DEFAULT FALSE,
  supports_recall BOOLEAN NOT NULL DEFAULT FALSE,
  supports_status BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_semantics VARCHAR(32) NOT NULL DEFAULT 'unsupported',
  recall_semantics VARCHAR(32) NOT NULL DEFAULT 'unsupported',
  status_semantics VARCHAR(32) NOT NULL DEFAULT 'unsupported',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT provider_capabilities_cancel_semantics_check
    CHECK (cancel_semantics IN ('unsupported', 'synchronous', 'asynchronous')),
  CONSTRAINT provider_capabilities_recall_semantics_check
    CHECK (recall_semantics IN ('unsupported', 'synchronous', 'asynchronous')),
  CONSTRAINT provider_capabilities_status_semantics_check
    CHECK (status_semantics IN ('unsupported', 'polling', 'webhook'))
);

-- Manual-review queue for actions a provider cannot perform. Rows are created
-- instead of emitting a success transition so operators can resolve them.
CREATE TABLE IF NOT EXISTS payout_manual_reviews (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  action VARCHAR(32) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT payout_manual_reviews_action_check
    CHECK (action IN ('cancel', 'recall', 'status')),
  CONSTRAINT payout_manual_reviews_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed'))
);

-- Append-only reversal and dispute lifecycle (Issue #224).
-- Provider reversals and disputed transfers are recorded as immutable events
-- linked to the original payout. Each event captures the settlement evidence
-- (provider reference, amount, currency, evidence payload) so the original
-- settlement record is preserved even after the payout is reversed. Rows are
-- never updated or deleted; the current lifecycle state is derived from the
-- latest event per payout.
CREATE TABLE IF NOT EXISTS payout_reversals (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL,
  provider_reference VARCHAR(128),
  amount_minor_units BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL,
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payout_reversals_event_type_check
    CHECK (event_type IN ('reversal_requested', 'reversal_settled', 'dispute_opened', 'dispute_resolved')),
  CONSTRAINT payout_reversals_amount_check CHECK (amount_minor_units > 0)
);

-- A payout may only be reversed once; disputes may be opened and resolved
-- repeatedly but a reversal event is terminal for the successful state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_reversals_single_reversal
  ON payout_reversals(payout_id)
  WHERE event_type IN ('reversal_requested', 'reversal_settled');

-- Prevent a reversed transfer from remaining successful: once any reversal
-- event exists for a payout, the payout status must not be 'succeeded'.
CREATE OR REPLACE FUNCTION enforce_payout_reversal_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'succeeded' AND EXISTS (
    SELECT 1 FROM payout_reversals
    WHERE payout_id = NEW.id
      AND event_type IN ('reversal_requested', 'reversal_settled')
  ) THEN
    RAISE EXCEPTION 'payout % cannot remain succeeded after a reversal', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_intents_reversal_status ON payout_intents;
CREATE TRIGGER trg_payout_intents_reversal_status
  BEFORE UPDATE ON payout_intents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payout_reversal_status();

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_payout_outbox_status ON payout_outbox(status);
CREATE INDEX IF NOT EXISTS idx_payout_outbox_payout_id ON payout_outbox(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_manual_reviews_status ON payout_manual_reviews(status);
CREATE INDEX IF NOT EXISTS idx_payout_manual_reviews_payout_id ON payout_manual_reviews(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_reversals_payout_id ON payout_reversals(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_reversals_event_type ON payout_reversals(event_type);
