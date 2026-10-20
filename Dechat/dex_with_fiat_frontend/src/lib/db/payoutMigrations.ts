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
];
