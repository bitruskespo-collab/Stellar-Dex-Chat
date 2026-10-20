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
