/**
 * @fileoverview Payout provider adapter boundary types and internal normalized schema.
 *
 * Decouples provider-specific transport, headers, secrets, and response shapes from domain logic.
 */

export type PayoutProviderName = 'paystack' | 'fake';

/**
 * Internal normalized transfer lifecycle statuses.
 * Every provider adapter maps proprietary provider statuses to this canonical set.
 */
export type NormalizedPayoutStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

/**
 * Standardized error categories returned by provider adapters.
 */
export type PayoutErrorCode =
  | 'INVALID_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'AUTHENTICATION_ERROR'
  | 'INVALID_REQUEST'
  | 'UNKNOWN_ERROR';

/**
 * Normalized provider error class with retryability metadata.
 */
export class PayoutProviderError extends Error {
  readonly code: PayoutErrorCode;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly providerCode?: string;
  readonly rawResponse?: unknown;

  constructor(options: {
    message: string;
    code: PayoutErrorCode;
    statusCode?: number;
    retryable?: boolean;
    providerCode?: string;
    rawResponse?: unknown;
  }) {
    super(options.message);
    this.name = 'PayoutProviderError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
    this.rawResponse = options.rawResponse;
  }
}

// ==========================================
// 1. Account Verification
// ==========================================

export interface VerifyAccountInput {
  accountNumber: string;
  bankCode: string;
  currency?: string;
}

export interface VerifiedAccount {
  accountNumber: string;
  accountName: string;
  bankCode: string;
  bankId?: number;
  rawResponse?: unknown;
}

// Backward compatibility alias
export type VerifyAccountResult = VerifiedAccount;

// ==========================================
// 2. Recipient Creation
// ==========================================

export interface CreateRecipientInput {
  type: string;
  name: string;
  account_number: string;
  bank_code: string;
  currency: string;
}

export interface CreatedRecipient {
  recipientCode: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
  type: string;
  provider: PayoutProviderName;
  rawResponse?: unknown;
}

// Backward compatibility alias
export type CreateRecipientResult = CreatedRecipient;

// ==========================================
// 3. Transfer Initiation
// ==========================================

export interface InitiateTransferInput {
  source: string;
  reason?: string;
  amount: number | string;
  recipient: string;
  reference?: string;
  credentialVersion?: string;
}

// Backward compatibility alias
export type InitiateTransferResult = InitiatedTransfer;

// ==========================================
// 4. Status Lookup
// ==========================================

export interface TransferStatusInput {
  reference: string;
  credentialVersion?: string;
}

export interface TransferStatus {
  reference: string;
  status: NormalizedPayoutStatus;
  providerReference?: string;
  transferCode?: string;
  amountMinor?: bigint;
  currency?: string;
  failureReason?: string;
  completedAt?: string;
  rawResponse?: unknown;
}

// Backward compatibility alias
export type TransferStatusResult = TransferStatus;

// ==========================================
// Provider Interface
// ==========================================

export interface CancelTransferInput {
  reference: string;
  reason?: string;
}

export interface CancelTransferResult {
  status: 'confirmed' | 'rejected' | 'pending' | 'settled';
  cancellable: boolean;
  message?: string;
  providerReference?: string;
}

export interface PayoutProvider {
  name: PayoutProviderName;

  verifyAccount(input: VerifyAccountInput): Promise<VerifyAccountResult>;
  createRecipient(input: CreateRecipientInput): Promise<CreateRecipientResult>;
  initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiateTransferResult>;
  checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatusResult>;
  cancelTransfer?(
    input: CancelTransferInput,
  ): Promise<CancelTransferResult>;
}
