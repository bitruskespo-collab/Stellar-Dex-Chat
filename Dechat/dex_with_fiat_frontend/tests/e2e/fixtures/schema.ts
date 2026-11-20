/**
 * @fileoverview Type definitions for the deterministic full-stack fixture.
 *
 * The fixture is a single seed-derived object (`FullStackFixture`) that carries
 * everything an integration test needs to reproduce the full Stellar ↔ fiat
 * payout stack without touching production networks, real wallets, or live
 * payout providers:
 *
 *   - wallet identities (valid-format Stellar addresses, no secret keys)
 *   - seeded ledger history (the on-chain contract event stream)
 *   - reproducible contract state (derived by replaying the ledger history)
 *   - deterministic payout-provider responses (normal + failure/edge cases)
 *   - Soroban RPC mock responses
 *
 * Everything here is plain data so it can be serialized to JSON, diffed between
 * runs, and asserted to be byte-identical for a given seed.
 */

import type { ContractEvent } from '@/types/events';

/** Bump when the serialized shape of the fixture changes. */
export const FULLSTACK_FIXTURE_SCHEMA_VERSION = 1 as const;

/** Roles a seeded wallet can play in the fixture scenario. */
export type WalletRole = 'admin' | 'operator' | 'user';

/** A deterministic Stellar wallet identity. The address is a valid-format `G…`
 * strkey derived from the seed; no secret key is ever generated or stored, so
 * fixtures carry no spendable credentials. */
export interface WalletIdentity {
  /** Stable identifier, e.g. `wallet-0`. */
  id: string;
  /** Deterministic valid-format Stellar account address (`G…`). */
  address: string;
  role: WalletRole;
  /** Human-readable label for diagnostics and assertions. */
  label: string;
}

/**
 * Raw on-chain contract event. Structurally compatible with the existing
 * `fixtures/events/golden_events.json` catalog so the indexer compatibility
 * suite extends naturally.
 */
export interface FixtureEvent {
  family: string;
  type: string;
  version: number;
  topics: Array<string | number>;
  // The `version` field inside `data` mirrors the golden fixture convention.
  data: Record<string, unknown> & { version: number };
}

/** A single ledger in the seeded history. */
export interface LedgerEntry {
  /** Ledger sequence number. */
  sequence: number;
  /** ISO-8601 close time, derived deterministically from the seed. */
  closedAt: string;
  /** Deterministic transaction hashes emitted in this ledger. */
  txHashes: string[];
  /** Contract events emitted in this ledger. */
  events: FixtureEvent[];
}

/** Lifecycle status of a withdrawal request. */
export type WithdrawalStatus = 'pending' | 'executed' | 'cancelled' | 'expired';

/** A withdrawal request queued in the contract (derived from the ledger). */
export interface WithdrawalQueueItem {
  requestId: number;
  ledger: number;
  amount: string;
  token: string;
  to: string;
  status: WithdrawalStatus;
}

/** Reproducible snapshot of the `FiatBridge` contract state. */
export interface ContractState {
  contractId: string;
  nativeToken: string;
  admin: string;
  /** Per-token totals, stroops (non-negative integers as strings). */
  totalDeposited: Record<string, string>;
  totalWithdrawn: Record<string, string>;
  totalRefunded: Record<string, string>;
  netDeposited: Record<string, string>;
  /** Current on-chain contract balance, per token (stroops). */
  balance: Record<string, string>;
  /** Fees accrued but not yet withdrawn, per token (stroops). */
  accruedFees: Record<string, string>;
  /** Pending (queued) withdrawal requests. */
  withdrawalQueue: WithdrawalQueueItem[];
  /** Per-token deposit/withdrawal limits (stroops). */
  limits: Record<string, string>;
  /** Active operator addresses. */
  operators: string[];
  paused: boolean;
  /** Withdrawal-queue depth. */
  wqDepth: number;
  /** Ledger of the oldest pending request, or `null` when the queue is empty. */
  wqOldestQueuedLedger: number | null;
  /** Age of the oldest pending request in ledgers, or `null` when empty. */
  wqOldestAgeLedgers: number | null;
  /** Ledger sequence at the tip of the seeded history. */
  currentLedger: number;
}

/** A deterministic Nigerian (NUBAN) bank account for payout flows. */
export interface SeededBankAccount {
  /** 10-digit NUBAN account number. */
  accountNumber: string;
  /** 3-6 digit Paystack bank code. */
  bankCode: string;
  accountName: string;
  bankId: number;
}

/** A deterministic Paystack transfer recipient. */
export interface SeededRecipient {
  recipientCode: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
  type: string;
}

/** A deterministic Paystack transfer. */
export interface SeededTransfer {
  reference: string;
  transferCode: string;
  /** Amount in minor units (kobo for NGN). */
  amountMinor: number;
  currency: string;
  /** Paystack status: `pending` | `success` | `failed` | `reversed`. */
  status: string;
  recipient: string;
}

/** Public bank metadata (codes are public, not user data). */
export interface Bank {
  name: string;
  slug: string;
  code: string;
  currency: string;
  country: string;
}

/** Raw Paystack axios response envelope: `{ status, message?, data }`. */
export interface PaystackEnvelope<TData> {
  status: boolean;
  message?: string;
  data: TData;
}

/** A single deterministic provider failure / edge case, captured at every
 * layer a test might exercise (axios transport, normalized provider error,
 * and the app API route response the browser sees). */
export interface ProviderFailureCase {
  /** Scenario name (e.g. `invalidAccount`). */
  scenario: string;
  /** HTTP status the Paystack API would return. */
  httpStatus: number;
  /** Normalized `PayoutProviderError` code. */
  code: string;
  retryable: boolean;
  /** Raw Paystack axios rejection shape (for axios-mocked provider tests). */
  axiosRejection: {
    isAxiosError: true;
    response: { status: number; data: { message: string } };
  };
  /** Normalized provider error (for `FakePayoutProvider.simulateError`). */
  providerError: {
    code: string;
    statusCode: number;
    retryable: boolean;
    message: string;
  };
  /** App API route response the browser sees (matches `/api/*` error shapes). */
  appRouteResponse: Record<string, unknown>;
}

/** Deterministic payout-provider responses across normal and failure paths. */
export interface ProviderResponses {
  banks: Bank[];
  /** Seeded bank accounts usable for verification + recipient creation. */
  accounts: SeededBankAccount[];
  recipients: SeededRecipient[];
  transfers: SeededTransfer[];
  /** Raw Paystack axios envelopes keyed by endpoint (the transport layer). */
  paystackEnvelopes: {
    resolveAccount: PaystackEnvelope<{
      account_number: string;
      account_name: string;
      bank_id: number;
    }>;
    createRecipient: PaystackEnvelope<{
      recipient_code: string;
      name: string;
      details: { account_number: string; bank_code: string };
      currency: string;
      type: string;
    }>;
    initiateTransfer: PaystackEnvelope<{
      reference: string;
      status: string;
      transfer_code: string;
      amount: number;
      currency: string;
      recipient: string;
    }>;
    verifyTransfer: PaystackEnvelope<{
      reference: string;
      status: string;
      transfer_code: string;
      amount: number;
      currency: string;
    }>;
  };
  /** App API route responses (what `/api/*` return to the browser). */
  appRouteResponses: {
    verifyAccount: {
      success: true;
      data: { account_number: string; account_name: string; bank_id: number };
    };
    createRecipient: {
      success: true;
      data: {
        recipient_code: string;
        name: string;
        reused: boolean;
        recovered?: boolean;
      };
    };
    initiateTransfer: {
      success: true;
      data: {
        reference: string;
        status: string;
        transfer_code: string;
        amount: number;
        currency: string;
        recipient: string;
      };
    };
    transferStatus: {
      success: true;
      data: { reference: string; status: string; transfer_code: string; amount: string; currency: string };
    };
  };
  /** Failure / edge cases keyed by scenario. */
  failures: {
    invalidAccount: ProviderFailureCase;
    accountNotFound: ProviderFailureCase;
    rateLimited: ProviderFailureCase;
    insufficientFunds: ProviderFailureCase;
    providerOutage: ProviderFailureCase;
    authenticationError: ProviderFailureCase;
  };
}

/** Deterministic Soroban RPC mock responses. */
export interface SorobanRpcMocks {
  latestLedger: number;
  networkPassphrase: string;
  getLatestLedger: {
    jsonrpc: '2.0';
    id: number | string;
    result: { sequence: number; protocolVersion: number };
  };
  getNetwork: {
    jsonrpc: '2.0';
    id: number | string;
    result: { passphrase: string };
  };
  getAccount: {
    jsonrpc: '2.0';
    id: number | string;
    result: { id: string; sequence: string; balances: unknown[] };
  };
  sendTransaction: {
    jsonrpc: '2.0';
    id: number | string;
    result: {
      status: string;
      results: { xdr: string }[];
      cost: { cpuInsns: string; memBytes: string };
      latestLedger: number;
      latestLedgerCloseTime: string;
    };
  };
  /** `simulateTransaction` results keyed by contract function name. Each value
   * is a base64 ScVal XDR string suitable for `result.results[0].xdr`. */
  simulate: Record<string, { xdr: string }>;
}

/** The complete seed-derived full-stack fixture. */
export interface FullStackFixture {
  schemaVersion: typeof FULLSTACK_FIXTURE_SCHEMA_VERSION;
  /** The seed string this fixture was generated from. */
  seed: string;
  /** Deterministic generation timestamp (seed-derived, not wall-clock). */
  generatedAt: string;
  wallets: WalletIdentity[];
  ledgerHistory: LedgerEntry[];
  /** All ledger events flattened, in ledger order. */
  events: FixtureEvent[];
  /** Events mapped to the frontend indexer `ContractEvent` shape. */
  contractEvents: ContractEvent[];
  contractState: ContractState;
  provider: ProviderResponses;
  rpc: SorobanRpcMocks;
}
