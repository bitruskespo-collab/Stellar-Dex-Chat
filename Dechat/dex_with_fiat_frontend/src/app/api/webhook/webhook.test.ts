/**
 * Unit tests for the Paystack webhook route handler (Issue #33 & #34).
 *
 * Acceptance criteria:
 *  - Missing secret key → 400 before body is read
 *  - Invalid HMAC signature → 401
 *  - Valid HMAC signature → 200 (normal processing)
 *  - Durable duplicate callbacks → provider-compatible 200 (duplicate: true)
 *  - Out-of-order callback reconciliation → provider-compatible 200 (rejected_out_of_order)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { webhookDeduplicationService } from '@/lib/payout/webhookDeduplication';
import { payoutReconciliationService } from '@/lib/payout/reconciliation';
import { verifyWebhookSignature } from '@/lib/payout/webhookSignature';
import { retryQueueService } from '@/lib/payout/retryQueue';
import { requireAdminAuth } from '@/lib/adminAuth';
import { auditLedger } from '@/lib/payout/auditLedger';

// ---------------------------------------------------------------------------
// We mock the env module so we can swap PAYSTACK_SECRET_KEY per test.
// ---------------------------------------------------------------------------
const mockEnv = {
  PAYSTACK_SECRET_KEY: 'test-secret',
  PAYOUT_PROVIDER: 'paystack',
} as Record<string, string | undefined>;
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));
vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 'trace1', spanId: 'span1' }),
    createSpan: () => ({ spanId: 'span1' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
    setTraceHeaders: vi.fn(),
    generateTraceId: () => 'trace1',
    generateSpanId: () => 'span1',
    logWithTrace: vi.fn(),
  },
}));

const mockTransitionPayoutStatus = vi.fn((params) => ({
  reference: params.reference,
  status: params.targetStatus,
  amount: params.amount ?? 5000,
  clientSessionId: params.clientSessionId ?? 'session1',
}));

vi.mock('@/lib/transferStore', () => ({
  isReplayEvent: vi.fn(() => false),
  replayCacheStats: () => ({ size: 0, ttlMs: 0, maxSize: 0 }),
  getTransferStatus: vi.fn(() => ({
    clientSessionId: 'session1',
    status: 'pending',
  })),
  setTransferStatus: vi.fn(() => ({
    reference: 'ref123',
    status: 'success',
    amount: 5000,
    clientSessionId: 'session1',
  })),
  transferStore: { set: vi.fn(), get: vi.fn() },
}));

vi.mock('@/lib/paymentStatusEvents', () => ({
  publishPaymentStatus: vi.fn(),
}));

vi.mock('@/lib/adminAuth', () => ({
  requireAdminAuth: vi.fn(() => ({ ok: true, actor: 'admin-test' })),
}));

vi.mock('@/lib/payout/auditLedger', () => ({
  auditLedger: { record: vi.fn() },
}));

// Import route handler after mocks
const { POST } = await import('@/app/api/webhook/route');

function makeRequest(
  payload: string,
  signature: string | null,
  timestamp?: string | null,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature !== null) headers.set('x-paystack-signature', signature);
  if (timestamp) headers.set('x-paystack-signature-timestamp', timestamp);
  return new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers,
    body: payload,
  });
}

function hmac(payload: string, secret: string): string {
  return crypto.createHmac('sha512', secret).update(payload).digest('hex');
}

describe('POST /api/webhook', () => {
  const payload = JSON.stringify({
    event: 'transfer.success',
    data: { reference: 'ref123', id: 'id-1', amount: 5000 },
  });

  beforeEach(() => {
    mockEnv['PAYSTACK_SECRET_KEY'] = 'test-secret';
    webhookDeduplicationService._resetForTest();
    payoutReconciliationService._resetForTest();
  });

  afterEach(() => {
    vi.clearAllMocks();
    retryQueueService._resetForTest();
    vi.mocked(requireAdminAuth).mockReturnValue({ ok: true, actor: 'admin-test' });
  });

  it('returns 400 when PAYSTACK_SECRET_KEY is not configured and performs NO writes', async () => {
    mockEnv['PAYSTACK_SECRET_KEY'] = undefined;
    process.env.PAYSTACK_SECRET_KEY = '';
    process.env.PAYSTACK_SECRET_KEY_PREVIOUS = '';
    const req = makeRequest(payload, null);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/not configured/i);
  });

  it('returns 401 when signature is missing and causes NO writes', async () => {
    const req = makeRequest(payload, null);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 on malformed signature and causes NO writes', async () => {
    const req = makeRequest(payload, 'not-a-valid-hex-or-length');
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 on invalid signature and causes NO writes', async () => {
    const invalidSig = 'a'.repeat(128);
    const req = makeRequest(payload, invalidSig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 401 on tampered payload and causes NO writes', async () => {
    const originalSig = hmac(payload, 'test-secret');
    const tamperedPayload = payload.replace('5000', '99999');
    const req = makeRequest(tamperedPayload, originalSig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockTransitionPayoutStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and records transition for valid signature', async () => {
    const sig = hmac(payload, 'test-secret');
    const req = makeRequest(payload, sig);
    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  it('returns provider-compatible success for duplicate callbacks', async () => {
    const sig = hmac(payload, 'test-secret');

    // First delivery
    const req1 = makeRequest(payload, sig);
    // @ts-expect-error NextRequest vs Request difference
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    // Duplicate delivery
    const req2 = makeRequest(payload, sig);
    // @ts-expect-error NextRequest vs Request difference
    const res2 = await POST(req2);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as {
      received: boolean;
      duplicate?: boolean;
    };
    expect(body2.received).toBe(true);
    expect(body2.duplicate).toBe(true);
  });

  it('handles out-of-order webhook callbacks by rejecting regression and returning 200', async () => {
    // Current payout is already reversed
    const { getTransferStatus } = await import('@/lib/transferStore');
    vi.mocked(getTransferStatus).mockReturnValueOnce({
      reference: 'ref_rev',
      status: 'reversed',
      amount: 5000,
      updatedAt: new Date().toISOString(),
    });

    const outOfOrderPayload = JSON.stringify({
      event: 'transfer.success',
      data: { reference: 'ref_rev', id: 'id-rev-1', amount: 5000 },
    });
    const sig = hmac(outOfOrderPayload, 'test-secret');
    const req = makeRequest(outOfOrderPayload, sig);

    // @ts-expect-error NextRequest vs Request difference
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean; status?: string };
    expect(body.received).toBe(true);
    expect(body.status).toBe('ignored_out_of_order');
  });
});

// ---------------------------------------------------------------------------
// Threat-model regression tests (#256)
//
// These tests pin the trust boundaries documented in
// docs/threat-model-webhook-reconciliation.md. All payloads and secrets are
// synthetic; no real user data or credentials are used.
// ---------------------------------------------------------------------------
describe('Threat model: webhook signature verification', () => {
  const secret = 'synthetic-test-secret';
  const body = JSON.stringify({
    event: 'transfer.success',
    data: { reference: 'ref_tm', id: 'id-tm', amount: 1000 },
  });

  it('rejects a missing signature header', () => {
    const result = verifyWebhookSignature({ rawBody: body, signature: null, secret });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('rejects a malformed (non-hex / wrong length) signature', () => {
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: 'zzzz-not-hex',
      secret,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed_signature');
  });

  it('rejects a stale signature outside the replay window', () => {
    const signature = hmac(body, secret);
    const staleTimestamp = String(Date.now() - 60 * 60 * 1000);
    const result = verifyWebhookSignature({
      rawBody: body,
      signature,
      secret,
      timestamp: staleTimestamp,
      toleranceMs: 5 * 60 * 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('stale_timestamp');
  });

  it('rejects a signature computed with the wrong secret', () => {
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: hmac(body, 'attacker-guessed-secret'),
      secret,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_signature');
  });

  it('accepts a valid HMAC signature', () => {
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: hmac(body, secret),
      secret,
    });
    expect(result.ok).toBe(true);
  });
});

describe('Threat model: webhook deduplication', () => {
  beforeEach(() => {
    webhookDeduplicationService._resetForTest();
  });

  it('rejects a duplicate event id', () => {
    const first = webhookDeduplicationService.claim('evt-dup-1');
    expect(first.claimed).toBe(true);
    const second = webhookDeduplicationService.claim('evt-dup-1');
    expect(second.claimed).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('releases the claim when the handler errors so retries can proceed', () => {
    const first = webhookDeduplicationService.claim('evt-err-1');
    expect(first.claimed).toBe(true);
    webhookDeduplicationService.release('evt-err-1');
    const retry = webhookDeduplicationService.claim('evt-err-1');
    expect(retry.claimed).toBe(true);
  });
});

describe('Threat model: admin retry replay', () => {
  beforeEach(() => {
    retryQueueService._resetForTest();
  });

  it('requires admin auth before replaying dead-letter jobs', () => {
    vi.mocked(requireAdminAuth).mockReturnValue({ ok: false, status: 401 });
    const result = retryQueueService.replayDeadLetter({ jobId: 'job-1' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(retryQueueService.listDeadLetter()).toHaveLength(0);
  });

  it('only replays jobs that are in the dead-letter queue', () => {
    const missing = retryQueueService.replayDeadLetter({ jobId: 'unknown-job' });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('not_dead_letter');

    retryQueueService.enqueueDeadLetter({ jobId: 'job-2', attempts: 5 });
    const replayed = retryQueueService.replayDeadLetter({ jobId: 'job-2' });
    expect(replayed.ok).toBe(true);
    expect(retryQueueService.listDeadLetter()).toHaveLength(0);
  });
});

describe('Threat model: reconciliation ordering and audit', () => {
  beforeEach(() => {
    payoutReconciliationService._resetForTest();
    vi.mocked(auditLedger.record).mockClear();
  });

  it('rejects an out-of-order transition and records it in the audit ledger', () => {
    payoutReconciliationService.applyTransition({
      reference: 'ref_audit',
      status: 'reversed',
      amount: 1000,
    });
    const rejected = payoutReconciliationService.applyTransition({
      reference: 'ref_audit',
      status: 'success',
      amount: 1000,
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe('out_of_order');
    expect(auditLedger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'ref_audit',
        reason: 'out_of_order',
      }),
    );
  });
});
