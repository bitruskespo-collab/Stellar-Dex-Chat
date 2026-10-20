import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

import { POST, GET } from './route';
import { setTransferStatus, transferStore } from '@/lib/transferStore';
import { resetSagaStores, getPendingCompensationWork } from '@/lib/payout/cancellationSaga';
import { getSharedRateLimitStore } from '@/lib/rateLimit';
import * as registry from '@/lib/payout/providers/registry';

describe('Route Contract: /api/transfer-status/[reference]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transferStore.clear();
    resetSagaStores();
    getSharedRateLimitStore().reset();
  });

  function makePostRequest(reference: string, body?: Record<string, unknown>) {
    return new NextRequest(
      new Request(`http://localhost/api/transfer-status/${reference}`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  function makeGetRequest(reference: string) {
    return new NextRequest(
      new Request(`http://localhost/api/transfer-status/${reference}`, {
        method: 'GET',
      }),
    );
  }

  describe('POST Cancellation Saga Branches', () => {
    it('returns 404 with typed error when payout does not exist', async () => {
      const req = makePostRequest('non-existent');
      const res = await POST(req, { params: Promise.resolve({ reference: 'non-existent' }) });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.version).toBe('v1');
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('TRANSFER_NOT_FOUND');
      expect(body.error.category).toBe('validation');
    });

    it('returns 403 with typed error when client session unauthorized', async () => {
      setTransferStatus({
        reference: 'ref-auth',
        status: 'pending',
        amount: 2000,
        updatedAt: new Date().toISOString(),
        clientSessionId: 'session-owner',
      });

      const req = makePostRequest('ref-auth', { clientSessionId: 'imposter-session' });
      const res = await POST(req, { params: Promise.resolve({ reference: 'ref-auth' }) });
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.version).toBe('v1');
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.category).toBe('authorization');
    });

    it('returns 409 with typed error when transfer has already settled (irreversible)', async () => {
      setTransferStatus({
        reference: 'ref-settled',
        status: 'success', // Already irreversibly settled
        amount: 5000,
        updatedAt: new Date().toISOString(),
      });

      const req = makePostRequest('ref-settled');
      const res = await POST(req, { params: Promise.resolve({ reference: 'ref-settled' }) });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.version).toBe('v1');
      expect(body.error.code).toBe('TRANSFER_SETTLED');
      expect(body.message).toMatch(/irreversible/i);
    });

    it('returns 409 when cancellation race is lost to provider settlement', async () => {
      setTransferStatus({
        reference: 'ref-race',
        status: 'pending',
        amount: 4000,
        updatedAt: new Date().toISOString(),
      });

      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue({
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockResolvedValue({
          status: 'settled',
          cancellable: false,
          message: 'Transfer settled at provider before cancellation',
        }),
      } as any);

      const req = makePostRequest('ref-race');
      const res = await POST(req, { params: Promise.resolve({ reference: 'ref-race' }) });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.version).toBe('v1');
      expect(body.error.code).toBe('TRANSFER_SETTLED');
      expect(body.error.category).toBe('provider');
    });

    it('returns 202 and schedules retryable compensation work on provider timeout', async () => {
      setTransferStatus({
        reference: 'ref-timeout',
        status: 'pending',
        amount: 4000,
        updatedAt: new Date().toISOString(),
      });

      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue({
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockRejectedValue(new Error('Provider request timed out')),
      } as any);

      const req = makePostRequest('ref-timeout');
      const res = await POST(req, { params: Promise.resolve({ reference: 'ref-timeout' }) });
      const body = await res.json();

      expect(res.status).toBe(202);
      expect(body.success).toBe(true);
      expect(body.data.outcome).toBe('compensated');
      expect(body.data.compensationWorkId).toBeDefined();

      // Confirms compensation work persisted
      expect(getPendingCompensationWork().length).toBe(1);
    });

    it('returns 200 when provider confirms cancellation', async () => {
      setTransferStatus({
        reference: 'ref-confirmed',
        status: 'pending',
        amount: 4000,
        updatedAt: new Date().toISOString(),
      });

      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue({
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockResolvedValue({
          status: 'confirmed',
          cancellable: true,
          message: 'Transfer cancelled at provider',
        }),
      } as any);

      const req = makePostRequest('ref-confirmed');
      const res = await POST(req, { params: Promise.resolve({ reference: 'ref-confirmed' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('cancelled');
    });
  });

  describe('GET Transfer Status & Saga Trace', () => {
    it('returns transfer status along with saga steps when available', async () => {
      setTransferStatus({
        reference: 'ref-get-test',
        status: 'cancelled',
        amount: 1500,
        updatedAt: new Date().toISOString(),
      });

      const req = makeGetRequest('ref-get-test');
      const res = await GET(req, { params: Promise.resolve({ reference: 'ref-get-test' }) });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.reference).toBe('ref-get-test');
      expect(body.data.status).toBe('cancelled');
      expect(res.headers.get('X-Correlation-Id')).toBeDefined();
    });
  });
});
