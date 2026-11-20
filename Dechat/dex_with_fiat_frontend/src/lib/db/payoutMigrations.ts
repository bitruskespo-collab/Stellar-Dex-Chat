/**
 * Payout State Database Migration Definitions
 * Addresses Issue #97: Survive process restarts and coordinate payout operations
 * across application instances.
 * Addresses Issue #247: Persist idempotent database migrations with rollback
 * evidence (checksums, advisory locking, pre/post invariant checks).
 */

import { createHash } from 'crypto';

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

/**
 * Advisory lock key used to serialize payout migration execution across
 * application instances. Chosen as a stable 64-bit constant so every process
 * contends on the same lock.
 */
export const PAYOUT_MIGRATION_LOCK_KEY = 0x5041594f5554n; // "PAYOUT"

/** Maximum time (ms) to wait for the advisory lock before giving up. */
export const PAYOUT_MIGRATION_LOCK_TIMEOUT_MS = 30_000;

/** Interval (ms) between advisory lock acquisition attempts. */
export const PAYOUT_MIGRATION_LOCK_POLL_MS = 250;

/**
 * Minimal database surface required by the migration runner. Implementations
 * back this with the real driver (e.g. node-postgres) while tests can supply
 * an in-memory fake.
 */
export interface MigrationDatabase {
  /** Acquire a session-level advisory lock. Returns true when acquired. */
  tryAcquireAdvisoryLock(key: bigint): Promise<boolean>;
  /** Release a previously acquired advisory lock. */
  releaseAdvisoryLock(key: bigint): Promise<void>;
  /** Execute a statement that returns no rows. */
  execute(sql: string): Promise<void>;
  /** Execute a query returning rows. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Run the supplied callback inside a transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface MigrationEvidence {
  version: number;
  name: string;
  checksum: string;
  direction: 'up' | 'down';
  outcome: 'applied' | 'skipped' | 'rolled_back' | 'failed';
  recordedAt: string;
  detail?: string;
}

export interface InvariantViolation {
  name: string;
  detail: string;
}

export interface MigrationRunResult {
  applied: number[];
  skipped: number[];
  evidence: MigrationEvidence[];
}

export class MigrationChecksumMismatchError extends Error {
  constructor(
    public readonly version: number,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Migration ${version} checksum mismatch: stored ${expected}, computed ${actual}. ` +
        'Refusing to re-apply. See docs/payout-migrations.md for forward recovery.',
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

export class MigrationLockTimeoutError extends Error {
  constructor(public readonly key: bigint, public readonly timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs}ms waiting for payout migration advisory lock ${key}. ` +
        'Another instance is likely applying migrations; retry later.',
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

export class MigrationInvariantError extends Error {
  constructor(
    public readonly phase: 'pre' | 'post',
    public readonly violations: InvariantViolation[],
  ) {
    super(
      `Payout migration ${phase}-check failed: ` +
        violations.map((v) => `${v.name} (${v.detail})`).join('; '),
    );
    this.name = 'MigrationInvariantError';
  }
}

/** Deterministic SHA-256 checksum over the migration's identity and SQL. */
export function computeMigrationChecksum(step: MigrationStep): string {
  const hash = createHash('sha256');
  hash.update(`v${step.version}:${step.name}\n`);
  hash.update('-- up --\n');
  hash.update(step.upSql.trim());
  hash.update('\n-- down --\n');
  hash.update(step.downSql.trim());
  return hash.digest('hex');
}

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS payout_schema_migrations (
    version INTEGER PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payout_migration_evidence (
    id BIGSERIAL PRIMARY KEY,
    version INTEGER NOT NULL,
    name VARCHAR(128) NOT NULL,
    checksum CHAR(64) NOT NULL,
    direction VARCHAR(8) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    detail TEXT,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
`;

/**
 * Pre-apply invariants: the payout tables must be internally consistent before
 * we change their shape. When the tables do not yet exist (first run) these
 * checks trivially pass.
 */
export async function checkPreMigrationInvariants(
  db: MigrationDatabase,
): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('payout_intents', 'payout_state_transitions')`,
  );
  if (tables.length === 0) {
    return violations;
  }

  const negative = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payout_intents WHERE amount_minor_units < 0`,
  );
  if (Number(negative[0]?.count ?? '0') > 0) {
    violations.push({
      name: 'non_negative_amounts',
      detail: `${negative[0].count} payout intents have negative amounts`,
    });
  }

  const orphaned = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payout_state_transitions t
       LEFT JOIN payout_intents p ON p.id = t.payout_id
       WHERE p.id IS NULL`,
  );
  if (Number(orphaned[0]?.count ?? '0') > 0) {
    violations.push({
      name: 'no_orphaned_transitions',
      detail: `${orphaned[0].count} transitions reference missing payouts`,
    });
  }

  return violations;
}

/**
 * Post-apply invariants: after the schema change the payout tables must still
 * be consistent and every intent must have at least one recorded transition.
 */
export async function checkPostMigrationInvariants(
  db: MigrationDatabase,
): Promise<InvariantViolation[]> {
  const violations = await checkPreMigrationInvariants(db);

  const missingTransitions = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payout_intents p
       LEFT JOIN payout_state_transitions t ON t.payout_id = p.id
       WHERE t.id IS NULL`,
  );
  if (Number(missingTransitions[0]?.count ?? '0') > 0) {
    violations.push({
      name: 'every_intent_has_transition',
      detail: `${missingTransitions[0].count} payout intents lack a state transition`,
    });
  }

  return violations;
}

async function acquireLockWithTimeout(db: MigrationDatabase): Promise<void> {
  const deadline = Date.now() + PAYOUT_MIGRATION_LOCK_TIMEOUT_MS;
  for (;;) {
    if (await db.tryAcquireAdvisoryLock(PAYOUT_MIGRATION_LOCK_KEY)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new MigrationLockTimeoutError(
        PAYOUT_MIGRATION_LOCK_KEY,
        PAYOUT_MIGRATION_LOCK_TIMEOUT_MS,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, PAYOUT_MIGRATION_LOCK_POLL_MS));
  }
}

async function recordEvidence(
  db: MigrationDatabase,
  evidence: MigrationEvidence,
): Promise<void> {
  await db.execute(
    `INSERT INTO payout_migration_evidence
       (version, name, checksum, direction, outcome, detail)
     VALUES (${evidence.version}, '${evidence.name.replace(/'/g, "''")}',
       '${evidence.checksum}', '${evidence.direction}', '${evidence.outcome}',
       ${evidence.detail ? `'${evidence.detail.replace(/'/g, "''")}'` : 'NULL'})`,
  );
}

async function loadAppliedMigrations(
  db: MigrationDatabase,
): Promise<Map<number, MigrationRecord>> {
  const rows = await db.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: string;
  }>(`SELECT version, name, checksum, applied_at FROM payout_schema_migrations`);
  const map = new Map<number, MigrationRecord>();
  for (const row of rows) {
    map.set(Number(row.version), {
      version: Number(row.version),
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    });
  }
  return map;
}

/**
 * Apply all pending payout migrations idempotently.
 *
 * Guarantees:
 *  - Serialized across instances via a session advisory lock.
 *  - Each migration's SHA-256 checksum is stored; re-applying an already
 *    applied migration is a no-op when the checksum matches.
 *  - A checksum mismatch aborts before any SQL runs (forward recovery required).
 *  - Pre/post invariant checks run around every migration; a failure rolls the
 *    migration back and records evidence.
 */
export async function runPayoutMigrations(
  db: MigrationDatabase,
  migrations: MigrationStep[] = PAYOUT_MIGRATIONS,
): Promise<MigrationRunResult> {
  const result: MigrationRunResult = { applied: [], skipped: [], evidence: [] };

  await acquireLockWithTimeout(db);
  try {
    await db.execute(MIGRATION_TABLE_SQL);
    const applied = await loadAppliedMigrations(db);

    const ordered = [...migrations].sort((a, b) => a.version - b.version);

    // Validate checksums for already-applied migrations before touching schema.
    for (const step of ordered) {
      const existing = applied.get(step.version);
      if (!existing) continue;
      const checksum = computeMigrationChecksum(step);
      if (existing.checksum !== checksum) {
        throw new MigrationChecksumMismatchError(
          step.version,
          existing.checksum,
          checksum,
        );
      }
    }

    for (const step of ordered) {
      const checksum = computeMigrationChecksum(step);
      if (applied.has(step.version)) {
        result.skipped.push(step.version);
        const evidence: MigrationEvidence = {
          version: step.version,
          name: step.name,
          checksum,
          direction: 'up',
          outcome: 'skipped',
          recordedAt: new Date().toISOString(),
          detail: 'checksum matched stored record',
        };
        await recordEvidence(db, evidence);
        result.evidence.push(evidence);
        continue;
      }

      const preViolations = await checkPreMigrationInvariants(db);
      if (preViolations.length > 0) {
        const evidence: MigrationEvidence = {
          version: step.version,
          name: step.name,
          checksum,
          direction: 'up',
          outcome: 'failed',
          recordedAt: new Date().toISOString(),
          detail: `pre-check: ${preViolations.map((v) => v.name).join(',')}`,
        };
        await recordEvidence(db, evidence);
        result.evidence.push(evidence);
        throw new MigrationInvariantError('pre', preViolations);
      }

      try {
        await db.transaction(async () => {
          await db.execute(step.upSql);
          const postViolations = await checkPostMigrationInvariants(db);
          if (postViolations.length > 0) {
            throw new MigrationInvariantError('post', postViolations);
          }
          await db.execute(
            `INSERT INTO payout_schema_migrations (version, name, checksum)
             VALUES (${step.version}, '${step.name.replace(/'/g, "''")}', '${checksum}')`,
          );
        });
      } catch (err) {
        const detail =
          err instanceof MigrationInvariantError
            ? `post-check: ${err.violations.map((v) => v.name).join(',')}`
            : err instanceof Error
              ? err.message
              : String(err);
        const evidence: MigrationEvidence = {
          version: step.version,
          name: step.name,
          checksum,
          direction: 'up',
          outcome: 'rolled_back',
          recordedAt: new Date().toISOString(),
          detail,
        };
        await recordEvidence(db, evidence);
        result.evidence.push(evidence);
        throw err;
      }

      applied.set(step.version, {
        version: step.version,
        name: step.name,
        checksum,
        appliedAt: new Date().toISOString(),
      });
      result.applied.push(step.version);
      const evidence: MigrationEvidence = {
        version: step.version,
        name: step.name,
        checksum,
        direction: 'up',
        outcome: 'applied',
        recordedAt: new Date().toISOString(),
      };
      await recordEvidence(db, evidence);
      result.evidence.push(evidence);
    }

    return result;
  } finally {
    await db.releaseAdvisoryLock(PAYOUT_MIGRATION_LOCK_KEY);
  }
}

/**
 * Roll back the most recently applied payout migration, recording evidence.
 * Intended for documented forward recovery; not run automatically.
 */
export async function rollbackLastPayoutMigration(
  db: MigrationDatabase,
  migrations: MigrationStep[] = PAYOUT_MIGRATIONS,
): Promise<MigrationEvidence | null> {
  await acquireLockWithTimeout(db);
  try {
    await db.execute(MIGRATION_TABLE_SQL);
    const applied = await loadAppliedMigrations(db);
    if (applied.size === 0) return null;

    const lastVersion = Math.max(...applied.keys());
    const step = migrations.find((m) => m.version === lastVersion);
    if (!step) {
      throw new Error(`No migration definition found for applied version ${lastVersion}`);
    }
    const checksum = computeMigrationChecksum(step);

    await db.transaction(async () => {
      await db.execute(step.downSql);
      await db.execute(
        `DELETE FROM payout_schema_migrations WHERE version = ${step.version}`,
      );
    });

    const evidence: MigrationEvidence = {
      version: step.version,
      name: step.name,
      checksum,
      direction: 'down',
      outcome: 'applied',
      recordedAt: new Date().toISOString(),
    };
    await recordEvidence(db, evidence);
    return evidence;
  } finally {
    await db.releaseAdvisoryLock(PAYOUT_MIGRATION_LOCK_KEY);
  }
}
