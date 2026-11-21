import axios from 'axios';
import { credentialManager } from '../credentialManager';
import type {
  CancelTransferInput,
  CancelTransferResult,
  CreateRecipientInput,
  CreatedRecipient,
  InitiatedTransfer,
  InitiateTransferInput,
  NormalizedPayoutStatus,
  PayoutProvider,
  TransferStatus,
  TransferStatusInput,
  VerifiedAccount,
  VerifyAccountInput,
} from './types';
import { PayoutProviderError } from './types';

function normalizeStatus(status?: string): NormalizedPayoutStatus {
  const value = (status || 'pending').toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'reversed') return 'reversed';
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  if (value === 'failed' || value === 'rejected') return 'failed';
  return 'pending';
}

function headers(secretKey: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };
}

export const paystackProvider: PayoutProvider = {
  name: 'paystack',

  async verifyAccount(
    input: VerifyAccountInput,
  ): Promise<VerifiedAccount> {
    const credential = credentialManager.getActiveCredential();
    if (!credential) {
      throw new PayoutProviderError({
        message: 'Paystack credentials are not configured',
        code: 'AUTHENTICATION_ERROR',
        statusCode: 401,
        retryable: false,
      });
    }
    const response = await axios.get(
      'https://api.paystack.co/bank/resolve',
      {
        headers: headers(credential.secretKey),
        params: {
          account_number: input.accountNumber,
          bank_code: input.bankCode,
        },
      },
    );
    const data = response.data?.data;
    if (!response.data?.status || !data) {
      throw new PayoutProviderError({
        message: 'Could not resolve account',
        code: 'INVALID_ACCOUNT',
        retryable: false,
      });
    }
    return {
      accountNumber: String(data.account_number),
      accountName: String(data.account_name),
      bankCode: input.bankCode,
      bankId: Number(data.bank_id),
      rawResponse: response.data,
    };
  },

  async createRecipient(
    input: CreateRecipientInput,
  ): Promise<CreatedRecipient> {
    const credential = credentialManager.getActiveCredential();
    if (!credential) {
      throw new PayoutProviderError({
        message: 'Paystack credentials are not configured',
        code: 'AUTHENTICATION_ERROR',
        statusCode: 401,
        retryable: false,
      });
    }
    const response = await axios.post(
      'https://api.paystack.co/transferrecipient',
      {
        type: input.type,
        name: input.name,
        account_number: input.account_number,
        bank_code: input.bank_code,
        currency: input.currency,
      },
      { headers: headers(credential.secretKey) },
    );
    const data = response.data?.data;
    if (!response.data?.status || !data?.recipient_code) {
      throw new PayoutProviderError({
        message: 'Could not create transfer recipient',
        code: 'INVALID_REQUEST',
        retryable: false,
      });
    }
    return {
      recipientCode: String(data.recipient_code),
      name: input.name,
      accountNumber: input.account_number,
      bankCode: input.bank_code,
      currency: input.currency,
      type: input.type,
      provider: 'paystack',
      rawResponse: response.data,
    };
  },

  async initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiatedTransfer> {
    const credential = credentialManager.getActiveCredential();
    if (!credential) {
      throw new PayoutProviderError({
        message: 'Paystack credentials are not configured',
        code: 'AUTHENTICATION_ERROR',
        statusCode: 401,
        retryable: false,
      });
    }
    const amountMinor =
      typeof input.amount === 'string'
        ? BigInt(Math.round(Number(input.amount) * 100))
        : BigInt(Math.round(input.amount * 100));
    const response = await axios.post(
      'https://api.paystack.co/transfer',
      {
        source: input.source,
        reason: input.reason,
        amount: Number(amountMinor),
        recipient: input.recipient,
        reference: input.reference,
      },
      { headers: headers(credential.secretKey) },
    );
    const data = response.data?.data;
    if (!response.data?.status || !data) {
      throw new PayoutProviderError({
        message: 'Could not initiate transfer',
        code: 'INVALID_REQUEST',
        retryable: false,
      });
    }
    return {
      reference: String(data.reference || input.reference || ''),
      status: normalizeStatus(data.status),
      providerReference: data.transfer_code
        ? String(data.transfer_code)
        : undefined,
      transferCode: data.transfer_code
        ? String(data.transfer_code)
        : undefined,
      amountMinor,
      currency: 'NGN',
      recipientCode: input.recipient,
      rawResponse: response.data,
    };
  },

  async checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatus> {
    const credential = credentialManager.getCredential(
      input.credentialVersion,
    );
    if (!credential) {
      throw new PayoutProviderError({
        message: 'Paystack credentials are not configured',
        code: 'AUTHENTICATION_ERROR',
        statusCode: 401,
        retryable: false,
      });
    }
    const response = await axios.get(
      `https://api.paystack.co/transfer/reference/${encodeURIComponent(input.reference)}`,
      { headers: headers(credential.secretKey) },
    );
    const data = response.data?.data;
    if (!response.data?.status || !data) {
      throw new PayoutProviderError({
        message: 'Could not retrieve transfer status',
        code: 'PROVIDER_UNAVAILABLE',
        statusCode: response.status,
        retryable: true,
      });
    }
    return {
      reference: String(data.reference || input.reference),
      status: normalizeStatus(data.status),
      providerReference: data.transfer_code
        ? String(data.transfer_code)
        : undefined,
      transferCode: data.transfer_code
        ? String(data.transfer_code)
        : undefined,
      amountMinor:
        typeof data.amount === 'number'
          ? BigInt(data.amount)
          : undefined,
      currency: 'NGN',
      failureReason: data.fail_reason
        ? String(data.fail_reason)
        : undefined,
      rawResponse: response.data,
    };
  },

  async cancelTransfer(
    input: CancelTransferInput,
  ): Promise<CancelTransferResult> {
    const credential = credentialManager.getActiveCredential();
    if (!credential) {
      throw new PayoutProviderError({
        message: 'Paystack credentials are not configured',
        code: 'AUTHENTICATION_ERROR',
        statusCode: 401,
        retryable: false,
      });
    }
    const status = await this.checkTransferStatus({
      reference: input.reference,
    });
    if (status.status === 'success') {
      return {
        status: 'settled',
        cancellable: false,
        message: 'Transfer settled at provider',
        providerReference: status.providerReference,
      };
    }
    return {
      status: 'rejected',
      cancellable: false,
      message: 'Cancellation is not supported by this Paystack adapter',
      providerReference: status.providerReference,
    };
  },
};
