/**
 * @fileoverview Deterministic full-stack fixture generator.
 *
 * Call {@link generateFixture} with a seed string to obtain a
 * `FullStackFixture` whose every field — wallet addresses, ledger sequences,
 * event amounts, tx hashes, Paystack recipient codes, transfer references —
 * is derived solely from that seed. Two calls with the same seed on any
 * machine produce byte-identical output.
 *
 * The generator has no network I/O and no dependency on `@stellar/stellar-sdk`
 * at runtime: Stellar addresses are encoded using a pure-TS strkey
 * implementation (the same algorithm the SDK uses) so the fixture directory
 * stays self-contained and fast.
 *
 * Usage:
 *   import { generateFixture } from './generator';
 *   const f = generateFixture('my-seed');
 *   const f2 = generateFixture('my-seed'); // identical to f
 */

import { createHash } from 'node:crypto';
import type {
  FullStackFixture,
  WalletIdentity,
  WalletRole,
  LedgerEntry,
  FixtureEvent,
  ContractState,
  WithdrawalQueueItem,
  WithdrawalStatus,
  ProviderResponses,
  ProviderFailureCase,
  SeededBankAccount,
  SeededRecipient,
  SeededTransfer,
  Bank,
  SorobanRpcMocks,
} from './schema';
import { FULLSTACK_FIXTURE_SCHEMA_VERSION } from './schema';
import { SeededRandom, hexString, nuban, bankCode } from './seed';
import type { ContractEvent } from '@/types/events';

// ─── Stellar strkey (no SDK dependency) ───────────────────────────────────

/**
 * Encode raw bytes as a Stellar strkey using the given version byte.
 * Version 6 (0x06 << 3 = 48 = 'G') → Stellar account address.
 * Version 2 (0x02 << 3 = 16 = 'C') → Stellar contract address.
 *
 * The algorithm is: [versionByte, ...payload, crc16Bytes] → base32(upper, no padding).
 */
function strkey(versionByte: number, payload: Uint8Array): string {
  const data = new Uint8Array(1 + payload.length);
  data[0] = versionByte;
  data.set(payload, 1);
  const checksum = crc16xmodem(data);
  const full = new Uint8Array(data.length + 2);
  full.set(data, 0);
  full[data.length] = checksum & 0xff;
  full[data.length + 1] = (checksum >> 8) & 0xff;
  return base32Encode(full);
}

/** CRC-16/XMODEM as used by Stellar strkeys. */
function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Version byte for a Stellar account address (G…). */
const STRKEY_ACCOUNT_VERSION = 6 << 3; // 48

/** Version byte for a Stellar contract address (C…). */
const STRKEY_CONTRACT_VERSION = 2 << 3; // 16

/** Generate a deterministic Stellar account address from 32 raw bytes. */
function stellarAddress(bytes32: Uint8Array): string {
  return strkey(STRKEY_ACCOUNT_VERSION, bytes32);
}

/** Generate a deterministic Stellar contract address from 32 raw bytes. */
function stellarContract(bytes32: Uint8Array): string {
  return strkey(STRKEY_CONTRACT_VERSION, bytes32);
}

/** Derive deterministic 32 raw bytes for identity `index` within `scope`. */
function identityBytes(masterSeed: string, scope: string, index: number): Uint8Array {
  const hash = createHash('sha256')
    .update(`${masterSeed}:${scope}:${index}`)
    .digest();
  return new Uint8Array(hash);
}

/** Derive a deterministic `G…` address. No secret key is ever generated. */
function deriveAddress(masterSeed: string, scope: string, index: number): string {
  return stellarAddress(identityBytes(masterSeed, scope, index));
}

/** Derive a deterministic `C…` contract address. */
function deriveContractId(masterSeed: string, scope: string, index: number): string {
  return stellarContract(identityBytes(masterSeed, scope, index));
}

// ─── Well-known Nigerian banks (public data, not user data) ────────────────

const KNOWN_BANKS: Bank[] = [
  { name: 'First Bank', slug: 'first-bank', code: '011', currency: 'NGN', country: 'NG' },
  { name: 'GTBank', slug: 'gtbank', code: '058', currency: 'NGN', country: 'NG' },
  { name: 'Zenith Bank', slug: 'zenith-bank', code: '057', currency: 'NGN', country: 'NG' },
  { name: 'Access Bank', slug: 'access-bank', code: '044', currency: 'NGN', country: 'NG' },
  { name: 'UBA', slug: 'uba', code: '033', currency: 'NGN', country: 'NG' },
  { name: 'Fidelity Bank', slug: 'fidelity-bank', code: '070', currency: 'NGN', country: 'NG' },
];

// ─── Deterministic ScVal XDR snippets (admin address, i128 values) ─────────
// These are base64 representations of hardcoded ScVal XDRs that the Soroban
// RPC mock returns for `simulateTransaction` calls.  They match what the app
// parses to populate the admin dashboard and bridge stats components.

/** Encode an i128 value as an ScVal XDR base64 string.
 * ScVal type=i128 (13): hi(i64) + lo(u64), big-endian. */
function i128ScValXdr(value: bigint): string {
  const hi = Number((value >> 64n) & 0xffffffffffffffffn);
  const lo = Number(value & 0xffffffffffffffffn);
  // XDR layout: type=13 (4 bytes) + hi i64 (8 bytes) + lo u64 (8 bytes) = 20 bytes
  const buf = Buffer.alloc(20);
  buf.writeUInt32BE(13, 0); // ScValType.SCV_I128
  buf.writeBigInt64BE(BigInt(hi), 4);
  buf.writeBigUInt64BE(BigInt(lo), 12);
  return buf.toString('base64');
}

/** Encode a Stellar address as an ScVal XDR base64 string.
 * ScVal type=18 (SCV_ADDRESS), AccountId discriminant=0, 32-byte public key. */
function addressScValXdr(address: string): string {
  // Decode the strkey back to 32 raw bytes for XDR encoding.
  const decoded = strKeyDecode(address);
  // XDR layout: type=18 (4 bytes) + AccountId.discriminant=0 (4 bytes) + PublicKeyType=0 (4 bytes) + 32 bytes key
  const buf = Buffer.alloc(44);
  buf.writeUInt32BE(18, 0); // ScValType.SCV_ADDRESS
  buf.writeUInt32BE(0, 4);  // ScAddressType.ACCOUNT
  buf.writeUInt32BE(0, 8);  // PublicKeyType.PUBLIC_KEY_TYPE_ED25519
  buf.set(decoded, 12);
  return buf.toString('base64');
}

/** Decode a Stellar strkey (G… or C…) back to its raw 32-byte payload. */
function strKeyDecode(strkey: string): Uint8Array {
  const bytes = base32Decode(strkey);
  // bytes: [versionByte, ...32-byte payload, 2-byte CRC]
  return bytes.slice(1, bytes.length - 2);
}

function base32Decode(input: string): Uint8Array {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE32_ALPHABET.length; i++) {
    lookup[BASE32_ALPHABET[i]] = i;
  }
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const ch of input.toUpperCase()) {
    if (!(ch in lookup)) continue;
    value = (value << 5) | lookup[ch];
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

// ─── Wallet identity generation ────────────────────────────────────────────

function generateWallets(seed: string, rng: SeededRandom): WalletIdentity[] {
  const roles: Array<{ role: WalletRole; label: string }> = [
    { role: 'admin', label: 'Admin' },
    { role: 'operator', label: 'Operator' },
    { role: 'user', label: 'User A' },
    { role: 'user', label: 'User B' },
    { role: 'user', label: 'User C' },
  ];
  void rng; // rng used for future expansions; addresses are sha256-derived
  return roles.map((r, i) => ({
    id: `wallet-${i}`,
    address: deriveAddress(seed, 'wallet', i),
    role: r.role,
    label: r.label,
  }));
}

// ─── Ledger history generation ─────────────────────────────────────────────

/** Deterministic ISO-8601 timestamp based on a base epoch + ledger offset. */
function ledgerTimestamp(baseEpochMs: number, ledgerSeq: number): string {
  // 5 seconds per ledger (Stellar approximation)
  return new Date(baseEpochMs + ledgerSeq * 5_000).toISOString();
}

/** Deterministic 64-char hex tx hash. */
function txHash(seed: string, ledger: number, txIdx: number): string {
  return createHash('sha256')
    .update(`${seed}:txhash:${ledger}:${txIdx}`)
    .digest('hex');
}

function buildLedgerHistory(
  seed: string,
  rng: SeededRandom,
  wallets: WalletIdentity[],
  contractId: string,
  nativeToken: string,
): {
  ledgers: LedgerEntry[];
  allEvents: FixtureEvent[];
  contractEvents: ContractEvent[];
  contractState: ContractState;
} {
  const admin = wallets.find((w) => w.role === 'admin')!;
  const operator = wallets.find((w) => w.role === 'operator')!;
  const users = wallets.filter((w) => w.role === 'user');
  const user0 = users[0]!;
  const user1 = users[1]!;
  const user2 = users[2]!;

  // Base epoch: a pinned date that doesn't change with the system clock.
  const BASE_EPOCH_MS = 1_700_000_000_000; // 2023-11-14 (fixed)

  const startLedger = 1_000;

  // Accumulate state while emitting events
  const deposited: Record<string, bigint> = { [nativeToken]: 0n };
  const withdrawn: Record<string, bigint> = { [nativeToken]: 0n };
  const refunded: Record<string, bigint> = { [nativeToken]: 0n };
  const fees: Record<string, bigint> = { [nativeToken]: 0n };
  const limits: Record<string, bigint> = { [nativeToken]: 0n };
  const operators: Set<string> = new Set();
  let paused = false;
  let requestIdCounter = 0;
  const queueItems: Map<number, WithdrawalQueueItem & { executedOrCancelled: boolean }> = new Map();
  let currentLedger = startLedger;

  const ledgers: LedgerEntry[] = [];
  const allEvents: FixtureEvent[] = [];
  const contractEvents: ContractEvent[] = [];
  let contractEventIdx = 0;

  function emit(
    ledger: number,
    event: FixtureEvent,
  ) {
    allEvents.push(event);
    if (event.type === 'deposit' || event.type === 'withdraw') {
      const isDeposit = event.type === 'deposit';
      contractEvents.push({
        id: `${txHash(seed, ledger, contractEventIdx)}-${contractEventIdx}`,
        type: event.type as 'deposit' | 'withdraw',
        contractId,
        ledger,
        ledgerClosedAt: ledgerTimestamp(BASE_EPOCH_MS, ledger),
        txHash: txHash(seed, ledger, contractEventIdx),
        actor: isDeposit
          ? (event.data.from as string)
          : (event.data.to as string),
        amount: event.data.amount as string,
        token: (event.data.token as string | undefined) ?? nativeToken,
        version: event.version,
      });
      contractEventIdx++;
    }
  }

  function mkLedger(seq: number, events: FixtureEvent[]): LedgerEntry {
    return {
      sequence: seq,
      closedAt: ledgerTimestamp(BASE_EPOCH_MS, seq),
      txHashes: events.map((_, i) => txHash(seed, seq, i)),
      events,
    };
  }

  // ── Ledger 1000: SetLimit, SetOperator ────────────────────────────────
  const setLimitAmount = 5_000_000_000n;
  limits[nativeToken] = setLimitAmount;
  const setLimitEvent: FixtureEvent = {
    family: 'SetLimitEvent',
    type: 'set_limit',
    version: 1,
    topics: ['SetLimitEvent'],
    data: {
      version: 1,
      token: nativeToken,
      limit: setLimitAmount.toString(),
      by: admin.address,
      ledger: startLedger,
    },
  };

  operators.add(operator.address);
  const setOperatorEvent: FixtureEvent = {
    family: 'SetOperatorEvent',
    type: 'set_operator',
    version: 1,
    topics: ['SetOperatorEvent'],
    data: {
      version: 1,
      operator: operator.address,
      active: true,
      previous_active: false,
      operator_count: 1,
      by: admin.address,
      ledger: startLedger,
    },
  };

  const l1000Events = [setLimitEvent, setOperatorEvent];
  l1000Events.forEach((e) => emit(startLedger, e));
  ledgers.push(mkLedger(startLedger, l1000Events));
  currentLedger = startLedger;

  // ── Ledger 1010: User0 deposits 1 000 XLM ─────────────────────────────
  const deposit0 = 1_000_000_000n; // 100 XLM in stroops
  const receipt0 = hexString(new SeededRandom(`${seed}:receipt:0`), 32);
  const memo0 = hexString(new SeededRandom(`${seed}:memo:0`), 32);
  deposited[nativeToken] = (deposited[nativeToken] ?? 0n) + deposit0;
  const feePct0 = 10_000_000n; // 1 XLM fee
  fees[nativeToken] = (fees[nativeToken] ?? 0n) + feePct0;

  const depositEvent0: FixtureEvent = {
    family: 'DepositEvent',
    type: 'deposit',
    version: 1,
    topics: ['DepositEvent'],
    data: {
      version: 1,
      from: user0.address,
      token: nativeToken,
      amount: deposit0.toString(),
      receipt_id: receipt0,
      by: user0.address,
      ledger: 1010,
    },
  };
  const receiptIssued0: FixtureEvent = {
    family: 'ReceiptIssuedEvent',
    type: 'receipt_issued',
    version: 1,
    topics: ['ReceiptIssuedEvent'],
    data: { version: 1, receipt_id: receipt0, memo_hash: memo0 },
  };
  const feeAccrued0: FixtureEvent = {
    family: 'FeeAccruedEvent',
    type: 'fee_accrued',
    version: 1,
    topics: ['FeeAccruedEvent'],
    data: { version: 1, token: nativeToken, amount: feePct0.toString() },
  };

  const l1010Events = [depositEvent0, receiptIssued0, feeAccrued0];
  l1010Events.forEach((e) => emit(1010, e));
  ledgers.push(mkLedger(1010, l1010Events));
  currentLedger = 1010;

  // ── Ledger 1020: User1 deposits 500 XLM ───────────────────────────────
  const deposit1 = 500_000_000n;
  const receipt1 = hexString(new SeededRandom(`${seed}:receipt:1`), 32);
  const memo1 = hexString(new SeededRandom(`${seed}:memo:1`), 32);
  deposited[nativeToken] = (deposited[nativeToken] ?? 0n) + deposit1;
  const feePct1 = 5_000_000n;
  fees[nativeToken] = (fees[nativeToken] ?? 0n) + feePct1;

  const depositEvent1: FixtureEvent = {
    family: 'DepositEvent',
    type: 'deposit',
    version: 1,
    topics: ['DepositEvent'],
    data: {
      version: 1,
      from: user1.address,
      token: nativeToken,
      amount: deposit1.toString(),
      receipt_id: receipt1,
      by: user1.address,
      ledger: 1020,
    },
  };
  const receiptIssued1: FixtureEvent = {
    family: 'ReceiptIssuedEvent',
    type: 'receipt_issued',
    version: 1,
    topics: ['ReceiptIssuedEvent'],
    data: { version: 1, receipt_id: receipt1, memo_hash: memo1 },
  };
  const feeAccrued1: FixtureEvent = {
    family: 'FeeAccruedEvent',
    type: 'fee_accrued',
    version: 1,
    topics: ['FeeAccruedEvent'],
    data: { version: 1, token: nativeToken, amount: feePct1.toString() },
  };

  const l1020Events = [depositEvent1, receiptIssued1, feeAccrued1];
  l1020Events.forEach((e) => emit(1020, e));
  ledgers.push(mkLedger(1020, l1020Events));
  currentLedger = 1020;

  // ── Ledger 1030: User0 requests withdrawal of 250 XLM (queued) ────────
  requestIdCounter++;
  const reqId0 = requestIdCounter;
  const withdraw0 = 250_000_000n;

  const wqItem0: WithdrawalQueueItem & { executedOrCancelled: boolean } = {
    requestId: reqId0,
    ledger: 1030,
    amount: withdraw0.toString(),
    token: nativeToken,
    to: user0.address,
    status: 'pending' as WithdrawalStatus,
    executedOrCancelled: false,
  };
  queueItems.set(reqId0, wqItem0);

  const withdrawalRequested0: FixtureEvent = {
    family: 'WithdrawalRequestedEvent',
    type: 'withdrawal_requested',
    version: 1,
    topics: ['WithdrawalRequestedEvent'],
    data: {
      version: 1,
      to: user0.address,
      request_id: reqId0,
      amount: withdraw0.toString(),
      token: nativeToken,
      memo_hash: null,
    },
  };
  const l1030Events = [withdrawalRequested0];
  l1030Events.forEach((e) => emit(1030, e));
  ledgers.push(mkLedger(1030, l1030Events));
  currentLedger = 1030;

  // ── Ledger 1040: Operator executes user0's withdrawal ─────────────────
  withdrawn[nativeToken] = (withdrawn[nativeToken] ?? 0n) + withdraw0;
  wqItem0.status = 'executed';
  wqItem0.executedOrCancelled = true;

  const nonceConsumed0: FixtureEvent = {
    family: 'NonceConsumedEvent',
    type: 'nonce_consumed',
    version: 1,
    topics: ['NonceConsumedEvent'],
    data: {
      version: 1,
      scope: 'operator',
      owner: operator.address,
      new_nonce: 2,
    },
  };
  const withdrawEvent0: FixtureEvent = {
    family: 'WithdrawEvent',
    type: 'withdraw',
    version: 1,
    topics: ['WithdrawEvent'],
    data: {
      version: 1,
      to: user0.address,
      token: nativeToken,
      amount: withdraw0.toString(),
      by: operator.address,
      ledger: 1040,
    },
  };
  const withdrawalExecuted0: FixtureEvent = {
    family: 'WithdrawalExecutedEvent',
    type: 'withdrawal_executed',
    version: 1,
    topics: ['WithdrawalExecutedEvent'],
    data: {
      version: 1,
      request_id: reqId0,
      to: user0.address,
      amount: withdraw0.toString(),
      nonce: 1,
    },
  };

  const l1040Events = [nonceConsumed0, withdrawEvent0, withdrawalExecuted0];
  l1040Events.forEach((e) => emit(1040, e));
  ledgers.push(mkLedger(1040, l1040Events));
  currentLedger = 1040;

  // ── Ledger 1050: User2 deposits 2 000 XLM ─────────────────────────────
  const deposit2 = 2_000_000_000n;
  const receipt2 = hexString(new SeededRandom(`${seed}:receipt:2`), 32);
  const memo2 = hexString(new SeededRandom(`${seed}:memo:2`), 32);
  deposited[nativeToken] = (deposited[nativeToken] ?? 0n) + deposit2;
  const feePct2 = 20_000_000n;
  fees[nativeToken] = (fees[nativeToken] ?? 0n) + feePct2;

  const depositEvent2: FixtureEvent = {
    family: 'DepositEvent',
    type: 'deposit',
    version: 1,
    topics: ['DepositEvent'],
    data: {
      version: 1,
      from: user2.address,
      token: nativeToken,
      amount: deposit2.toString(),
      receipt_id: receipt2,
      by: user2.address,
      ledger: 1050,
    },
  };
  const receiptIssued2: FixtureEvent = {
    family: 'ReceiptIssuedEvent',
    type: 'receipt_issued',
    version: 1,
    topics: ['ReceiptIssuedEvent'],
    data: { version: 1, receipt_id: receipt2, memo_hash: memo2 },
  };
  const feeAccrued2: FixtureEvent = {
    family: 'FeeAccruedEvent',
    type: 'fee_accrued',
    version: 1,
    topics: ['FeeAccruedEvent'],
    data: { version: 1, token: nativeToken, amount: feePct2.toString() },
  };

  const l1050Events = [depositEvent2, receiptIssued2, feeAccrued2];
  l1050Events.forEach((e) => emit(1050, e));
  ledgers.push(mkLedger(1050, l1050Events));
  currentLedger = 1050;

  // ── Ledger 1060: User1 requests withdrawal of 100 XLM (will be cancelled) ─
  requestIdCounter++;
  const reqId1 = requestIdCounter;
  const withdraw1 = 100_000_000n;

  const wqItem1: WithdrawalQueueItem & { executedOrCancelled: boolean } = {
    requestId: reqId1,
    ledger: 1060,
    amount: withdraw1.toString(),
    token: nativeToken,
    to: user1.address,
    status: 'pending' as WithdrawalStatus,
    executedOrCancelled: false,
  };
  queueItems.set(reqId1, wqItem1);

  const withdrawalRequested1: FixtureEvent = {
    family: 'WithdrawalRequestedEvent',
    type: 'withdrawal_requested',
    version: 1,
    topics: ['WithdrawalRequestedEvent'],
    data: {
      version: 1,
      to: user1.address,
      request_id: reqId1,
      amount: withdraw1.toString(),
      token: nativeToken,
      memo_hash: null,
    },
  };

  const l1060Events = [withdrawalRequested1];
  l1060Events.forEach((e) => emit(1060, e));
  ledgers.push(mkLedger(1060, l1060Events));
  currentLedger = 1060;

  // ── Ledger 1070: Admin cancels user1's withdrawal (edge case) ─────────
  wqItem1.status = 'cancelled';
  wqItem1.executedOrCancelled = true;

  const withdrawalCancelled1: FixtureEvent = {
    family: 'WithdrawalCancelledEvent',
    type: 'withdrawal_cancelled',
    version: 1,
    topics: ['WithdrawalCancelledEvent'],
    data: { version: 1, request_id: reqId1 },
  };

  const l1070Events = [withdrawalCancelled1];
  l1070Events.forEach((e) => emit(1070, e));
  ledgers.push(mkLedger(1070, l1070Events));
  currentLedger = 1070;

  // ── Ledger 1080: User2 requests withdrawal of 500 XLM (will expire) ───
  requestIdCounter++;
  const reqId2 = requestIdCounter;
  const withdraw2 = 500_000_000n;

  const wqItem2: WithdrawalQueueItem & { executedOrCancelled: boolean } = {
    requestId: reqId2,
    ledger: 1080,
    amount: withdraw2.toString(),
    token: nativeToken,
    to: user2.address,
    status: 'pending' as WithdrawalStatus,
    executedOrCancelled: false,
  };
  queueItems.set(reqId2, wqItem2);

  const withdrawalRequested2: FixtureEvent = {
    family: 'WithdrawalRequestedEvent',
    type: 'withdrawal_requested',
    version: 1,
    topics: ['WithdrawalRequestedEvent'],
    data: {
      version: 1,
      to: user2.address,
      request_id: reqId2,
      amount: withdraw2.toString(),
      token: nativeToken,
      memo_hash: null,
    },
  };

  const l1080Events = [withdrawalRequested2];
  l1080Events.forEach((e) => emit(1080, e));
  ledgers.push(mkLedger(1080, l1080Events));
  currentLedger = 1080;

  // ── Ledger 1090: Withdrawal expires (passed timelock) ─────────────────
  wqItem2.status = 'expired';
  wqItem2.executedOrCancelled = true;

  const withdrawalExpired2: FixtureEvent = {
    family: 'WithdrawalExpiredEvent',
    type: 'withdrawal_expired',
    version: 1,
    topics: ['WithdrawalExpiredEvent'],
    data: {
      version: 1,
      request_id: reqId2,
      to: user2.address,
      amount: withdraw2.toString(),
      queued_ledger: 1080,
    },
  };

  const l1090Events = [withdrawalExpired2];
  l1090Events.forEach((e) => emit(1090, e));
  ledgers.push(mkLedger(1090, l1090Events));
  currentLedger = 1090;

  // ── Ledger 1100: Admin withdraws fees ─────────────────────────────────
  const totalFees = (fees[nativeToken] ?? 0n);
  fees[nativeToken] = 0n;

  const feeWithdrawn: FixtureEvent = {
    family: 'FeeWithdrawnEvent',
    type: 'fee_withdrawn',
    version: 1,
    topics: ['FeeWithdrawnEvent'],
    data: {
      version: 1,
      to: admin.address,
      amount: totalFees.toString(),
      token: nativeToken,
    },
  };

  const l1100Events = [feeWithdrawn];
  l1100Events.forEach((e) => emit(1100, e));
  ledgers.push(mkLedger(1100, l1100Events));
  currentLedger = 1100;

  // ── Ledger 1110: Admin refunds user0 (boundary: full refund) ──────────
  const refundAmount = deposit0;
  refunded[nativeToken] = (refunded[nativeToken] ?? 0n) + refundAmount;
  // Refunds reduce total deposited from the perspective of escrow solvency
  deposited[nativeToken] = (deposited[nativeToken] ?? 0n) - refundAmount;

  const refundEvent: FixtureEvent = {
    family: 'RefundEvent',
    type: 'refund',
    version: 1,
    topics: ['RefundEvent'],
    data: {
      version: 1,
      receipt_id: receipt0,
      to: user0.address,
      amount: refundAmount.toString(),
    },
  };

  const l1110Events = [refundEvent];
  l1110Events.forEach((e) => emit(1110, e));
  ledgers.push(mkLedger(1110, l1110Events));
  currentLedger = 1110;

  // ── Ledger 1120: Pause (admin) ────────────────────────────────────────
  paused = true;
  const pausedEvent: FixtureEvent = {
    family: 'PausedEvent',
    type: 'paused',
    version: 1,
    topics: ['PausedEvent'],
    data: { version: 1, by: admin.address },
  };

  const l1120Events = [pausedEvent];
  l1120Events.forEach((e) => emit(1120, e));
  ledgers.push(mkLedger(1120, l1120Events));
  currentLedger = 1120;

  // ── Ledger 1130: Unpause ───────────────────────────────────────────────
  paused = false;
  const unpausedEvent: FixtureEvent = {
    family: 'UnpausedEvent',
    type: 'unpaused',
    version: 1,
    topics: ['UnpausedEvent'],
    data: { version: 1, by: admin.address },
  };

  const l1130Events = [unpausedEvent];
  l1130Events.forEach((e) => emit(1130, e));
  ledgers.push(mkLedger(1130, l1130Events));
  currentLedger = 1130;

  // ── Ledger 1140: Upgrade proposed ─────────────────────────────────────
  const wasmHash = hexString(new SeededRandom(`${seed}:wasm`), 32);
  const upgProposedEvent: FixtureEvent = {
    family: 'upg_prop',
    type: 'upgrade_proposed',
    version: 1,
    topics: [1, 'upg_prop'],
    data: { version: 1, wasm_hash: wasmHash, executable_after: 1200 },
  };

  const l1140Events = [upgProposedEvent];
  l1140Events.forEach((e) => emit(1140, e));
  ledgers.push(mkLedger(1140, l1140Events));
  currentLedger = 1140;

  // ── Ledger 1150: Upgrade executed ─────────────────────────────────────
  const upgExecutedEvent: FixtureEvent = {
    family: 'upg_exec',
    type: 'upgrade_executed',
    version: 1,
    topics: [1, 'upg_exec'],
    data: { version: 1, wasm_hash: wasmHash },
  };

  // ── Ledger 1150: Multisig proposed ────────────────────────────────────
  const multisigProposedEvent: FixtureEvent = {
    family: 'multisig_proposed',
    type: 'multisig_proposed',
    version: 1,
    topics: [1, 'multisig_proposed'],
    data: { version: 1, id: 1 },
  };

  // ── Ledger 1150: Circuit breaker (boundary: large deposit near threshold) ─
  const circuitAmount = 10_000_000_000n;
  const circuitThreshold = 8_000_000_000n;
  const circuitEvent: FixtureEvent = {
    family: 'CircuitBreakerTrippedEvent',
    type: 'circuit_breaker_tripped',
    version: 1,
    topics: ['CircuitBreakerTrippedEvent'],
    data: {
      version: 1,
      new_total: circuitAmount.toString(),
      threshold: circuitThreshold.toString(),
    },
  };

  const l1150Events = [upgExecutedEvent, multisigProposedEvent, circuitEvent];
  l1150Events.forEach((e) => emit(1150, e));
  ledgers.push(mkLedger(1150, l1150Events));
  currentLedger = 1150;

  // ── Ledger 1160: User0 deposits 300 XLM (pending queue at tip) ────────
  const deposit3 = 300_000_000n;
  const receipt3 = hexString(new SeededRandom(`${seed}:receipt:3`), 32);
  const memo3 = hexString(new SeededRandom(`${seed}:memo:3`), 32);
  deposited[nativeToken] = (deposited[nativeToken] ?? 0n) + deposit3;
  const feePct3 = 3_000_000n;
  fees[nativeToken] = (fees[nativeToken] ?? 0n) + feePct3;

  const depositEvent3: FixtureEvent = {
    family: 'DepositEvent',
    type: 'deposit',
    version: 1,
    topics: ['DepositEvent'],
    data: {
      version: 1,
      from: user0.address,
      token: nativeToken,
      amount: deposit3.toString(),
      receipt_id: receipt3,
      by: user0.address,
      ledger: 1160,
    },
  };
  const receiptIssued3: FixtureEvent = {
    family: 'ReceiptIssuedEvent',
    type: 'receipt_issued',
    version: 1,
    topics: ['ReceiptIssuedEvent'],
    data: { version: 1, receipt_id: receipt3, memo_hash: memo3 },
  };
  const feeAccrued3: FixtureEvent = {
    family: 'FeeAccruedEvent',
    type: 'fee_accrued',
    version: 1,
    topics: ['FeeAccruedEvent'],
    data: { version: 1, token: nativeToken, amount: feePct3.toString() },
  };

  const l1160Events = [depositEvent3, receiptIssued3, feeAccrued3];
  l1160Events.forEach((e) => emit(1160, e));
  ledgers.push(mkLedger(1160, l1160Events));
  currentLedger = 1160;

  // ── Ledger 1170: Pending withdrawal at tip (open queue item) ──────────
  requestIdCounter++;
  const reqId3 = requestIdCounter;
  const withdraw3 = 150_000_000n;

  const wqItem3: WithdrawalQueueItem & { executedOrCancelled: boolean } = {
    requestId: reqId3,
    ledger: 1170,
    amount: withdraw3.toString(),
    token: nativeToken,
    to: user1.address,
    status: 'pending' as WithdrawalStatus,
    executedOrCancelled: false,
  };
  queueItems.set(reqId3, wqItem3);

  const withdrawalRequested3: FixtureEvent = {
    family: 'WithdrawalRequestedEvent',
    type: 'withdrawal_requested',
    version: 1,
    topics: ['WithdrawalRequestedEvent'],
    data: {
      version: 1,
      to: user1.address,
      request_id: reqId3,
      amount: withdraw3.toString(),
      token: nativeToken,
      memo_hash: null,
    },
  };

  const l1170Events = [withdrawalRequested3];
  l1170Events.forEach((e) => emit(1170, e));
  ledgers.push(mkLedger(1170, l1170Events));
  currentLedger = 1170;

  // ─── Compute final contract state ─────────────────────────────────────
  const pendingQueue = [...queueItems.values()].filter(
    (q) => !q.executedOrCancelled,
  ) as WithdrawalQueueItem[];

  const totalDep = deposited[nativeToken] ?? 0n;
  const totalWit = withdrawn[nativeToken] ?? 0n;
  const netDep = totalDep - totalWit;
  const bal = netDep; // simplification: contract balance = net deposited
  const accruedFees = fees[nativeToken] ?? 0n;

  const wqOldestLedger = pendingQueue.length > 0
    ? Math.min(...pendingQueue.map((q) => q.ledger))
    : null;
  const wqOldestAge = wqOldestLedger !== null
    ? currentLedger - wqOldestLedger
    : null;

  const contractState: ContractState = {
    contractId,
    nativeToken,
    admin: admin.address,
    totalDeposited: { [nativeToken]: totalDep.toString() },
    totalWithdrawn: { [nativeToken]: totalWit.toString() },
    totalRefunded: { [nativeToken]: (refunded[nativeToken] ?? 0n).toString() },
    netDeposited: { [nativeToken]: netDep.toString() },
    balance: { [nativeToken]: bal.toString() },
    accruedFees: { [nativeToken]: accruedFees.toString() },
    withdrawalQueue: [...queueItems.values()],
    limits: { [nativeToken]: (limits[nativeToken] ?? 0n).toString() },
    operators: [...operators],
    paused,
    wqDepth: pendingQueue.length,
    wqOldestQueuedLedger: wqOldestLedger,
    wqOldestAgeLedgers: wqOldestAge,
    currentLedger,
  };

  void rng; // rng used in provider section; silences unused-var warning

  return { ledgers, allEvents, contractEvents, contractState };
}

// ─── Provider responses ───────────────────────────────────────────────────

function buildProviderResponses(
  seed: string,
  _rng: SeededRandom,
  wallets: WalletIdentity[],
): ProviderResponses {
  void _rng;

  // Deterministic account numbers derived from seed (not real user data)
  const acc0Num = '0123456789'; // pinned — matches FakePayoutProvider defaults
  const acc1Num = '0987654321'; // pinned — matches FakePayoutProvider defaults
  const acc2Num = nuban(new SeededRandom(`${seed}:nuban:2`));
  const bc0 = '058'; // GTBank — pinned
  const bc1 = '011'; // First Bank — pinned
  const bc2 = bankCode(new SeededRandom(`${seed}:bankcode:2`));

  const accounts: SeededBankAccount[] = [
    { accountNumber: acc0Num, bankCode: bc0, accountName: 'John Doe', bankId: 58 },
    { accountNumber: acc1Num, bankCode: bc1, accountName: 'Jane Smith', bankId: 11 },
    {
      accountNumber: acc2Num,
      bankCode: bc2,
      accountName: `${wallets[2]!.label} Fixture`,
      bankId: parseInt(bc2, 10),
    },
  ];

  // Deterministic recipient codes (mirror FakePayoutProvider.hashCode logic)
  function hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }

  const recipients: SeededRecipient[] = accounts.map((acc) => ({
    recipientCode: `RCP_fake_${Math.abs(hashCode(`${acc.accountNumber}:${acc.bankCode}`))}`,
    name: acc.accountName,
    accountNumber: acc.accountNumber,
    bankCode: acc.bankCode,
    currency: 'NGN',
    type: 'nuban',
  }));

  // Deterministic transfer references
  const ref0 = `TXF_${hexString(new SeededRandom(`${seed}:txref:0`), 8)}`;
  const ref1 = `TXF_${hexString(new SeededRandom(`${seed}:txref:1`), 8)}`;

  const transfers: SeededTransfer[] = [
    {
      reference: ref0,
      transferCode: `TRF_${hexString(new SeededRandom(`${seed}:trfcode:0`), 8)}`,
      amountMinor: 150_000_00, // 150 000 kobo = 1 500 NGN
      currency: 'NGN',
      status: 'success',
      recipient: recipients[0]!.recipientCode,
    },
    {
      reference: ref1,
      transferCode: `TRF_${hexString(new SeededRandom(`${seed}:trfcode:1`), 8)}`,
      amountMinor: 50_000_00, // 50 000 kobo = 500 NGN
      currency: 'NGN',
      status: 'pending',
      recipient: recipients[1]!.recipientCode,
    },
  ];

  const acc = accounts[0]!;
  const rec = recipients[0]!;
  const trn = transfers[0]!;

  // ── Normal-path raw Paystack envelopes ───────────────────────────────
  const paystackEnvelopes: ProviderResponses['paystackEnvelopes'] = {
    resolveAccount: {
      status: true,
      message: 'Account resolved',
      data: {
        account_number: acc.accountNumber,
        account_name: acc.accountName,
        bank_id: acc.bankId,
      },
    },
    createRecipient: {
      status: true,
      message: 'Recipient created',
      data: {
        recipient_code: rec.recipientCode,
        name: rec.name,
        details: { account_number: acc.accountNumber, bank_code: acc.bankCode },
        currency: 'NGN',
        type: 'nuban',
      },
    },
    initiateTransfer: {
      status: true,
      message: 'Transfer initiated',
      data: {
        reference: trn.reference,
        status: 'pending',
        transfer_code: trn.transferCode,
        amount: trn.amountMinor,
        currency: 'NGN',
        recipient: rec.recipientCode,
      },
    },
    verifyTransfer: {
      status: true,
      data: {
        reference: trn.reference,
        status: 'success',
        transfer_code: trn.transferCode,
        amount: trn.amountMinor,
        currency: 'NGN',
      },
    },
  };

  // ── App-route-level success responses ────────────────────────────────
  const appRouteResponses: ProviderResponses['appRouteResponses'] = {
    verifyAccount: {
      success: true,
      data: {
        account_number: acc.accountNumber,
        account_name: acc.accountName,
        bank_id: acc.bankId,
      },
    },
    createRecipient: {
      success: true,
      data: {
        recipient_code: rec.recipientCode,
        name: rec.name,
        reused: false,
      },
    },
    initiateTransfer: {
      success: true,
      data: {
        reference: trn.reference,
        status: 'pending',
        transfer_code: trn.transferCode,
        amount: trn.amountMinor,
        currency: 'NGN',
        recipient: rec.recipientCode,
      },
    },
    transferStatus: {
      success: true,
      data: {
        reference: trn.reference,
        status: 'success',
        transfer_code: trn.transferCode,
        amount: trn.amountMinor.toString(),
        currency: 'NGN',
      },
    },
  };

  // ── Failure / edge cases ──────────────────────────────────────────────
  function failureCase(
    scenario: string,
    httpStatus: number,
    code: string,
    retryable: boolean,
    providerMsg: string,
    appRouteResponse: Record<string, unknown>,
  ): ProviderFailureCase {
    return {
      scenario,
      httpStatus,
      code,
      retryable,
      axiosRejection: {
        isAxiosError: true,
        response: { status: httpStatus, data: { message: providerMsg } },
      },
      providerError: { code, statusCode: httpStatus, retryable, message: providerMsg },
      appRouteResponse,
    };
  }

  const failures: ProviderResponses['failures'] = {
    invalidAccount: failureCase(
      'invalidAccount',
      422,
      'INVALID_ACCOUNT',
      false,
      'Could not resolve account name',
      { success: false, error: 'PAYOUT_REJECTED', message: 'Could not resolve account name' },
    ),
    accountNotFound: failureCase(
      'accountNotFound',
      404,
      'ACCOUNT_NOT_FOUND',
      false,
      'Account not found',
      { success: false, error: 'PAYOUT_REJECTED', message: 'Account not found' },
    ),
    rateLimited: failureCase(
      'rateLimited',
      429,
      'RATE_LIMITED',
      true,
      'Too many requests',
      { success: false, error: 'PROVIDER_OUTAGE', message: 'Too many requests' },
    ),
    insufficientFunds: failureCase(
      'insufficientFunds',
      400,
      'INSUFFICIENT_FUNDS',
      false,
      'Insufficient balance to complete transfer',
      {
        success: false,
        error: 'PAYOUT_REJECTED',
        message: 'Insufficient balance to complete transfer',
      },
    ),
    providerOutage: failureCase(
      'providerOutage',
      503,
      'PROVIDER_UNAVAILABLE',
      true,
      'Paystack service unavailable',
      {
        success: false,
        error: 'PROVIDER_OUTAGE',
        message: 'Paystack service unavailable',
        retryAfter: 30,
      },
    ),
    authenticationError: failureCase(
      'authenticationError',
      401,
      'AUTHENTICATION_ERROR',
      false,
      'Invalid API credentials',
      { success: false, error: 'PAYOUT_REJECTED', message: 'Invalid API credentials' },
    ),
  };

  return {
    banks: KNOWN_BANKS,
    accounts,
    recipients,
    transfers,
    paystackEnvelopes,
    appRouteResponses,
    failures,
  };
}

// ─── Soroban RPC mocks ────────────────────────────────────────────────────

function buildRpcMocks(
  adminAddress: string,
  contractId: string,
  contractState: ContractState,
): SorobanRpcMocks {
  const latestLedger = contractState.currentLedger;

  // Build ScVal XDR for common simulate results
  const adminXdr = addressScValXdr(adminAddress);
  const totalDep = BigInt(contractState.totalDeposited[contractState.nativeToken] ?? '0');
  const netDep = BigInt(contractState.netDeposited[contractState.nativeToken] ?? '0');
  const accFees = BigInt(contractState.accruedFees[contractState.nativeToken] ?? '0');
  const limit = BigInt(contractState.limits[contractState.nativeToken] ?? '0');

  const simulate: Record<string, { xdr: string }> = {
    get_admin: { xdr: adminXdr },
    get_balance: { xdr: i128ScValXdr(netDep) },
    get_total_deposited: { xdr: i128ScValXdr(totalDep) },
    get_limit: { xdr: i128ScValXdr(limit) },
    get_accrued_fees: { xdr: i128ScValXdr(accFees) },
    get_wq_depth: { xdr: i128ScValXdr(BigInt(contractState.wqDepth)) },
    // fallback for unknown function names
    _default: { xdr: i128ScValXdr(0n) },
  };

  const baseRpc = (id: number | string = 1) => ({ jsonrpc: '2.0' as const, id });

  return {
    latestLedger,
    networkPassphrase: 'Test SDF Network ; September 2015',
    getLatestLedger: {
      ...baseRpc(),
      result: { sequence: latestLedger, protocolVersion: 22 },
    },
    getNetwork: {
      ...baseRpc(),
      result: { passphrase: 'Test SDF Network ; September 2015' },
    },
    getAccount: {
      ...baseRpc(),
      result: {
        id: adminAddress,
        sequence: `${latestLedger * 10000}`,
        balances: [
          {
            balance: '9999.0000000',
            asset_type: 'native',
            buying_liabilities: '0.0000000',
            selling_liabilities: '0.0000000',
          },
        ],
      },
    },
    sendTransaction: {
      ...baseRpc(),
      result: {
        status: 'SUCCESS',
        results: [{ xdr: 'AAAAAAAAAGQAAAAAAAAAAQ==' }],
        cost: { cpuInsns: '0', memBytes: '0' },
        latestLedger,
        latestLedgerCloseTime: String(Math.floor(Date.now() / 1000)),
      },
    },
    simulate,
  };

  void contractId;
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Generate a deterministic full-stack fixture from `seed`.
 *
 * The same seed always produces the same fixture. Use different seeds to
 * exercise different scenarios without coupling tests to each other.
 *
 * @param seed  An arbitrary non-empty string.  For reproducibility use short,
 *              stable identifiers like `'default'`, `'ci-run'`, `'issue-268'`.
 */
export function generateFixture(seed: string): FullStackFixture {
  if (!seed || typeof seed !== 'string') {
    throw new TypeError('generateFixture: seed must be a non-empty string');
  }

  const rng = new SeededRandom(seed);

  // 1. Wallets — no secret keys, just valid-format G… addresses
  const wallets = generateWallets(seed, rng);
  const admin = wallets.find((w) => w.role === 'admin')!;

  // 2. Contract/token identifiers — deterministic from seed
  const contractId = deriveContractId(seed, 'contract', 0);
  const nativeToken = deriveContractId(seed, 'token', 0);

  // 3. Ledger history + contract state
  const { ledgers, allEvents, contractEvents, contractState } =
    buildLedgerHistory(seed, rng, wallets, contractId, nativeToken);

  // 4. Provider responses
  const provider = buildProviderResponses(seed, rng, wallets);

  // 5. RPC mocks
  const rpc = buildRpcMocks(admin.address, contractId, contractState);

  // Pinned generation timestamp — deterministic, never reads wall clock
  const generatedAt = new Date(1_700_000_000_000).toISOString();

  return {
    schemaVersion: FULLSTACK_FIXTURE_SCHEMA_VERSION,
    seed,
    generatedAt,
    wallets,
    ledgerHistory: ledgers,
    events: allEvents,
    contractEvents,
    contractState,
    provider,
    rpc,
  };
}

/** Default fixture used when no specific seed is required. */
export const DEFAULT_SEED = 'stellar-dex-fixture-v1' as const;

/** The pre-generated default fixture (eagerly evaluated so it's cheap to import). */
export const defaultFixture: FullStackFixture = generateFixture(DEFAULT_SEED);
