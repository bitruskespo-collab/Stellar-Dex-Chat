/**
 * Payout State Database Migration Definitions
 * Addresses Issue #97: Survive process restarts and coordinate payout operations
 * across application instances.
 */

export interface MigrationStep {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
}

export const PAYOUT_MIGRATIONS: MigrationStep[] = [
  {
    version: 1,
    name: 'create_payout_state_tables',
    upSql: `
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
    `,
    downSql: `
      DROP TABLE IF EXISTS payout_state_transitions;
      DROP TABLE IF EXISTS payout_intents;
    `,
  },
  {
    version: 2,
    name: 'create_indexer_ledger_tables',
    upSql: `
      CREATE TABLE IF NOT EXISTS indexer_events (
        id BIGSERIAL PRIMARY KEY,
        ledger_sequence BIGINT NOT NULL,
        event_index INTEGER NOT NULL,
        contract_id VARCHAR(64) NOT NULL,
        tx_hash VARCHAR(64) NOT NULL,
        ledger_hash VARCHAR(64) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        ingested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_indexer_events_ledger_event UNIQUE (ledger_sequence, event_index)
      );

      CREATE INDEX IF NOT EXISTS idx_indexer_events_canonical_order
        ON indexer_events(ledger_sequence, event_index);
      CREATE INDEX IF NOT EXISTS idx_indexer_events_contract
        ON indexer_events(contract_id, ledger_sequence, event_index);
      CREATE INDEX IF NOT EXISTS idx_indexer_events_ledger_hash
        ON indexer_events(ledger_sequence, ledger_hash);

      CREATE TABLE IF NOT EXISTS indexer_checkpoint (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        last_ledger_sequence BIGINT NOT NULL DEFAULT 0,
        last_ledger_hash VARCHAR(64),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_indexer_checkpoint_singleton CHECK (id = 1)
      );

      INSERT INTO indexer_checkpoint (id, last_ledger_sequence)
        VALUES (1, 0)
        ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS indexer_backfill_jobs (
        id VARCHAR(64) PRIMARY KEY,
        from_ledger_sequence BIGINT NOT NULL,
        to_ledger_sequence BIGINT NOT NULL,
        next_ledger_sequence BIGINT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        error TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_indexer_backfill_range CHECK (to_ledger_sequence >= from_ledger_sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_indexer_backfill_jobs_status
        ON indexer_backfill_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS indexer_reorg_audit (
        id BIGSERIAL PRIMARY KEY,
        detected_from_ledger BIGINT NOT NULL,
        detected_to_ledger BIGINT NOT NULL,
        trusted_checkpoint_ledger BIGINT NOT NULL,
        trusted_checkpoint_hash VARCHAR(64),
        actor VARCHAR(128) NOT NULL,
        reason TEXT,
        detected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_indexer_reorg_range CHECK (detected_to_ledger >= detected_from_ledger)
      );

      CREATE INDEX IF NOT EXISTS idx_indexer_reorg_audit_detected_at
        ON indexer_reorg_audit(detected_at);
    `,
    downSql: `
      DROP TABLE IF EXISTS indexer_reorg_audit;
      DROP TABLE IF EXISTS indexer_backfill_jobs;
      DROP TABLE IF EXISTS indexer_checkpoint;
      DROP TABLE IF EXISTS indexer_events;
    `,
  },
];
