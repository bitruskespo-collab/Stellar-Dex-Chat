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


-- Migration 002: Indexer ledger ingestion, checkpoints, backfills, and reorg audit
-- (Issues #242, #243, #244)
--
-- Mirrors the indexer tables created by the application migration runner so
-- operators can apply the schema out-of-band (e.g. via psql or a DBA pipeline)
-- without starting the app. All statements are idempotent and safe to re-run.
--
-- Canonical ordering: events are keyed by (ledger_sequence, tx_index,
-- event_index) so ingestion and backfills always advance in ledger order and
-- never overwrite newer canonical events with stale ones.

-- ---------------------------------------------------------------------------
-- indexer_events: canonical contract event records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_events (
  id BIGSERIAL PRIMARY KEY,
  contract_id VARCHAR(128) NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  ledger_hash VARCHAR(64) NOT NULL,
  tx_hash VARCHAR(64) NOT NULL,
  tx_index INTEGER NOT NULL,
  event_index INTEGER NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  -- TRUE while the event is part of the canonical chain; set FALSE when a
  -- reorg invalidates the range so projections can be rebuilt.
  is_canonical BOOLEAN NOT NULL DEFAULT TRUE,
  -- Monotonic ingestion marker used to detect out-of-order writes.
  ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_indexer_events_position
    UNIQUE (contract_id, ledger_sequence, tx_index, event_index)
);

CREATE INDEX IF NOT EXISTS idx_indexer_events_ledger
  ON indexer_events(contract_id, ledger_sequence);
CREATE INDEX IF NOT EXISTS idx_indexer_events_tx_hash
  ON indexer_events(tx_hash);
CREATE INDEX IF NOT EXISTS idx_indexer_events_ledger_hash
  ON indexer_events(ledger_hash);
CREATE INDEX IF NOT EXISTS idx_indexer_events_canonical
  ON indexer_events(contract_id, is_canonical, ledger_sequence);

-- ---------------------------------------------------------------------------
-- indexer_checkpoint: durable cursor committed atomically with events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_checkpoint (
  contract_id VARCHAR(128) PRIMARY KEY,
  -- Last fully committed ledger; ingestion resumes from last_ledger + 1.
  last_ledger_sequence BIGINT NOT NULL DEFAULT 0,
  last_ledger_hash VARCHAR(64),
  -- Highest ledger known to be final/trusted; used as reorg rebuild anchor.
  trusted_ledger_sequence BIGINT NOT NULL DEFAULT 0,
  trusted_ledger_hash VARCHAR(64),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- indexer_backfill_jobs: bounded, resumable, cancellable backfill progress
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_backfill_jobs (
  id VARCHAR(64) PRIMARY KEY,
  contract_id VARCHAR(128) NOT NULL,
  -- Inclusive ledger range for the job.
  from_ledger_sequence BIGINT NOT NULL,
  to_ledger_sequence BIGINT NOT NULL,
  -- Next ledger to process; persisted so restarts resume without gaps.
  next_ledger_sequence BIGINT NOT NULL,
  -- pending | running | paused | cancelled | completed | failed
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- RPC throttling: max requests per second and batch size for this job.
  rate_limit_per_second INTEGER NOT NULL DEFAULT 5,
  batch_size INTEGER NOT NULL DEFAULT 100,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_indexer_backfill_jobs_range
    CHECK (to_ledger_sequence >= from_ledger_sequence),
  CONSTRAINT ck_indexer_backfill_jobs_progress
    CHECK (next_ledger_sequence >= from_ledger_sequence)
);

CREATE INDEX IF NOT EXISTS idx_indexer_backfill_jobs_contract
  ON indexer_backfill_jobs(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_indexer_backfill_jobs_status
  ON indexer_backfill_jobs(status, updated_at);

-- ---------------------------------------------------------------------------
-- indexer_reorg_audit: audit trail for detected forks / reorganizations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS indexer_reorg_audit (
  id BIGSERIAL PRIMARY KEY,
  contract_id VARCHAR(128) NOT NULL,
  -- Inclusive invalidated ledger range that was rebuilt.
  from_ledger_sequence BIGINT NOT NULL,
  to_ledger_sequence BIGINT NOT NULL,
  -- Stored hash that no longer matched authoritative RPC data.
  expected_ledger_hash VARCHAR(64),
  -- Authoritative hash observed from RPC at detection time.
  observed_ledger_hash VARCHAR(64),
  -- Trusted checkpoint the projections were rebuilt from.
  rebuild_from_ledger_sequence BIGINT NOT NULL,
  -- Number of event rows invalidated / re-ingested during repair.
  invalidated_event_count INTEGER NOT NULL DEFAULT 0,
  reingested_event_count INTEGER NOT NULL DEFAULT 0,
  -- detected | repaired | failed
  status VARCHAR(32) NOT NULL DEFAULT 'detected',
  details JSONB,
  detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  repaired_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT ck_indexer_reorg_audit_range
    CHECK (to_ledger_sequence >= from_ledger_sequence)
);

CREATE INDEX IF NOT EXISTS idx_indexer_reorg_audit_contract
  ON indexer_reorg_audit(contract_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_indexer_reorg_audit_status
  ON indexer_reorg_audit(status, detected_at);
CREATE INDEX IF NOT EXISTS idx_indexer_reorg_audit_range
  ON indexer_reorg_audit(contract_id, from_ledger_sequence, to_ledger_sequence);