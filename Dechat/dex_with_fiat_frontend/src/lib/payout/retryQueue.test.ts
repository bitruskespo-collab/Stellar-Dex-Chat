import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PayoutRetryQueue, calculateNextBackoff } from './retryQueue';
import { PayoutAuditLedger } from './auditLedger';
import { PayoutProvider } from './providers/types';

describe('PayoutRetryQueue', () => {
  let tempDir: string;
  let auditLedger: PayoutAuditLedger;
  let retryQueue: PayoutRetryQueue;

  const mockProvider: PayoutProvider = {
    name: 'paystack',
    verifyAccount: vi.fn(),
    createRecipient: vi.fn(),
    initiateTransfer: vi.fn(),
    checkTransferStatus: vi.fn(),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-queue-test-'));
    auditLedger = new PayoutAuditLedger(tempDir);
    retryQueue = new PayoutRetryQueue(
      tempDir,
      { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 3, jitterFactor: 0.1 },
      auditLedger,
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('calculates bounded exponential backoff with jitter', () => {
    const b0 = calculateNextBackoff(
      0,
      { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5, jitterFactor: 0.2 },
      () => 0.5,
    );
    const b1 = calculateNextBackoff(
      1,
      { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5, jitterFactor: 0.2 },
      () => 0.5,
    );
    const b5 = calculateNextBackoff(
      5,
      { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 5, jitterFactor: 0.2 },
      () => 0.5,
    );

    // attempt 0: 100 * 2^0 = 100; jitter = 100 * 0.2 * 0.5 = 10 -> 110
    expect(b0).toBe(110);
    // attempt 1: 100 * 2^1 = 200; jitter = 200 * 0.2 * 0.5 = 20 -> 220
    expect(b1).toBe(220);
    // attempt 5: capped at maxDelayMs 1000
    expect(b5).toBe(1000);
  });

  it('recovers from transient provider failures and succeeds', async () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-TRANSIENT',
      idempotencyKey: 'idem-transient-key',
      payload: { source: 'balance', amount: 5000, recipient: 'RCP-1' },
      initialDelayMs: 0,
    });

    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);

    // 1st run: provider fails with 503
    vi.mocked(mockProvider.initiateTransfer).mockRejectedValueOnce(
      new Error('503 Service Unavailable'),
    );
    const res1 = await retryQueue.processDueJobs(
      mockProvider,
      Date.now() + 1000,
    );
    expect(res1.failed).toBe(1);
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('pending');

    // 2nd run: provider succeeds
    vi.mocked(mockProvider.initiateTransfer).mockResolvedValueOnce({
      reference: 'idem-transient-key',
    });
    const res2 = await retryQueue.processDueJobs(
      mockProvider,
      Date.now() + 10000,
    );
    expect(res2.succeeded).toBe(1);
    expect(job.status).toBe('completed');

    // Ensure retries strictly reused the original idempotency key
    expect(mockProvider.initiateTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: 'idem-transient-key' }),
    );
  });

  it('moves exhausted jobs to inspectable dead-letter state after max attempts', async () => {
    retryQueue.enqueueJob({
      payoutId: 'PO-EXHAUST',
      idempotencyKey: 'idem-exhaust-key',
      payload: { source: 'balance', amount: 10000, recipient: 'RCP-2' },
      initialDelayMs: 0,
    });

    vi.mocked(mockProvider.initiateTransfer).mockRejectedValue(
      new Error('Fatal 500 Provider Crash'),
    );

    // Attempt 1
    await retryQueue.processDueJobs(mockProvider, Date.now() + 1000);
    // Attempt 2
    await retryQueue.processDueJobs(mockProvider, Date.now() + 10000);
    // Attempt 3 (maxAttempts = 3)
    await retryQueue.processDueJobs(mockProvider, Date.now() + 100000);

    const deadLetters = retryQueue.getDeadLetterJobs();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].idempotencyKey).toBe('idem-exhaust-key');
    expect(deadLetters[0].status).toBe('dead_letter');
    expect(deadLetters[0].attempts).toBe(3);

    // Verified in audit ledger
    const auditEntries = auditLedger.getEntries({
      payoutId: 'PO-EXHAUST',
    }).entries;
    expect(auditEntries.some((e) => e.action === 'dead_letter_moved')).toBe(
      true,
    );
  });

  it('persists queue state across simulated process restarts', async () => {
    retryQueue.enqueueJob({
      payoutId: 'PO-RESTART',
      idempotencyKey: 'idem-restart-key',
      payload: { source: 'balance', amount: 2000, recipient: 'RCP-3' },
    });

    // Simulate process restart
    const restartedQueue = new PayoutRetryQueue(
      tempDir,
      { baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 3 },
      auditLedger,
    );

    const jobs = restartedQueue.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotencyKey).toBe('idem-restart-key');
    expect(jobs[0].status).toBe('pending');
  });

  it('allows safe operator replay of dead-letter jobs reusing the original idempotency key', async () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-OPERATOR',
      idempotencyKey: 'idem-operator-key',
      payload: { source: 'balance', amount: 3500, recipient: 'RCP-4' },
      initialDelayMs: 0,
    });

    // Force to dead letter
    vi.mocked(mockProvider.initiateTransfer).mockRejectedValue(
      new Error('API key expired'),
    );
    await retryQueue.processDueJobs(mockProvider, Date.now() + 1000);
    await retryQueue.processDueJobs(mockProvider, Date.now() + 10000);
    await retryQueue.processDueJobs(mockProvider, Date.now() + 100000);
    expect(job.status).toBe('dead_letter');

    // Operator manually corrects the issue (e.g. rotates provider key) and replays
    const replayedJob = retryQueue.replayDeadLetterJob(
      job.id,
      'operator:admin_user',
      'Provider API key rotated; original transfer never reached the provider',
    );
    expect(replayedJob.status).toBe('pending');
    expect(replayedJob.attempts).toBe(0);
    expect(replayedJob.idempotencyKey).toBe('idem-operator-key');

    // Next processing run succeeds using original idempotency key
    vi.mocked(mockProvider.initiateTransfer).mockResolvedValueOnce({
      reference: 'idem-operator-key',
    });
    const result = await retryQueue.processDueJobs(mockProvider, Date.now());
    expect(result.succeeded).toBe(1);
    expect(replayedJob.status).toBe('completed');

    expect(mockProvider.initiateTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({ reference: 'idem-operator-key' }),
    );

    // Operator intervention recorded in audit ledger
    const auditEntries = auditLedger.getEntries({
      payoutId: 'PO-OPERATOR',
    }).entries;
    const replayedEntry = auditEntries.find(
      (e) => e.action === 'dead_letter_replayed',
    );
    expect(replayedEntry).toBeDefined();
    expect(replayedEntry?.actor).toBe('operator:admin_user');
    // Audit records the required reason and the resulting provider state
    expect(replayedEntry?.metadata.reason).toBe(
      'Provider API key rotated; original transfer never reached the provider',
    );
    expect(replayedEntry?.metadata.originalIdempotencyKey).toBe(
      'idem-operator-key',
    );
    expect(replayedEntry?.metadata.resultingStatus).toBe('pending');
  });

  it('previews affected records for a dead-letter replay without mutating state', () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-PREVIEW',
      idempotencyKey: 'idem-preview-key',
      payload: { source: 'balance', amount: 4200, recipient: 'RCP-PREVIEW' },
      initialDelayMs: 0,
    });
    job.status = 'dead_letter';

    const preview = retryQueue.previewDeadLetterReplay(job.id);
    expect(preview.eligible).toBe(true);
    expect(preview.jobId).toBe(job.id);
    expect(preview.idempotencyKey).toBe('idem-preview-key');
    expect(preview.payoutId).toBe('PO-PREVIEW');
    expect(preview.affectedRecords).toHaveLength(3);
    expect(preview.affectedRecords.map((r) => r.kind)).toEqual([
      'retry_job',
      'payout_intent',
      'idempotency_record',
    ]);
    // Preview must not mutate the job
    expect(job.status).toBe('dead_letter');
    expect(job.attempts).toBe(0);
  });

  it('marks non-dead-letter jobs as ineligible in the preview', () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-PENDING',
      idempotencyKey: 'idem-pending-key',
      payload: { source: 'balance', amount: 100, recipient: 'RCP-PENDING' },
      initialDelayMs: 0,
    });
    // job is still pending, not dead_letter

    const preview = retryQueue.previewDeadLetterReplay(job.id);
    expect(preview.eligible).toBe(false);
    expect(preview.ineligibleReason).toMatch(/Only dead-letter jobs/);
  });

  it('throws when previewing an unknown job', () => {
    expect(() => retryQueue.previewDeadLetterReplay('missing-id')).toThrow(
      /Retry job not found/,
    );
  });

  it('requires a non-empty reason to replay a dead-letter job', async () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-REASON',
      idempotencyKey: 'idem-reason-key',
      payload: { source: 'balance', amount: 300, recipient: 'RCP-REASON' },
      initialDelayMs: 0,
    });
    job.status = 'dead_letter';

    expect(() => retryQueue.replayDeadLetterJob(job.id)).toThrow(
      /A non-empty reason is required/,
    );
    expect(() =>
      retryQueue.replayDeadLetterJob(job.id, 'operator:admin', '   '),
    ).toThrow(/A non-empty reason is required/);

    // Job must remain dead-letter when reason is missing
    expect(job.status).toBe('dead_letter');
    expect(
      auditLedger
        .getEntries({ payoutId: 'PO-REASON' })
        .entries.some((e) => e.action === 'dead_letter_replayed'),
    ).toBe(false);
  });

  it('refuses to replay a job that is not dead-letter, keeping the action idempotent', () => {
    const job = retryQueue.enqueueJob({
      payoutId: 'PO-IDEMPOTENT',
      idempotencyKey: 'idem-idempotent-key',
      payload: { source: 'balance', amount: 800, recipient: 'RCP-IDEMPOTENT' },
      initialDelayMs: 0,
    });
    job.status = 'pending';

    expect(() =>
      retryQueue.replayDeadLetterJob(job.id, 'operator:admin', 'retry'),
    ).toThrow(/Only dead-letter jobs can be replayed/);
    expect(job.status).toBe('pending');
  });
});
