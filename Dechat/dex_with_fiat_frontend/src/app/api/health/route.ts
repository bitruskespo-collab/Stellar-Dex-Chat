import { NextResponse } from 'next/server';

export const runtime = 'edge';

/**
 * Bounded indexer health snapshot.
 *
 * Only aggregate, non-identifying values are exposed here: ledger cursors,
 * lag, retry counts and the age of the oldest unprocessed event. Wallet
 * addresses, transaction hashes and any other customer identifiers must
 * never be added to this payload.
 */
export interface IndexerHealthSnapshot {
  cursorLedger: number | null;
  cursorEventIndex: number | null;
  ledgerLag: number | null;
  retryCount: number;
  oldestUnprocessedEventLedger: number | null;
  oldestUnprocessedEventAgeSeconds: number | null;
}

export type IndexerHealthStatus = 'ok' | 'degraded';

/** Ledger lag (in ledgers) above which the indexer is considered degraded. */
export const LEDGER_LAG_DEGRADED_THRESHOLD = 100;
/** Ledger lag (in ledgers) above which the indexer is considered critical. */
export const LEDGER_LAG_CRITICAL_THRESHOLD = 500;
/** Retry count above which the indexer is considered degraded. */
export const RETRY_COUNT_DEGRADED_THRESHOLD = 5;
/** Retry count above which the indexer is considered critical. */
export const RETRY_COUNT_CRITICAL_THRESHOLD = 20;
/** Age (seconds) of the oldest unprocessed event above which the indexer is degraded. */
export const OLDEST_EVENT_AGE_DEGRADED_THRESHOLD_SECONDS = 300;
/** Age (seconds) of the oldest unprocessed event above which the indexer is critical. */
export const OLDEST_EVENT_AGE_CRITICAL_THRESHOLD_SECONDS = 900;

const EMPTY_SNAPSHOT: IndexerHealthSnapshot = {
  cursorLedger: null,
  cursorEventIndex: null,
  ledgerLag: null,
  retryCount: 0,
  oldestUnprocessedEventLedger: null,
  oldestUnprocessedEventAgeSeconds: null,
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalizes an arbitrary health source into the bounded snapshot shape,
 * dropping any unexpected or identifying fields.
 */
export function normalizeIndexerHealth(
  source: Partial<IndexerHealthSnapshot> | null | undefined,
): IndexerHealthSnapshot {
  if (!source) {
    return { ...EMPTY_SNAPSHOT };
  }

  return {
    cursorLedger: toFiniteNumber(source.cursorLedger),
    cursorEventIndex: toFiniteNumber(source.cursorEventIndex),
    ledgerLag: toFiniteNumber(source.ledgerLag),
    retryCount: toFiniteNumber(source.retryCount) ?? 0,
    oldestUnprocessedEventLedger: toFiniteNumber(source.oldestUnprocessedEventLedger),
    oldestUnprocessedEventAgeSeconds: toFiniteNumber(source.oldestUnprocessedEventAgeSeconds),
  };
}

/**
 * Loads the current indexer health snapshot.
 *
 * The indexer publishes its snapshot to a shared health provider; when that
 * provider is unavailable we fall back to an empty snapshot so the health
 * route still responds with bounded data.
 */
export async function loadIndexerHealth(): Promise<IndexerHealthSnapshot> {
  try {
    const provider = (globalThis as { __indexerHealthProvider?: () => unknown })
      .__indexerHealthProvider;

    if (typeof provider !== 'function') {
      return { ...EMPTY_SNAPSHOT };
    }

    const snapshot = await provider();
    return normalizeIndexerHealth(snapshot as Partial<IndexerHealthSnapshot> | null);
  } catch {
    return { ...EMPTY_SNAPSHOT };
  }
}

/**
 * Classifies the snapshot against the alert thresholds.
 *
 * Returns 'degraded' when any metric crosses its degraded threshold and
 * whether the snapshot is critical (used to decide the HTTP status code).
 */
export function evaluateIndexerHealth(snapshot: IndexerHealthSnapshot): {
  status: IndexerHealthStatus;
  critical: boolean;
} {
  const ledgerLag = snapshot.ledgerLag ?? 0;
  const retryCount = snapshot.retryCount ?? 0;
  const oldestEventAge = snapshot.oldestUnprocessedEventAgeSeconds ?? 0;

  const critical =
    ledgerLag > LEDGER_LAG_CRITICAL_THRESHOLD ||
    retryCount > RETRY_COUNT_CRITICAL_THRESHOLD ||
    oldestEventAge > OLDEST_EVENT_AGE_CRITICAL_THRESHOLD_SECONDS;

  const degraded =
    critical ||
    ledgerLag > LEDGER_LAG_DEGRADED_THRESHOLD ||
    retryCount > RETRY_COUNT_DEGRADED_THRESHOLD ||
    oldestEventAge > OLDEST_EVENT_AGE_DEGRADED_THRESHOLD_SECONDS;

  return {
    status: degraded ? 'degraded' : 'ok',
    critical,
  };
}

export async function GET() {
  try {
    const indexer = await loadIndexerHealth();
    const { status, critical } = evaluateIndexerHealth(indexer);

    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        indexer,
      },
      { status: critical ? 503 : 200 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Health check failed',
      },
      { status: 503 },
    );
  }
}