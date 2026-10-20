import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { PayoutProvider, PayoutProviderError } from './types';
import { FakePayoutProvider } from './fakeProvider';

vi.mock('server-only', () => ({}));
const mockEnv = {
  PAYSTACK_SECRET_KEY: 'test-secret-key',
  PAYOUT_PROVIDER: 'paystack',
};
vi.mock('@/lib/serverEnv', () => ({
  get serverEnv() {
    return mockEnv;
  },
}));

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

import { paystackProvider } from './paystackProvider';

function runSharedContractSuite(
  name: string,
  getProvider: () => PayoutProvider,
  setupMocks?: () => void,
) {
  describe(`PayoutProvider Contract: ${name}`, () => {
    let provider: PayoutProvider;

    beforeEach(() => {
      vi.clearAllMocks();
      if (setupMocks) {
        setupMocks();
      }
      provider = getProvider();
    });

    it('has a valid provider name', () => {
      expect(['paystack', 'fake']).toContain(provider.name);
    });

    it('verifies bank accounts and returns normalized VerifiedAccount', async () => {
      const result = await provider.verifyAccount({
        accountNumber: '0123456789',
        bankCode: '058',
      });

      expect(result).toBeDefined();
      expect(result.accountNumber).toBe('0123456789');
      expect(result.accountName).toBeTruthy();
      expect(result.bankCode).toBe('058');
    });

    it('creates transfer recipients and returns normalized CreatedRecipient', async () => {
      const result = await provider.createRecipient({
        type: 'nuban',
        name: 'John Doe',
        account_number: '0123456789',
        bank_code: '058',
        currency: 'NGN',
      });

      expect(result).toBeDefined();
      expect(result.recipientCode).toMatch(/^RCP_/);
      expect(result.name).toBe('John Doe');
      expect(result.accountNumber).toBe('0123456789');
      expect(result.bankCode).toBe('058');
      expect(result.currency).toBe('NGN');
    });

    it('initiates transfers and returns normalized InitiatedTransfer with minor units', async () => {
      const result = await provider.initiateTransfer({
        source: 'balance',
        amount: '1500.50',
        recipient: 'RCP_test_123',
        reference: 'test_ref_001',
        currency: 'NGN',
      });

      expect(result).toBeDefined();
      expect(result.reference).toBe('test_ref_001');
      expect(result.status).toBe('pending');
      expect(result.amountMinor).toBe(150050n);
      expect(result.currency).toBe('NGN');
      expect(result.recipientCode).toBe('RCP_test_123');
    });

    it('checks transfer status and returns normalized TransferStatus', async () => {
      const ref = `status_check_${Date.now()}`;
      await provider.initiateTransfer({
        source: 'balance',
        amount: '2000.00',
        recipient: 'RCP_test_status',
        reference: ref,
      });

      const result = await provider.checkTransferStatus({
        reference: ref,
      });

      expect(result).toBeDefined();
      expect(result.reference).toBe(ref);
      expect([
        'pending',
        'success',
        'failed',
        'reversed',
        'cancelled',
      ]).toContain(result.status);
    });

    it('enforces idempotency on transfer initiation with identical reference', async () => {
      const ref = `idemp_ref_${Date.now()}`;
      const first = await provider.initiateTransfer({
        source: 'balance',
        amount: '1000.00',
        recipient: 'RCP_idemp',
        reference: ref,
      });

      const second = await provider.initiateTransfer({
        source: 'balance',
        amount: '1000.00',
        recipient: 'RCP_idemp',
        reference: ref,
      });

      expect(first.reference).toBe(second.reference);
      expect(first.amountMinor).toBe(second.amountMinor);
    });
  });
}

// 1. Run contract tests against Deterministic Fake Provider
const fake = new FakePayoutProvider();
runSharedContractSuite(
  'FakePayoutProvider',
  () => fake,
  () => fake.reset(),
);

// 2. Run contract tests against Paystack Provider with mock transport
runSharedContractSuite(
  'PaystackProvider',
  () => paystackProvider,
  () => {
    mockedAxios.isAxiosError.mockImplementation((err: unknown) => {
      return (
        typeof err === 'object' &&
        err !== null &&
        (err as Record<string, unknown>).isAxiosError === true
      );
    });

    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('/bank/resolve')) {
        return {
          data: {
            status: true,
            message: 'Account resolved',
            data: {
              account_number: '0123456789',
              account_name: 'John Doe',
              bank_id: 58,
            },
          },
        };
      }
      if (url.includes('/transfer/verify/')) {
        const ref = decodeURIComponent(url.split('/').pop() || 'test_ref');
        return {
          data: {
            status: true,
            data: {
              reference: ref,
              status: 'success',
              transfer_code: 'TRF_123',
              amount: 150050,
              currency: 'NGN',
            },
          },
        };
      }
      throw new Error(`Unexpected GET url: ${url}`);
    });

    mockedAxios.post.mockImplementation(async (url: string, body: unknown) => {
      if (url.includes('/transferrecipient')) {
        const b = body as Record<string, unknown>;
        return {
          data: {
            status: true,
            data: {
              recipient_code: 'RCP_paystack_test',
              name: b.name,
              details: {
                account_number: b.account_number,
                bank_code: b.bank_code,
              },
              currency: b.currency || 'NGN',
              type: b.type,
            },
          },
        };
      }
      if (url.includes('/transfer')) {
        const b = body as Record<string, unknown>;
        return {
          data: {
            status: true,
            data: {
              reference: b.reference,
              status: 'pending',
              transfer_code: 'TRF_paystack_test',
              amount: b.amount,
              currency: 'NGN',
              recipient: b.recipient,
            },
          },
        };
      }
      throw new Error(`Unexpected POST url: ${url}`);
    });
  },
);

describe('PaystackProvider Error Normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes 422 bank resolve errors to INVALID_ACCOUNT', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true);
    mockedAxios.get.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 422,
        data: { message: 'Could not resolve account name' },
      },
    });

    await expect(
      paystackProvider.verifyAccount({
        accountNumber: '9999999999',
        bankCode: '999',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ACCOUNT',
      retryable: false,
    });
  });

  it('normalizes 429 rate limit errors to retryable RATE_LIMITED', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true);
    mockedAxios.get.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 429,
        data: { message: 'Too many requests' },
      },
    });

    await expect(
      paystackProvider.checkTransferStatus({ reference: 'rate_limited_ref' }),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
  });

  it('normalizes insufficient balance errors to INSUFFICIENT_FUNDS', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true);
    mockedAxios.post.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: { message: 'Insufficient balance to complete transfer' },
      },
    });

    await expect(
      paystackProvider.initiateTransfer({
        source: 'balance',
        amount: '10000',
        recipient: 'RCP_test',
        reference: `ref_insufficient_${Date.now()}`,
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      retryable: false,
    });
  });
});
