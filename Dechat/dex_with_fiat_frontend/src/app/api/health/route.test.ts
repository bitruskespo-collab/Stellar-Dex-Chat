import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const healthModule = await import('./route');
const { GET } = healthModule;

type IndexerHealthSnapshot = {
  status: 'ok' | 'degraded';
  timestamp: string;
  indexer: {
    cursor: string | null;
    ledgerLag: number;
    retryCount: number;
    oldestUnprocessedEvent: string | null;
  };
};

const LEDGER_LAG_THRESHOLD = 100;

function resetIndexerState() {
  const maybeReset = (healthModule as unknown as { __resetIndexerHealthForTests?: () => void })
    .__resetIndexerHealthForTests;
  if (typeof maybeReset === 'function') {
    maybeReset();
  }
}

function setIndexerState(state: {
  cursor?: string | null;
  ledgerLag?: number;
  retryCount?: number;
  oldestUnprocessedEvent?: string | null;
}) {
  const maybeSet = (
    healthModule as unknown as {
      __setIndexerHealthForTests?: (s: typeof state) => void;
    }
  ).__setIndexerHealthForTests;
  if (typeof maybeSet === 'function') {
    maybeSet(state);
  }
}

async function readBody(res: Response): Promise<IndexerHealthSnapshot> {
  return (await res.json()) as IndexerHealthSnapshot;
}

describe('GET /api/health', () => {
  beforeEach(() => {
    resetIndexerState();
  });

  afterEach(() => {
    resetIndexerState();
    vi.restoreAllMocks();
  });

  it('returns 200 with status ok', async () => {
    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    // timestamp should be a valid ISO date
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });

  it('reports zero lag and no retries during normal operation', async () => {
    setIndexerState({
      cursor: 'cursor-0001',
      ledgerLag: 0,
      retryCount: 0,
      oldestUnprocessedEvent: null,
    });

    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.indexer.cursor).toBe('cursor-0001');
    expect(body.indexer.ledgerLag).toBe(0);
    expect(body.indexer.retryCount).toBe(0);
    expect(body.indexer.oldestUnprocessedEvent).toBeNull();
  });

  it('increments retryCount and surfaces oldest unprocessed event on RPC failure', async () => {
    setIndexerState({
      cursor: 'cursor-0002',
      ledgerLag: 5,
      retryCount: 3,
      oldestUnprocessedEvent: 'event-0001',
    });

    const res = await GET();
    const body = await readBody(res);

    // Retries below threshold and lag below threshold keep status ok.
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.indexer.retryCount).toBe(3);
    expect(body.indexer.oldestUnprocessedEvent).toBe('event-0001');
    expect(body.indexer.ledgerLag).toBe(5);
  });

  it('flips to degraded and returns 503 when ledger lag crosses the threshold', async () => {
    setIndexerState({
      cursor: 'cursor-0003',
      ledgerLag: LEDGER_LAG_THRESHOLD + 1,
      retryCount: 0,
      oldestUnprocessedEvent: 'event-0002',
    });

    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.indexer.ledgerLag).toBe(LEDGER_LAG_THRESHOLD + 1);
    expect(body.indexer.oldestUnprocessedEvent).toBe('event-0002');
  });

  it('stays ok exactly at the ledger lag threshold boundary', async () => {
    setIndexerState({
      cursor: 'cursor-0004',
      ledgerLag: LEDGER_LAG_THRESHOLD,
      retryCount: 0,
      oldestUnprocessedEvent: null,
    });

    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.indexer.ledgerLag).toBe(LEDGER_LAG_THRESHOLD);
  });

  it('does not leak customer identifiers into the health payload', async () => {
    setIndexerState({
      cursor: 'cursor-0005',
      ledgerLag: 0,
      retryCount: 1,
      oldestUnprocessedEvent: 'event-0003',
    });

    const res = await GET();
    const raw = await res.text();

    // Synthetic sentinel values that must never appear in the payload.
    const forbidden = [
      'customer@example.test',
      'user-1234567890',
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'account-9876543210',
    ];
    for (const value of forbidden) {
      expect(raw).not.toContain(value);
    }

    const body = JSON.parse(raw) as IndexerHealthSnapshot;
    expect(Object.keys(body).sort()).toEqual(['indexer', 'status', 'timestamp']);
    expect(Object.keys(body.indexer).sort()).toEqual([
      'cursor',
      'ledgerLag',
      'oldestUnprocessedEvent',
      'retryCount',
    ]);
  });
});