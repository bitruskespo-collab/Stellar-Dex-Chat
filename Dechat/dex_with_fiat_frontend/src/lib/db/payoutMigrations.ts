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
    name: 'add_payout_concurrency_constraints',
    upSql: `
      -- Idempotency and provider reference uniqueness are enforced by the
      -- UNIQUE constraints declared in version 1. Re-declare them defensively
      -- for databases provisioned before those constraints existed.
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'payout_intents_idempotency_key_key'
        ) THEN
          ALTER TABLE payout_intents
            ADD CONSTRAINT payout_intents_idempotency_key_key
            UNIQUE (idempotency_key);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'payout_intents_provider_reference_key'
        ) THEN
          ALTER TABLE payout_intents
            ADD CONSTRAINT payout_intents_provider_reference_key
            UNIQUE (provider_reference);
        END IF;
      END
      $$;

      -- Webhook events: deduplicate by provider event id so concurrent
      -- deliveries of the same event cannot create duplicate rows.
      CREATE TABLE IF NOT EXISTS payout_webhook_events (
        id BIGSERIAL PRIMARY KEY,
        provider_event_id VARCHAR(128) NOT NULL,
        payout_id VARCHAR(64) REFERENCES payout_intents(id) ON DELETE SET NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB,
        received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT payout_webhook_events_provider_event_id_key
          UNIQUE (provider_event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_payout_webhook_events_payout_id
        ON payout_webhook_events(payout_id);

      -- Retry jobs: idempotency key prevents duplicate retry scheduling when
      -- multiple workers race to enqueue the same payout retry.
      CREATE TABLE IF NOT EXISTS payout_retry_jobs (
        id BIGSERIAL PRIMARY KEY,
        payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
        idempotency_key VARCHAR(128) NOT NULL,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        scheduled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT payout_retry_jobs_idempotency_key_key
          UNIQUE (idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_payout_retry_jobs_status
        ON payout_retry_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_payout_retry_jobs_payout_id
        ON payout_retry_jobs(payout_id);
    `,
    downSql: `
      DROP TABLE IF EXISTS payout_retry_jobs;
      DROP TABLE IF EXISTS payout_webhook_events;
    `,
  },
];

/**
 * Row-level locking helpers used by payout workers to serialize concurrent
 * state transitions on the same payout intent. These are executed inside the
 * caller's transaction; the lock is held until commit or rollback.
 */
export const PAYOUT_LOCK_QUERIES = {
  /**
   * Lock a payout intent row for update. Concurrent callers block until the
   * holding transaction commits, then re-read the latest committed state.
   */
  lockPayoutIntentForUpdate: `
    SELECT id, status, amount_minor_units, currency, provider_reference
    FROM payout_intents
    WHERE id = $1
    FOR UPDATE
  `,
  /**
   * Lock by idempotency key so a racing duplicate request waits for the
   * in-flight insert/transition instead of creating a second payout.
   */
  lockPayoutIntentByIdempotencyKeyForUpdate: `
    SELECT id, status, amount_minor_units, currency, provider_reference
    FROM payout_intents
    WHERE idempotency_key = $1
    FOR UPDATE
  `,
  /**
   * Lock a retry job row so only one worker processes a given retry at a time.
   */
  lockRetryJobForUpdate: `
    SELECT id, payout_id, attempt_number, status
    FROM payout_retry_jobs
    WHERE id = $1
    FOR UPDATE
  `,
} as const;
