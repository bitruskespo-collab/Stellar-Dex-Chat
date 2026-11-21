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

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);

-- Issue #217: Tenant-aware AI budget accounting with atomic reservations.
-- Reservations are taken before model dispatch against both a per-user and a
-- global spend ceiling; actual usage is reconciled afterward. The reserved
-- amount is held in `reserved_minor_units` until the request settles, at which
-- point it is released and `spent_minor_units` is incremented by the actual
-- cost. Concurrent requests are serialized per tenant/user via row locks so
-- that the sum of reserved + spent can never exceed the configured ceiling.

CREATE TABLE IF NOT EXISTS ai_budget_accounts (
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  -- Configured ceilings (NULL means unlimited for that scope).
  user_ceiling_minor_units BIGINT,
  global_ceiling_minor_units BIGINT,
  -- Running totals for this tenant/user scope.
  reserved_minor_units BIGINT NOT NULL DEFAULT 0,
  spent_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT ai_budget_accounts_non_negative
    CHECK (reserved_minor_units >= 0 AND spent_minor_units >= 0)
);

-- One row per tenant to enforce the global ceiling atomically across users.
CREATE TABLE IF NOT EXISTS ai_budget_tenant_totals (
  tenant_id VARCHAR(64) PRIMARY KEY,
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  global_ceiling_minor_units BIGINT,
  reserved_minor_units BIGINT NOT NULL DEFAULT 0,
  spent_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_budget_tenant_totals_non_negative
    CHECK (reserved_minor_units >= 0 AND spent_minor_units >= 0)
);

-- Individual reservations. A reservation is created before dispatch and
-- settled (reconciled) or released (rolled back) afterward. The status column
-- makes the lifecycle explicit so partial/error responses can be reconciled.
CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'reserved',
  reserved_minor_units BIGINT NOT NULL,
  actual_minor_units BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT ai_budget_reservations_status_check
    CHECK (status IN ('reserved', 'settled', 'released')),
  CONSTRAINT ai_budget_reservations_amounts_check
    CHECK (reserved_minor_units >= 0 AND (actual_minor_units IS NULL OR actual_minor_units >= 0))
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_scope
  ON ai_budget_reservations(tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_request
  ON ai_budget_reservations(request_id);

-- Issue #219: Privacy-safe retention controls for model traces and
-- evaluation fixtures. Stored traces hold only redacted prompts/completions
-- (secrets and payout identifiers are stripped at the trace-write boundary),
-- and every row carries an explicit expiry so retention is enforced by
-- deletion rather than by trusting callers. Traces are scoped to a tenant and
-- a user/session so they can be deleted on request (right-to-erasure) and
-- swept by the retention job once `expires_at` has passed.

CREATE TABLE IF NOT EXISTS ai_model_traces (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128),
  request_id VARCHAR(128),
  -- Redacted prompt/completion payloads. Never store raw secrets or payout
  -- identifiers here; the write boundary sanitizes before insert.
  prompt_redacted TEXT,
  completion_redacted TEXT,
  -- True when redaction removed at least one sensitive span, so operators can
  -- audit that sanitization actually ran without seeing the removed data.
  redaction_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  -- Hard retention deadline. Rows past this are eligible for deletion.
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT ai_model_traces_retention_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_model_traces_user
  ON ai_model_traces(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_traces_session
  ON ai_model_traces(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_traces_expiry
  ON ai_model_traces(expires_at);

-- Evaluation fixtures follow the same retention contract: synthetic-only
-- inputs, redacted payloads, and an explicit expiry so fixtures cannot linger
-- indefinitely. `deleted_at` supports soft-deletion for audit while the
-- retention sweep hard-deletes expired rows.
CREATE TABLE IF NOT EXISTS ai_evaluation_fixtures (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  input_redacted TEXT,
  expected_redacted TEXT,
  redaction_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  deleted_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT ai_evaluation_fixtures_retention_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_evaluation_fixtures_tenant
  ON ai_evaluation_fixtures(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_evaluation_fixtures_expiry
  ON ai_evaluation_fixtures(expires_at);
