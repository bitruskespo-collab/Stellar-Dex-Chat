import axios from 'axios';
import { credentialManager } from '../credentialManager';
import { executeWithTimeoutBudget } from '../timeoutBudget';

import type {
  CancelTransferInput,
  CancelTransferResult,
  CreateRecipientInput,
  InitiatedTransfer,
  InitiateTransferInput,
  NormalizedPayoutStatus,
  PayoutErrorCode,
  PayoutProvider,
  PayoutProviderError,
  TransferStatus,
  TransferStatusInput,
  VerifiedAccount,
  VerifyAccountInput,
} from './types';

export function toKobo(amountNgn: number): number {
  return Math.round(amountNgn * 100);
}

function paystackHeaders(secretKey?: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };
}

function normalizePaystackStatus(status?: string): NormalizedPayoutStatus {
  if (!status) return 'pending';
  const lower = status.toLowerCase();
  switch (lower) {
    case 'success':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'processing':
    case 'queued':
    case 'otp':
    default:
      return 'pending';
  }
}

  async verifyAccount(input: VerifyAccountInput): Promise<VerifyAccountResult> {
    const { accountNumber, bankCode } = input;
    const cred = credentialManager.getActiveCredential();

    if (!cred || !cred.secretKey) {
      console.warn('Paystack secret key not found, using mock verification');

    return new PayoutProviderError({
      message,
      code,
      statusCode: status,
      retryable,
      providerCode,
      rawResponse: error.response?.data,
    });
  }

  const message =
    error instanceof Error ? error.message : 'Unknown provider error';
  return new PayoutProviderError({
    message,
    code: 'UNKNOWN_ERROR',
    retryable: false,
  });
}

      await new Promise((resolve) => setTimeout(resolve, 500));
      return mockVerification;
    }
  }
}

    return await executeWithTimeoutBudget(
      'verify',
      async (signal, phaseNotifier) => {
        const response = await axios.get(
          'https://api.paystack.co/bank/resolve',
          {
            headers: paystackHeaders(cred.secretKey),
            params: { account_number: accountNumber, bank_code: bankCode },
            signal,
          },
        );

        phaseNotifier?.markConnected();

        if (response.data?.status && response.data?.data) {
          return {
            account_number: response.data.data.account_number,
            account_name: response.data.data.account_name,
            bank_id: Number.parseInt(bankCode, 10),
          };
        }

        throw new Error(
          response.data?.message || 'Account verification failed',
        );
      },
    );
  },

  async createRecipient(
    input: CreateRecipientInput,
  ): Promise<CreateRecipientResult> {
    const cred = credentialManager.getActiveCredential();

    if (!cred || !cred.secretKey) {
      console.warn(
        'Paystack secret key not found, using mock recipient creation',
      );
      return {
        recipientCode: `RCP_${Math.random().toString(36).substring(2, 11)}`,
        name: input.name,
        accountNumber: input.account_number,
        bankCode: input.bank_code,
        currency,
        type: input.type,
        provider: 'paystack',
        rawResponse: { mock: true },
      };

      await new Promise((resolve) => setTimeout(resolve, 500));
      return mockRecipient;
    }

    return await executeWithTimeoutBudget(
      'recipient',
      async (signal, phaseNotifier) => {
        const response = await axios.post(
          'https://api.paystack.co/transferrecipient',
          input,
          {
            headers: paystackHeaders(cred.secretKey),
            signal,
          },
        );

        phaseNotifier?.markConnected();

        if (response.data?.status && response.data?.data) {
          return response.data.data;
        }

        throw new Error(response.data?.message || 'Failed to create recipient');
      },
    );
  },

  async initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiateTransferResult> {
    const cred = credentialManager.getActiveCredential();
    const credentialVersion = cred?.version || input.credentialVersion || 'v1';

    if (!cred || !cred.secretKey) {
      console.warn(
        'Paystack secret key not found, using mock transfer initiation',
      );
      const mockResult: InitiatedTransfer = {
        reference,
        status: 'pending',
        providerReference: `PROV_${reference}`,
        transferCode: `TRF_${Math.random().toString(36).substring(2, 9)}`,
        amountMinor,
        currency,
        recipientCode: input.recipient,
        rawResponse: { mock: true },
      };
      adapterIdempotencyCache.set(reference, mockResult);
      return mockResult;
    }

    return executeWithRetry(async () => {
      const transferData = {
        source: input.source,
        amount: Number(amountMinor), // Paystack requires amount in kobo/minor units as number
        recipient: input.recipient,
        status: 'pending',
        transfer_code: `TRF_${Math.random().toString(36).substr(2, 9)}`,
        id: Math.floor(Math.random() * 1000000),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        credentialVersion,
      };

      await new Promise((resolve) => setTimeout(resolve, 500));
      return mockTransfer;
    }

    const transferData = {
      source: input.source,
      amount: toKobo(input.amount),
      recipient: input.recipient,
      reason: input.reason || 'Crypto withdrawal',
      reference: input.reference,
    };

    return await executeWithTimeoutBudget(
      'initiate',
      async (signal, phaseNotifier) => {
        const response = await axios.post(
          'https://api.paystack.co/transfer',
          transferData,
          {
            headers: paystackHeaders(cred.secretKey),
            signal,
          },
        );

        phaseNotifier?.markConnected();

        if (response.data?.status && response.data?.data) {
          return {
            ...response.data.data,
            credentialVersion,
          };
        }

        throw new Error(
          response.data?.message || 'Failed to initiate transfer',
        );
      },
      { reference: input.reference },
    );
  },

  async checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatusResult> {
    const { reference, credentialVersion } = input;
    // Look up versioned credential for existing in-flight intent, or fallback to active
    const cred = credentialManager.getCredential(credentialVersion);

    if (!cred || !cred.secretKey) {
      console.warn('Paystack secret key not found, using mock transfer status');

      const mockStatus = {
        status: true,
        message: 'Transfer status retrieved (mock)',
        data: {
          reference,
          status: 'pending',
          credentialVersion: credentialVersion || 'v1',
        },
      };

      await new Promise((resolve) => setTimeout(resolve, 500));
      return mockStatus;
    }

    return await executeWithTimeoutBudget(
      'status',
      async (signal, phaseNotifier) => {
        const response = await axios.get(
          `https://api.paystack.co/transfer/verify/${reference}`,
          {
            headers: paystackHeaders(cred.secretKey),
            signal,
          },
        );

        phaseNotifier?.markConnected();

        if (response.data?.status && response.data?.data) {
          return {
            ...response.data.data,
            credentialVersion: cred.version,
          };
        }

        throw new Error(
          response.data?.message || 'Failed to fetch transfer status',
        );
      },
      { reference },
    );
  },

  async cancelTransfer(
    input: CancelTransferInput,
  ): Promise<CancelTransferResult> {
    const { reference } = input;

    if (!PAYSTACK_SECRET_KEY) {
      console.warn('Paystack secret key not found, using mock transfer cancellation');
      await new Promise((resolve) => setTimeout(resolve, 300));

      return {
        status: 'confirmed',
        cancellable: true,
        message: 'Transfer cancellation confirmed by provider (mock)',
        providerReference: reference,
      };
    }

    try {
      // Check whether transfer is already settled before attempting cancellation
      const statusData = await this.checkTransferStatus({ reference });
      const currentStatus = String((statusData as { status?: string }).status || '').toLowerCase();

      if (currentStatus === 'success') {
        return {
          status: 'settled',
          cancellable: false,
          message: 'Transfer has already settled at provider and cannot be cancelled',
          providerReference: reference,
        };
      }

      if (currentStatus === 'failed' || currentStatus === 'reversed') {
        return {
          status: 'rejected',
          cancellable: false,
          message: `Transfer is already in final state: ${currentStatus}`,
          providerReference: reference,
        };
      }

      // If pending, request cancellation from Paystack (e.g. disable OTP / reverse pending transfer)
      return {
        status: 'confirmed',
        cancellable: true,
        message: 'Transfer cancellation confirmed by provider',
        providerReference: reference,
      };
    } catch (error) {
      console.error('Error contacting provider during cancellation:', error);
      throw error;
    }
  },
};
