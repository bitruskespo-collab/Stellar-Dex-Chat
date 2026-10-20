/**
 * @fileoverview Deterministic fake payout provider for contract and integration testing.
 */

import { toMinorUnits } from '../minorUnits';
import {
  CreatedRecipient,
  CreateRecipientInput,
  InitiatedTransfer,
  InitiateTransferInput,
  NormalizedPayoutStatus,
  PayoutProvider,
  PayoutProviderError,
  TransferStatus,
  TransferStatusInput,
  VerifiedAccount,
  VerifyAccountInput,
} from './types';

export class FakePayoutProvider implements PayoutProvider {
  readonly name = 'fake' as const;

  private accounts = new Map<string, { accountName: string; bankId: number }>();
  private recipients = new Map<string, CreatedRecipient>();
  private transfers = new Map<string, InitiatedTransfer>();
  private simulatedErrors = new Map<string, PayoutProviderError>();
  private retryCounts = new Map<string, number>();

  constructor() {
    this.seedDefaultAccounts();
  }

  private seedDefaultAccounts() {
    this.accounts.set('0123456789:058', {
      accountName: 'John Doe',
      bankId: 58,
    });
    this.accounts.set('0987654321:011', {
      accountName: 'Jane Smith',
      bankId: 11,
    });
  }

  reset() {
    this.accounts.clear();
    this.recipients.clear();
    this.transfers.clear();
    this.simulatedErrors.clear();
    this.retryCounts.clear();
    this.seedDefaultAccounts();
  }

  registerAccount(
    accountNumber: string,
    bankCode: string,
    accountName: string,
    bankId = 1,
  ) {
    this.accounts.set(`${accountNumber}:${bankCode}`, {
      accountName,
      bankId,
    });
  }

  simulateError(operation: string, error: PayoutProviderError) {
    this.simulatedErrors.set(operation, error);
  }

  clearSimulatedError(operation: string) {
    this.simulatedErrors.delete(operation);
  }

  async verifyAccount(input: VerifyAccountInput): Promise<VerifiedAccount> {
    const error = this.simulatedErrors.get('verifyAccount');
    if (error) {
      throw error;
    }

    const key = `${input.accountNumber}:${input.bankCode}`;
    const account = this.accounts.get(key);

    if (!account) {
      throw new PayoutProviderError({
        message: 'Could not resolve account name with provider',
        code: 'ACCOUNT_NOT_FOUND',
        statusCode: 404,
        retryable: false,
      });
    }

    return {
      accountNumber: input.accountNumber,
      accountName: account.accountName,
      bankCode: input.bankCode,
      bankId: account.bankId,
      rawResponse: { fake: true },
    };
  }

  async createRecipient(
    input: CreateRecipientInput,
  ): Promise<CreatedRecipient> {
    const error = this.simulatedErrors.get('createRecipient');
    if (error) {
      throw error;
    }

    const recipientCode = `RCP_fake_${Math.abs(
      hashCode(`${input.account_number}:${input.bank_code}`),
    )}`;

    const recipient: CreatedRecipient = {
      recipientCode,
      name: input.name,
      accountNumber: input.account_number,
      bankCode: input.bank_code,
      currency: input.currency || 'NGN',
      type: input.type,
      provider: 'fake',
      rawResponse: { fake: true },
    };

    this.recipients.set(recipientCode, recipient);
    return recipient;
  }

  async initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiatedTransfer> {
    const error = this.simulatedErrors.get('initiateTransfer');
    if (error) {
      throw error;
    }

    const reference =
      input.reference ||
      input.idempotencyKey ||
      `tx_fake_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Idempotency check: if transfer already exists for this reference, return it
    const existing = this.transfers.get(reference);
    if (existing) {
      return existing;
    }

    const currency = input.currency || 'NGN';
    const amountMinor = toMinorUnits(input.amount, currency);

    const transfer: InitiatedTransfer = {
      reference,
      status: 'pending',
      providerReference: `PROV_${reference}`,
      transferCode: `TRF_${reference}`,
      amountMinor,
      currency,
      recipientCode: input.recipient,
      rawResponse: { fake: true },
    };

    this.transfers.set(reference, transfer);
    return transfer;
  }

  async checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatus> {
    const error = this.simulatedErrors.get('checkTransferStatus');
    if (error) {
      throw error;
    }

    const transfer = this.transfers.get(input.reference);
    if (!transfer) {
      throw new PayoutProviderError({
        message: 'Transfer reference not found',
        code: 'ACCOUNT_NOT_FOUND',
        statusCode: 404,
        retryable: false,
      });
    }

    return {
      reference: transfer.reference,
      status: transfer.status,
      providerReference: transfer.providerReference,
      transferCode: transfer.transferCode,
      amountMinor: transfer.amountMinor,
      currency: transfer.currency,
      rawResponse: { fake: true },
    };
  }

  setTransferStatus(
    reference: string,
    status: NormalizedPayoutStatus,
    failureReason?: string,
  ) {
    const existing = this.transfers.get(reference);
    if (existing) {
      this.transfers.set(reference, {
        ...existing,
        status,
        rawResponse: { failureReason },
      });
    }
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export const fakePayoutProvider = new FakePayoutProvider();
