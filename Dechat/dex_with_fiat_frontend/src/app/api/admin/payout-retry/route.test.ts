import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';

const mockRequireAdminAuth = vi.fn();

vi.mock('@/app/api/admin/_utils/requireAdminAuth', () => ({
  requireAdminAuth: (req: unknown) => mockRequireAdminAuth(req),
}));

const { GET, POST } = await import('./route');

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
        body: JSON.stringify({
          jobId: job.id,
          action: 'replay',
          actor: 'operator:admin_user',
          reason: 'Provider key rotated; original transfer never landed',
        }),
      }),
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.job.status).toBe('pending');
    expect(data.job.idempotencyKey).toBe('idem-dl-2');
  });

  it('previews affected records without mutating the job', async () => {
    const job = payoutRetryQueue.enqueueJob({
      payoutId: 'PO-PREVIEW',
      idempotencyKey: 'idem-preview',
      payload: { source: 'balance', amount: 999, recipient: 'RCP-PREVIEW' },
    });
    job.status = 'dead_letter';

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, action: 'preview' }),
      }),
    );

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.preview.eligible).toBe(true);
    expect(data.preview.idempotencyKey).toBe('idem-preview');
    expect(data.preview.affectedRecords).toHaveLength(3);
    // Preview is a dry run: job stays dead-letter
    expect(job.status).toBe('dead_letter');
  });

  it('rejects replay without a reason', async () => {
    const job = payoutRetryQueue.enqueueJob({
      payoutId: 'PO-NOREASON',
      idempotencyKey: 'idem-noreason',
      payload: { source: 'balance', amount: 100, recipient: 'RCP-NOREASON' },
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
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/reason/);
    // Job must remain dead-letter
    expect(job.status).toBe('dead_letter');
  });

  it('rejects replay of a job that is not dead-letter, keeping the action idempotent', async () => {
    const job = payoutRetryQueue.enqueueJob({
      payoutId: 'PO-NOTDL',
      idempotencyKey: 'idem-notdl',
      payload: { source: 'balance', amount: 100, recipient: 'RCP-NOTDL' },
    });
    job.status = 'pending';

    const req = new NextRequest(
      new Request('http://localhost/api/admin/payout-retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          action: 'replay',
          reason: 'duplicate click',
        }),
      }),
    );

    const res = await POST(req);
    expect(res.status).toBe(400);
    // State is unchanged: no second provider call is ever made
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
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
});
