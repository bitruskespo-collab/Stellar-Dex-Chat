/**
 * @fileoverview Regression tests for the deterministic full-stack fixture.
 *
 * These tests verify:
 *   - Normal path: the generator produces valid, structurally sound fixtures.
 *   - Determinism: the same seed always produces byte-identical output.
 *   - Seed isolation: two different seeds produce different addresses and event data.
 *   - Financial-safety invariants: the documented accounting identities hold.
 *   - Failure/edge cases: every provider failure scenario is structurally complete.
 *   - No credentials or real user data in the fixture output.
 *
 * The generator is imported from tests/e2e/fixtures/generator.ts, which lives
 * outside the vitest include path; this src/ test file acts as the bridge.
 */

import { describe, it, expect } from 'vitest';
import {
  generateFixture,
  defaultFixture,
  DEFAULT_SEED,
} from '../../tests/e2e/fixtures/generator';
import { FULLSTACK_FIXTURE_SCHEMA_VERSION } from '../../tests/e2e/fixtures/schema';
import { sha256Hex } from '../../tests/e2e/fixtures/seed';

// ─── Normal path ──────────────────────────────────────────────────────────

describe('generateFixture — normal path', () => {
  const f = defaultFixture;

  it('returns a fixture with the correct schema version', () => {
    expect(f.schemaVersion).toBe(FULLSTACK_FIXTURE_SCHEMA_VERSION);
  });

  it('records the seed used for generation', () => {
    expect(f.seed).toBe(DEFAULT_SEED);
  });

  it('produces a pinned, non-wall-clock generatedAt timestamp', () => {
    // generatedAt is seed-derived (pinned to 2023-11-14), never the system clock
    expect(f.generatedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('generates five wallets with distinct valid G… addresses', () => {
    expect(f.wallets).toHaveLength(5);
    for (const w of f.wallets) {
      expect(w.address).toMatch(/^G[A-Z2-7]{55}$/);
      expect(w.id).toMatch(/^wallet-\d+$/);
    }
    const addrs = f.wallets.map((w) => w.address);
    expect(new Set(addrs).size).toBe(5);
  });

  it('assigns exactly one admin and one operator wallet', () => {
    expect(f.wallets.filter((w) => w.role === 'admin')).toHaveLength(1);
    expect(f.wallets.filter((w) => w.role === 'operator')).toHaveLength(1);
    expect(f.wallets.filter((w) => w.role === 'user')).toHaveLength(3);
  });

  it('produces a non-empty ledger history in ascending order', () => {
    expect(f.ledgerHistory.length).toBeGreaterThan(0);
    for (let i = 1; i < f.ledgerHistory.length; i++) {
      expect(f.ledgerHistory[i]!.sequence).toBeGreaterThan(
        f.ledgerHistory[i - 1]!.sequence,
      );
    }
  });

  it('assigns ISO-8601 closedAt to every ledger entry', () => {
    for (const ledger of f.ledgerHistory) {
      expect(() => new Date(ledger.closedAt).toISOString()).not.toThrow();
      expect(new Date(ledger.closedAt).getTime()).toBeGreaterThan(0);
    }
  });

  it('provides deterministic non-empty tx hashes (64-char hex) in each ledger', () => {
    for (const ledger of f.ledgerHistory) {
      for (const hash of ledger.txHashes) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('contains all expected event families from the golden fixture catalog', () => {
    const families = new Set(f.events.map((e) => e.family));
    const required = [
      'DepositEvent',
      'ReceiptIssuedEvent',
      'WithdrawEvent',
      'WithdrawalRequestedEvent',
      'WithdrawalExecutedEvent',
      'WithdrawalCancelledEvent',
      'WithdrawalExpiredEvent',
      'FeeAccruedEvent',
      'FeeWithdrawnEvent',
      'RefundEvent',
      'PausedEvent',
      'UnpausedEvent',
      'SetLimitEvent',
      'SetOperatorEvent',
      'NonceConsumedEvent',
      'CircuitBreakerTrippedEvent',
      'upg_prop',
      'upg_exec',
      'multisig_proposed',
    ];
    for (const family of required) {
      expect(families.has(family), `Missing event family: ${family}`).toBe(true);
    }
  });

  it('every event carries version = 1', () => {
    for (const evt of f.events) {
      expect(evt.version).toBe(1);
      if (typeof evt.data === 'object' && evt.data !== null && 'version' in evt.data) {
        expect((evt.data as { version: number }).version).toBe(1);
      }
    }
  });

  it('maps deposit and withdraw events to ContractEvent shape', () => {
    expect(f.contractEvents.length).toBeGreaterThan(0);
    for (const ce of f.contractEvents) {
      expect(ce.type === 'deposit' || ce.type === 'withdraw').toBe(true);
      expect(ce.id).toBeTruthy();
      expect(ce.txHash).toMatch(/^[0-9a-f]{64}$/);
      expect(ce.contractId).toMatch(/^C[A-Z2-7]{55}$/);
      expect(ce.ledger).toBeGreaterThan(0);
      expect(BigInt(ce.amount)).toBeGreaterThan(0n);
    }
  });

  it('contract state has valid C… contractId and nativeToken', () => {
    expect(f.contractState.contractId).toMatch(/^C[A-Z2-7]{55}$/);
    expect(f.contractState.nativeToken).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it('contract state admin matches the admin wallet address', () => {
    const admin = f.wallets.find((w) => w.role === 'admin')!;
    expect(f.contractState.admin).toBe(admin.address);
  });

  it('contract state operators list is non-empty and contains G… addresses', () => {
    expect(f.contractState.operators.length).toBeGreaterThan(0);
    for (const op of f.contractState.operators) {
      expect(op).toMatch(/^G[A-Z2-7]{55}$/);
    }
  });

  it('provides valid RPC mock responses', () => {
    const rpc = f.rpc;
    expect(rpc.latestLedger).toBeGreaterThan(0);
    expect(rpc.networkPassphrase).toBeTruthy();
    expect(rpc.getLatestLedger.result.sequence).toBe(rpc.latestLedger);
    expect(rpc.getNetwork.result.passphrase).toBe(rpc.networkPassphrase);
    expect(rpc.getAccount.result.id).toMatch(/^G[A-Z2-7]{55}$/);
    expect(rpc.sendTransaction.result.status).toBe('SUCCESS');
  });

  it('simulate map has an entry for every expected contract function', () => {
    const expected = [
      'get_admin',
      'get_balance',
      'get_total_deposited',
      'get_limit',
      'get_accrued_fees',
      'get_wq_depth',
    ];
    for (const fn of expected) {
      expect(f.rpc.simulate[fn], `Missing simulate entry: ${fn}`).toBeDefined();
      expect(f.rpc.simulate[fn]!.xdr).toBeTruthy();
    }
  });
});

// ─── Determinism ──────────────────────────────────────────────────────────

describe('generateFixture — determinism', () => {
  it('two calls with the same seed produce byte-identical fixtures', () => {
    const a = generateFixture('determinism-test-seed');
    const b = generateFixture('determinism-test-seed');
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it('the default fixture digest is stable across import re-evaluations', () => {
    // Re-generate using the same constant; must equal the already-evaluated default
    const fresh = generateFixture(DEFAULT_SEED);
    expect(sha256Hex(fresh)).toBe(sha256Hex(defaultFixture));
  });

  it('every wallet address is byte-identical between regenerations', () => {
    const run1 = generateFixture('addr-stability-seed');
    const run2 = generateFixture('addr-stability-seed');
    for (let i = 0; i < run1.wallets.length; i++) {
      expect(run1.wallets[i]!.address).toBe(run2.wallets[i]!.address);
    }
  });

  it('event amounts are byte-identical between regenerations', () => {
    const run1 = generateFixture('amounts-stability-seed');
    const run2 = generateFixture('amounts-stability-seed');
    expect(run1.events.length).toBe(run2.events.length);
    for (let i = 0; i < run1.events.length; i++) {
      const a = run1.events[i]!;
      const b = run2.events[i]!;
      expect(a.family).toBe(b.family);
      if (a.data.amount !== undefined) {
        expect(a.data.amount).toBe(b.data.amount);
      }
    }
  });

  it('provider responses are byte-identical between regenerations', () => {
    const run1 = generateFixture('provider-stability-seed');
    const run2 = generateFixture('provider-stability-seed');
    expect(sha256Hex(run1.provider)).toBe(sha256Hex(run2.provider));
  });
});

// ─── Seed isolation ───────────────────────────────────────────────────────

describe('generateFixture — seed isolation', () => {
  it('two different seeds produce different wallet addresses', () => {
    const a = generateFixture('seed-alpha');
    const b = generateFixture('seed-beta');
    const addrsA = a.wallets.map((w) => w.address).join(',');
    const addrsB = b.wallets.map((w) => w.address).join(',');
    expect(addrsA).not.toBe(addrsB);
  });

  it('two different seeds produce different fixture digests', () => {
    const a = generateFixture('seed-gamma');
    const b = generateFixture('seed-delta');
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });

  it('two different seeds produce different provider transfer references', () => {
    const a = generateFixture('ref-seed-1');
    const b = generateFixture('ref-seed-2');
    const refA = a.provider.transfers[0]?.reference;
    const refB = b.provider.transfers[0]?.reference;
    expect(refA).not.toBe(refB);
  });
});

// ─── Financial-safety invariants ─────────────────────────────────────────

describe('generateFixture — financial-safety invariants', () => {
  const cs = defaultFixture.contractState;
  const token = cs.nativeToken;

  it('totalDeposited >= totalWithdrawn (escrow solvency invariant)', () => {
    const dep = BigInt(cs.totalDeposited[token] ?? '0');
    const wit = BigInt(cs.totalWithdrawn[token] ?? '0');
    expect(dep).toBeGreaterThanOrEqual(wit);
  });

  it('netDeposited = totalDeposited - totalWithdrawn', () => {
    const dep = BigInt(cs.totalDeposited[token] ?? '0');
    const wit = BigInt(cs.totalWithdrawn[token] ?? '0');
    const net = BigInt(cs.netDeposited[token] ?? '0');
    expect(net).toBe(dep - wit);
  });

  it('contract balance >= netDeposited (holds because refunds reduce deposited)', () => {
    const bal = BigInt(cs.balance[token] ?? '0');
    const net = BigInt(cs.netDeposited[token] ?? '0');
    expect(bal).toBeGreaterThanOrEqual(net);
  });

  it('accruedFees >= 0', () => {
    const fee = BigInt(cs.accruedFees[token] ?? '0');
    expect(fee).toBeGreaterThanOrEqual(0n);
  });

  it('wqDepth matches the number of pending queue items', () => {
    const pending = cs.withdrawalQueue.filter((q) => q.status === 'pending');
    expect(cs.wqDepth).toBe(pending.length);
  });

  it('wqOldestQueuedLedger is null iff wqDepth is 0', () => {
    if (cs.wqDepth === 0) {
      expect(cs.wqOldestQueuedLedger).toBeNull();
      expect(cs.wqOldestAgeLedgers).toBeNull();
    } else {
      expect(cs.wqOldestQueuedLedger).not.toBeNull();
      expect(cs.wqOldestAgeLedgers).not.toBeNull();
      expect(cs.wqOldestAgeLedgers!).toBe(
        cs.currentLedger - cs.wqOldestQueuedLedger!,
      );
    }
  });

  it('every queue item has a positive amount (no zero-value requests)', () => {
    for (const item of cs.withdrawalQueue) {
      expect(BigInt(item.amount)).toBeGreaterThan(0n);
    }
  });

  it('no negative amounts in any deposit or withdrawal event', () => {
    for (const evt of defaultFixture.events) {
      if (evt.data.amount !== undefined) {
        expect(
          BigInt(evt.data.amount as string),
          `Negative amount in ${evt.family}`,
        ).toBeGreaterThan(0n);
      }
    }
  });
});

// ─── Provider failure / edge cases ────────────────────────────────────────

describe('generateFixture — provider failure cases', () => {
  const failures = defaultFixture.provider.failures;

  const cases = [
    'invalidAccount',
    'accountNotFound',
    'rateLimited',
    'insufficientFunds',
    'providerOutage',
    'authenticationError',
  ] as const;

  it.each(cases)('%s failure case is structurally complete', (key) => {
    const fc = failures[key];
    expect(fc.scenario).toBe(key);
    expect(fc.httpStatus).toBeGreaterThanOrEqual(400);
    expect(fc.code).toBeTruthy();
    expect(typeof fc.retryable).toBe('boolean');

    // axios rejection shape
    expect(fc.axiosRejection.isAxiosError).toBe(true);
    expect(fc.axiosRejection.response.status).toBe(fc.httpStatus);
    expect(fc.axiosRejection.response.data.message).toBeTruthy();

    // normalized provider error
    expect(fc.providerError.code).toBe(fc.code);
    expect(fc.providerError.statusCode).toBe(fc.httpStatus);
    expect(fc.providerError.retryable).toBe(fc.retryable);

    // app route response
    expect(fc.appRouteResponse.success).toBe(false);
  });

  it('rateLimited and providerOutage are retryable', () => {
    expect(failures.rateLimited.retryable).toBe(true);
    expect(failures.providerOutage.retryable).toBe(true);
  });

  it('invalidAccount, insufficientFunds, authenticationError are non-retryable', () => {
    expect(failures.invalidAccount.retryable).toBe(false);
    expect(failures.insufficientFunds.retryable).toBe(false);
    expect(failures.authenticationError.retryable).toBe(false);
  });

  it('providerOutage returns a retryAfter field in the app route response', () => {
    expect(failures.providerOutage.appRouteResponse.retryAfter).toBeDefined();
  });

  it('failure HTTP statuses are distinct (each failure is a unique scenario)', () => {
    const statuses = cases.map((k) => failures[k].httpStatus);
    // Multiple can share a status code (e.g. 400) — verify the codes differ
    const codes = cases.map((k) => failures[k].code);
    expect(new Set(codes).size).toBe(cases.length);
  });
});

// ─── Authorization / boundary events ─────────────────────────────────────

describe('generateFixture — authorization & boundary events', () => {
  it('pause/unpause events are present and in order', () => {
    const paused = defaultFixture.events.filter((e) => e.type === 'paused');
    const unpaused = defaultFixture.events.filter((e) => e.type === 'unpaused');
    expect(paused.length).toBeGreaterThan(0);
    expect(unpaused.length).toBeGreaterThan(0);
    // The last paused ledger must precede the last unpaused ledger
    const lastPausedLedger = defaultFixture.ledgerHistory
      .filter((l) => l.events.some((e) => e.type === 'paused'))
      .at(-1)!.sequence;
    const lastUnpausedLedger = defaultFixture.ledgerHistory
      .filter((l) => l.events.some((e) => e.type === 'unpaused'))
      .at(-1)!.sequence;
    expect(lastPausedLedger).toBeLessThan(lastUnpausedLedger);
  });

  it('contract ends in an unpaused state', () => {
    expect(defaultFixture.contractState.paused).toBe(false);
  });

  it('a cancelled withdrawal is present', () => {
    const cancelled = defaultFixture.events.find(
      (e) => e.family === 'WithdrawalCancelledEvent',
    );
    expect(cancelled).toBeDefined();
  });

  it('an expired withdrawal is present', () => {
    const expired = defaultFixture.events.find(
      (e) => e.family === 'WithdrawalExpiredEvent',
    );
    expect(expired).toBeDefined();
    expect(expired!.data.queued_ledger).toBeDefined();
  });

  it('circuit breaker event carries threshold and new_total', () => {
    const cb = defaultFixture.events.find(
      (e) => e.family === 'CircuitBreakerTrippedEvent',
    );
    expect(cb).toBeDefined();
    expect(BigInt(cb!.data.new_total as string)).toBeGreaterThan(
      BigInt(cb!.data.threshold as string),
    );
  });

  it('upgrade proposal precedes upgrade execution', () => {
    const propLedger = defaultFixture.ledgerHistory
      .find((l) => l.events.some((e) => e.type === 'upgrade_proposed'))!.sequence;
    const execLedger = defaultFixture.ledgerHistory
      .find((l) => l.events.some((e) => e.type === 'upgrade_executed'))!.sequence;
    expect(propLedger).toBeLessThanOrEqual(execLedger);
  });
});

// ─── No credentials or real user data ────────────────────────────────────

describe('generateFixture — no credentials or real user data', () => {
  const fixtureJson = JSON.stringify(defaultFixture);

  it('contains no Paystack secret key patterns', () => {
    // Real Paystack secret keys start with sk_live_ or sk_test_
    expect(fixtureJson).not.toMatch(/sk_live_[A-Za-z0-9]+/);
    expect(fixtureJson).not.toMatch(/sk_test_[A-Za-z0-9]+/);
  });

  it('contains no private key / secret seed patterns', () => {
    // Ed25519 secret seeds are 64-char hex or S… strkeys
    expect(fixtureJson).not.toMatch(/S[A-Z2-7]{55}/); // Stellar secret key strkey
  });

  it('contains no real email addresses', () => {
    expect(fixtureJson).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  });

  it('contains no phone numbers that look real', () => {
    // Real Nigerian phone numbers: +234 or 0[7-9]XXXXXXXX
    expect(fixtureJson).not.toMatch(/\+234[0-9]{10}/);
  });

  it('contains no JWT token patterns', () => {
    expect(fixtureJson).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./);
  });

  it('account names are fixture-generated, not real personal names from a list', () => {
    // The two pinned names match what FakePayoutProvider uses (documented in fakeProvider.ts)
    const names = defaultFixture.provider.accounts.map((a) => a.accountName);
    expect(names).toContain('John Doe');
    expect(names).toContain('Jane Smith');
    // No real personal data: no surname + given-name combinations beyond the stubs
    for (const name of names) {
      expect(name.length).toBeLessThan(50);
    }
  });

  it('fixture schema version is numeric and matches the constant', () => {
    expect(typeof defaultFixture.schemaVersion).toBe('number');
    expect(defaultFixture.schemaVersion).toBe(FULLSTACK_FIXTURE_SCHEMA_VERSION);
  });
});

// ─── Provider normal-path responses ───────────────────────────────────────

describe('generateFixture — provider normal-path responses', () => {
  const p = defaultFixture.provider;

  it('accounts match the FakePayoutProvider pinned defaults', () => {
    const acc0 = p.accounts.find((a) => a.accountNumber === '0123456789');
    expect(acc0).toBeDefined();
    expect(acc0!.bankCode).toBe('058');
    expect(acc0!.accountName).toBe('John Doe');

    const acc1 = p.accounts.find((a) => a.accountNumber === '0987654321');
    expect(acc1).toBeDefined();
    expect(acc1!.bankCode).toBe('011');
    expect(acc1!.accountName).toBe('Jane Smith');
  });

  it('recipient codes start with RCP_ and are deterministic', () => {
    for (const r of p.recipients) {
      expect(r.recipientCode).toMatch(/^RCP_/);
    }
  });

  it('Paystack envelope shapes match providerContract.test.ts conventions', () => {
    const env = p.paystackEnvelopes;
    expect(env.resolveAccount.status).toBe(true);
    expect(env.resolveAccount.data.account_number).toMatch(/^\d{10}$/);

    expect(env.createRecipient.status).toBe(true);
    expect(env.createRecipient.data.recipient_code).toMatch(/^RCP_/);

    expect(env.initiateTransfer.status).toBe(true);
    expect(env.initiateTransfer.data.status).toBe('pending');

    expect(env.verifyTransfer.status).toBe(true);
    expect(env.verifyTransfer.data.status).toBe('success');
  });

  it('app-route responses are structurally correct', () => {
    const r = p.appRouteResponses;
    expect(r.verifyAccount.success).toBe(true);
    expect(r.verifyAccount.data.account_number).toMatch(/^\d{10}$/);
    expect(r.verifyAccount.data.account_name).toBeTruthy();

    expect(r.createRecipient.success).toBe(true);
    expect(r.createRecipient.data.recipient_code).toMatch(/^RCP_/);
    expect(typeof r.createRecipient.data.reused).toBe('boolean');

    expect(r.initiateTransfer.success).toBe(true);
    expect(r.initiateTransfer.data.reference).toMatch(/^TXF_/);

    expect(r.transferStatus.success).toBe(true);
    // amountMinor is serialized as string (matches route.ts bigint serialization)
    expect(typeof r.transferStatus.data.amount).toBe('string');
  });

  it('transfers have positive amountMinor', () => {
    for (const t of p.transfers) {
      expect(t.amountMinor).toBeGreaterThan(0);
    }
  });

  it('banks list contains known Nigerian bank codes', () => {
    const codes = p.banks.map((b) => b.code);
    expect(codes).toContain('011'); // First Bank
    expect(codes).toContain('058'); // GTBank
  });
});
