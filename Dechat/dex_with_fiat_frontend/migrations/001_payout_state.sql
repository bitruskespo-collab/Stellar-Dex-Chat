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

-- Least-privilege runtime roles (Issue #262)
-- Split read and mutation access to payout tables. No wildcard grants.
-- Roles are created without LOGIN; credentials are provisioned out-of-band
-- by the deployment environment (never committed to the repository).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payout_reader') THEN
    CREATE ROLE payout_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payout_writer') THEN
    CREATE ROLE payout_writer NOLOGIN;
  END IF;
END
$$;

-- Read-only role: SELECT only on payout tables.
REVOKE ALL ON payout_intents FROM payout_reader;
REVOKE ALL ON payout_state_transitions FROM payout_reader;
GRANT SELECT ON payout_intents TO payout_reader;
GRANT SELECT ON payout_state_transitions TO payout_reader;

-- Mutation role: INSERT/UPDATE on payout tables, plus SELECT so that
-- RETURNING clauses and existence checks work. No DELETE/TRUNCATE.
REVOKE ALL ON payout_intents FROM payout_writer;
REVOKE ALL ON payout_state_transitions FROM payout_writer;
GRANT SELECT, INSERT, UPDATE ON payout_intents TO payout_writer;
GRANT SELECT, INSERT, UPDATE ON payout_state_transitions TO payout_writer;

-- Sequence usage for the transitions surrogate key (no wildcard sequence grant).
REVOKE ALL ON SEQUENCE payout_state_transitions_id_seq FROM payout_reader;
REVOKE ALL ON SEQUENCE payout_state_transitions_id_seq FROM payout_writer;
GRANT USAGE, SELECT ON SEQUENCE payout_state_transitions_id_seq TO payout_writer;

-- Explicitly ensure neither role can create objects or escalate.
REVOKE CREATE ON SCHEMA public FROM payout_reader;
REVOKE CREATE ON SCHEMA public FROM payout_writer;