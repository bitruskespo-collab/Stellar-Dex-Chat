import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockEnv = {
  ADMIN_SECRET: 'test-admin-secret',
  PAYOUT_PROVIDER: 'fake',
};
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: vi.fn(() => null),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

import { createWalletSessionToken } from '@/lib/payout/auth';
import {
  setTransferStatus,
  getTransferStatus,
  transferStore,
} from '@/lib/transferStore';

import {
  GET as getDynamicStatus,
  POST as cancelDynamicStatus,
} from './[reference]/route';
import { POST as postCheckStatus } from './route';

const USER_A_WALLET =
  'GA_USER_A_WALLET_ADDRESS_111111111111111111111111111111111';
const USER_B_WALLET =
  'GB_USER_B_WALLET_ADDRESS_222222222222222222222222222222222';

describe('Cross-User IDOR Security Enforcement (Issue #41)', () => {
  let userASession: string;
  let userBSession: string;
  const testRef = 'tx_payout_user_a_secret_123';

  beforeEach(async () => {
    vi.clearAllMocks();
    transferStore.clear();

    userASession = createWalletSessionToken(USER_A_WALLET).sessionToken;
    userBSession = createWalletSessionToken(USER_B_WALLET).sessionToken;

    const { fakePayoutProvider } =
      await import('@/lib/payout/providers/fakeProvider');
    fakePayoutProvider.reset();
    await fakePayoutProvider.initiateTransfer({
      source: 'balance',
      amount: '500.00',
      recipient: 'RCP_user_a',
      reference: testRef,
      currency: 'NGN',
    });

    // Seed a private transfer owned by User A
    setTransferStatus({
      reference: testRef,
      status: 'pending',
      amount: 50000,
      amountMinor: 5000000n,
      currency: 'NGN',
      updatedAt: new Date().toISOString(),
      ownerWallet: USER_A_WALLET,
      clientSessionId: 'client-session-user-a',
      providerReference: 'PROV_SECRET_PAYOUT_REF_999',
    });
  });

  describe('GET /api/transfer-status/[reference]', () => {
    it('returns 401 when request is unauthenticated', async () => {
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${testRef}`, {
          method: 'GET',
        }),
      );

      const res = await getDynamicStatus(req, {
        params: Promise.resolve({ reference: testRef }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.data).toBeUndefined();
    });

    it('returns non-enumerating 404 when User B attempts to access User A transfer (IDOR)', async () => {
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${testRef}`, {
          method: 'GET',
          headers: {
            'x-wallet-session': userBSession,
          },
        }),
      );

      const res = await getDynamicStatus(req, {
        params: Promise.resolve({ reference: testRef }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toBe('Transfer not found');
      // Assert no private payout data is leaked
      expect(body.data).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('PROV_SECRET');
      expect(JSON.stringify(body)).not.toContain('50000');
    });

    it('returns the exact same 404 for a non-existent reference (non-enumerating)', async () => {
      const nonExistentRef = 'tx_does_not_exist_404';
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${nonExistentRef}`, {
          method: 'GET',
          headers: {
            'x-wallet-session': userBSession,
          },
        }),
      );

      const res = await getDynamicStatus(req, {
        params: Promise.resolve({ reference: nonExistentRef }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toBe('Transfer not found');
    });

    it('returns 200 with transfer data when legitimate owner User A requests it', async () => {
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${testRef}`, {
          method: 'GET',
          headers: {
            'x-wallet-session': userASession,
          },
        }),
      );

      const res = await getDynamicStatus(req, {
        params: Promise.resolve({ reference: testRef }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.reference).toBe(testRef);
      expect(body.data.ownerWallet).toBe(USER_A_WALLET);
    });

    it('returns 200 when authorized operator requests it via x-admin-token', async () => {
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${testRef}`, {
          method: 'GET',
          headers: {
            'x-admin-token': 'test-admin-secret',
          },
        }),
      );

      const res = await getDynamicStatus(req, {
        params: Promise.resolve({ reference: testRef }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.reference).toBe(testRef);
    });
  });

  describe('POST /api/transfer-status/[reference] (cancellation)', () => {
    it('returns non-enumerating 404 when User B tries to cancel User A transfer', async () => {
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${testRef}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-wallet-session': userBSession,
          },
          body: JSON.stringify({}),
        }),
      );

      const res = await cancelDynamicStatus(req, {
        params: Promise.resolve({ reference: testRef }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toBe('Transfer not found');

      // Verify transfer status remained 'pending' and was not cancelled
      const transferInStore = getTransferStatus(testRef);
      expect(transferInStore?.status).toBe('pending');
    });

    it('allows User A to cancel their own transfer', async () => {
      const req = new NextRequest(
        new Request(`http://localhost/api/transfer-status/${testRef}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-wallet-session': userASession,
          },
          body: JSON.stringify({}),
        }),
      );

      const res = await cancelDynamicStatus(req, {
        params: Promise.resolve({ reference: testRef }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('cancelled');

      // Verify status updated in store
      const transferInStore = getTransferStatus(testRef);
      expect(transferInStore?.status).toBe('cancelled');
    });
  });

  describe('POST /api/transfer-status (status lookup by body)', () => {
    it('returns non-enumerating 404 when User B queries User A transfer', async () => {
      const req = new NextRequest(
        new Request('http://localhost/api/transfer-status', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-wallet-session': userBSession,
          },
          body: JSON.stringify({ reference: testRef }),
        }),
      );

      const res = await postCheckStatus(req);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.message).toBe('Transfer not found');
      expect(body.data).toBeUndefined();
    });

    it('allows User A to query their own transfer status', async () => {
      const req = new NextRequest(
        new Request('http://localhost/api/transfer-status', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-wallet-session': userASession,
          },
          body: JSON.stringify({ reference: testRef }),
        }),
      );

      const res = await postCheckStatus(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });
});
