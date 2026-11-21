import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIXTURE_SEED,
  SeededRandom,
  assertJsonFixtureIsSafe,
  createSignedSyntheticWebhook,
  createSyntheticBankFixtures,
  createSyntheticPayoutFixtures,
  createSyntheticWalletFixtures,
  createSyntheticWebhookEvent,
  getSyntheticBankFixture,
  scanTextForPrivacyViolations,
} from './index';

describe('deterministic synthetic fixtures (#276)', () => {
  it('produces deterministic seeded random sequences', () => {
    const a = new SeededRandom(DEFAULT_FIXTURE_SEED);
    const b = new SeededRandom(DEFAULT_FIXTURE_SEED);
    const seqA = Array.from({ length: 8 }, () => a.int(0, 1000));
    const seqB = Array.from({ length: 8 }, () => b.int(0, 1000));
    expect(seqA).toEqual(seqB);
  });

  it('generates stable wallet/bank/webhook/payout fixtures for same seed', () => {
    expect(createSyntheticWalletFixtures(42)).toEqual(createSyntheticWalletFixtures(42));
    expect(createSyntheticBankFixtures(42)).toEqual(createSyntheticBankFixtures(42));
    expect(createSyntheticPayoutFixtures(42)).toEqual(createSyntheticPayoutFixtures(42));
    expect(createSyntheticWebhookEvent('transfer.success', {}, 42)).toEqual(
      createSyntheticWebhookEvent('transfer.success', {}, 42),
    );
  });

  it('covers bank/webhook/payout boundary and failure shapes', () => {
    const ng = getSyntheticBankFixture('nigeria');
    expect(ng.accountNumber).toMatch(/^000\d{7}$/);
    expect(ng.bankCode).toBe('058');

    const failed = createSyntheticWebhookEvent('transfer.failed', { reference: 'tx_syn_fixed' }, 7);
    expect(failed.data.status).toBe('failed');
    expect(failed.data.failure_reason).toBeTruthy();
    expect(failed.synthetic).toBe(true);

    const payouts = createSyntheticPayoutFixtures(7);
    expect(payouts.map((p) => p.status)).toEqual(['pending', 'success', 'failed', 'reversed']);
    expect(payouts.every((p) => p.synthetic)).toBe(true);
  });

  it('creates signed synthetic webhooks with deterministic payload/signature', () => {
    const secret = 'sk_test_synthetic_webhook_secret';
    const a = createSignedSyntheticWebhook('transfer.success', secret, { reference: 'tx_syn_1' }, 9);
    const b = createSignedSyntheticWebhook('transfer.success', secret, { reference: 'tx_syn_1' }, 9);
    expect(a.payload).toBe(b.payload);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[a-f0-9]{128}$/);
  });
});

describe('fixture privacy guard (#276)', () => {
  it('rejects live credentials and private key material', () => {
    const liveKey = ['sk', 'live', 'realkey123456789'].join('_');
    const privateBlock = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const violations = scanTextForPrivacyViolations(`
      PAYSTACK_SECRET_KEY=${liveKey}
      ${privateBlock}
    `);
    expect(violations.some((v) => v.reason.includes('Live Paystack'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('Private key'))).toBe(true);
  });

  it('rejects non-synthetic sensitive assignments', () => {
    const value = ['prod', 'abc12345678'].join('_');
    const violations = scanTextForPrivacyViolations(`api_key="${value}"`);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain('Sensitive assignment');
  });

  it('allows synthetic/test markers and public stellar identifiers', () => {
    const safe = {
      api_key: 'test_fixture_key',
      wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      secret: 'sk_test_123',
    };
    expect(() => assertJsonFixtureIsSafe(safe, 'safe-fixture')).not.toThrow();
  });

  it('asserts generated synthetic fixtures contain no production identifiers', () => {
    const bundle = {
      wallets: createSyntheticWalletFixtures(),
      banks: createSyntheticBankFixtures(),
      payouts: createSyntheticPayoutFixtures(),
      webhook: createSyntheticWebhookEvent('transfer.reversed', {}, 5),
    };
    expect(() => assertJsonFixtureIsSafe(bundle, 'synthetic-bundle')).not.toThrow();
  });
});
