import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuditLogService, { retryWithBackoff } from './auditLog';

describe('auditLog retry helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a failed operation and succeeds with exponential backoff', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('storage fail'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(operation, { retries: 2, minDelayMs: 50, factor: 2 });

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('persists an audit entry to localStorage when recordAction is called', async () => {
    const entry = AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Test deposit',
      { amount: 42 },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'admin1',
      actionType: 'deposit',
      actionDescription: 'Test deposit',
      txHash: 'txhash',
      status: 'success',
    });
  });
});

describe('auditLog indexer reorg and backfill entries', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records an indexer reorg entry with the invalidated range and checkpoint', async () => {
    const entry = AuditLogService.recordAction(
      'indexer',
      'indexer_reorg',
      'Detected ledger fork; rebuilding projections',
      {
        fromLedger: 100,
        toLedger: 120,
        checkpointLedger: 99,
        checkpointHash: 'abc123',
        detectedAt: '2024-01-01T00:00:00.000Z',
      },
      undefined,
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'indexer',
      actionType: 'indexer_reorg',
      status: 'success',
    });
    expect(stored[0].details).toMatchObject({
      fromLedger: 100,
      toLedger: 120,
      checkpointLedger: 99,
      checkpointHash: 'abc123',
    });
  });

  it('records a backfill entry with persisted progress metadata', async () => {
    const entry = AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill job started',
      {
        jobId: 'job-1',
        fromLedger: 1,
        toLedger: 500,
        cursor: 250,
        status: 'running',
      },
      undefined,
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'indexer',
      actionType: 'indexer_backfill',
      status: 'success',
    });
    expect(stored[0].details).toMatchObject({
      jobId: 'job-1',
      fromLedger: 1,
      toLedger: 500,
      cursor: 250,
      status: 'running',
    });
  });

  it('preserves insertion ordering of reorg and backfill entries', async () => {
    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill started',
      { jobId: 'job-1', cursor: 0 },
      undefined,
      'success',
    );
    AuditLogService.recordAction(
      'indexer',
      'indexer_reorg',
      'Reorg detected',
      { fromLedger: 10, toLedger: 12 },
      undefined,
      'success',
    );
    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill resumed',
      { jobId: 'job-1', cursor: 12 },
      undefined,
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(3);
    expect(stored.map((e: { actionType: string }) => e.actionType)).toEqual([
      'indexer_backfill',
      'indexer_reorg',
      'indexer_backfill',
    ]);
    expect(stored.map((e: { actionDescription: string }) => e.actionDescription)).toEqual([
      'Backfill started',
      'Reorg detected',
      'Backfill resumed',
    ]);
  });

  it('does not mutate the details object passed to recordAction', async () => {
    const details = {
      jobId: 'job-immutable',
      fromLedger: 1,
      toLedger: 10,
      cursor: 5,
      status: 'running',
    };
    const snapshot = JSON.parse(JSON.stringify(details));

    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill started',
      details,
      undefined,
      'success',
    );

    await Promise.resolve();

    expect(details).toEqual(snapshot);

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored[0].details).toMatchObject(snapshot);
  });

  it('keeps previously stored entries immutable when new entries are appended', async () => {
    const first = AuditLogService.recordAction(
      'indexer',
      'indexer_reorg',
      'Reorg detected',
      { fromLedger: 10, toLedger: 12 },
      undefined,
      'success',
    );

    await Promise.resolve();

    const before = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    const firstSnapshot = JSON.parse(JSON.stringify(before[0]));

    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill started',
      { jobId: 'job-2', cursor: 12 },
      undefined,
      'success',
    );

    await Promise.resolve();

    const after = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(firstSnapshot);
    expect(after[0].id).toBe(first.id);
    expect(after[1].actionType).toBe('indexer_backfill');
  });
});