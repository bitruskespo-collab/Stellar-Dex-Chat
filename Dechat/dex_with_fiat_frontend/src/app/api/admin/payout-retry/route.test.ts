import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';
import {
  ADMIN_MUTATION_MATRIX,
  findMatrixEntry,
} from '@/lib/admin/__tests__/adminMutationMatrix';

const mockRequireAdminAuth = vi.fn();

vi.mock('@/app/api/admin/_utils/requireAdminAuth', () => ({
  requireAdminAuth: (req: unknown) => mockRequireAdminAuth(req),
}));

const { GET, POST } = await import('./route');

const ROUTE = '/api/admin/payout-retry';

describe('/api/admin/payout-retry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payoutRetryQueue._resetForTest();
    mockRequireAdminAuth.mockReturnValue(null);
  });

  it('rejects unauthorized requests', async () => {
    mockRequireAdminAuth.mockReturnValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    );

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-retry'),
    );
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('lists dead-letter jobs for inspection', async () => {
    const job = payoutRetryQueue.enqueueJob({
      payoutId: 'PO-DL',
      idempotencyKey: 'idem-dl-1',
      payload: { source: 'balance', amount: 500, recipient: 'RCP-DL' },
    });
    // Mark as dead letter
    job.status = 'dead_letter';

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-retry?status=dead_letter'),
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.jobs[0].idempotencyKey).toBe('idem-dl-1');
  });

  it('allows safe operator replay of dead-letter jobs', async () => {
    const job = payoutRetryQueue.enqueueJob({
      payoutId: 'PO-DL-2',
      idempotencyKey: 'idem-dl-2',
      payload: { source: 'balance', amount: 1500, recipient: 'RCP-DL-2' },
    });
    job.status = 'dead_letter';

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, action: 'replay' }),
      }),
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job.status).toBe('pending');
    expect(data.job.idempotencyKey).toBe('idem-dl-2');
  });

  it('returns 400 for non-replay action or missing jobId', async () => {
    const badReq = new NextRequest(
      new Request('http://localhost/api/admin/payout-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unknown' }),
      }),
    );

    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });

  describe('authorization matrix (handler-level)', () => {
    const entry = findMatrixEntry(ROUTE, 'POST');

    const buildReplayRequest = () =>
      new NextRequest(
        new Request('http://localhost/api/admin/payout-retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: 'job-synthetic-1', action: 'replay' }),
        }),
      );

    const seedDeadLetterJob = () => {
      const job = payoutRetryQueue.enqueueJob({
        payoutId: 'PO-MATRIX',
        idempotencyKey: 'idem-matrix-1',
        payload: { source: 'balance', amount: 1000, recipient: 'RCP-MATRIX' },
      });
      job.status = 'dead_letter';
      return job;
    };

    it('is represented in the admin mutation matrix', () => {
      expect(entry).toBeDefined();
      expect(entry?.requiresAuth).toBe(true);
      expect(entry?.requiresAdminRole).toBe(true);
    });

    it('denies unauthenticated requests with 401', async () => {
      mockRequireAdminAuth.mockReturnValue(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
      );

      const res = await POST(buildReplayRequest());
      expect(res.status).toBe(401);
    });

    it('denies authenticated non-admin roles with 403', async () => {
      mockRequireAdminAuth.mockReturnValue(
        new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
      );

      const res = await POST(buildReplayRequest());
      expect(res.status).toBe(403);
    });

    it('denies requests with an invalid wallet signature with 401', async () => {
      mockRequireAdminAuth.mockReturnValue(
        new Response(JSON.stringify({ error: 'Invalid signature' }), {
          status: 401,
        }),
      );

      const res = await POST(buildReplayRequest());
      expect(res.status).toBe(401);
    });

    it('allows an authorized admin to replay a dead-letter job', async () => {
      mockRequireAdminAuth.mockReturnValue(null);
      const job = seedDeadLetterJob();

      const req = new NextRequest(
        new Request('http://localhost/api/admin/payout-retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jobId: job.id, action: 'replay' }),
        }),
      );

      const res = await POST(req);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.job.status).toBe('pending');
    });
  });
});
