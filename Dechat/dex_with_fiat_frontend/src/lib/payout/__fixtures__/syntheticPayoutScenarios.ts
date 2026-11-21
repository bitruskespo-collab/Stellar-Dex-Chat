import {
  createSyntheticBankFixtures,
  createSyntheticPayoutFixtures,
  createSyntheticWebhookEvent,
  getSyntheticBankFixture,
} from '@/lib/fixtures';

export const SYNTHETIC_PAYOUT_SEED = 20260321;

export const syntheticBankFixtures = createSyntheticBankFixtures(SYNTHETIC_PAYOUT_SEED);
export const syntheticNgnBank = getSyntheticBankFixture('nigeria', SYNTHETIC_PAYOUT_SEED);
export const syntheticPayoutFixtures = createSyntheticPayoutFixtures(SYNTHETIC_PAYOUT_SEED);

export const syntheticWebhookFixtures = {
  success: createSyntheticWebhookEvent('transfer.success', { reference: 'tx_syn_success' }, SYNTHETIC_PAYOUT_SEED),
  failed: createSyntheticWebhookEvent('transfer.failed', { reference: 'tx_syn_failed' }, SYNTHETIC_PAYOUT_SEED),
  reversed: createSyntheticWebhookEvent('transfer.reversed', { reference: 'tx_syn_reversed' }, SYNTHETIC_PAYOUT_SEED),
} as const;
