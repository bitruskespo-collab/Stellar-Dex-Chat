import crypto from 'crypto';
import { DEFAULT_FIXTURE_SEED, SeededRandom } from './seededRandom';

export const SYNTHETIC_MARKER = 'synthetic-fixture';

export const SYNTHETIC_WALLETS = {
  alice: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  bob: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  bridgeAdmin: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  operator: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
} as const;

export const SYNTHETIC_CONTRACTS = {
  fiatBridge: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  token: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
} as const;

export type SyntheticWallet = {
  label: string;
  publicKey: string;
  network: 'testnet';
  synthetic: true;
};

export type SyntheticBankAccount = {
  provider: 'fake';
  country: 'nigeria' | 'ghana' | 'kenya' | 'south-africa';
  bankCode: string;
  accountNumber: string;
  accountName: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  synthetic: true;
};

export type SyntheticWebhookEvent = {
  event: 'transfer.success' | 'transfer.failed' | 'transfer.reversed';
  data: {
    id: string;
    reference: string;
    amount: number;
    recipient: string;
    status: string;
    failure_reason?: string;
  };
  synthetic: true;
};

export type SyntheticPayout = {
  reference: string;
  idempotencyKey: string;
  recipientCode: string;
  amount: string;
  amountMinor: string;
  currency: 'NGN';
  status: 'pending' | 'success' | 'failed' | 'reversed';
  accountNumber: string;
  bankCode: string;
  synthetic: true;
};

const BANK_FIXTURE_SPECS: ReadonlyArray<{
  country: SyntheticBankAccount['country'];
  currency: SyntheticBankAccount['currency'];
  bankCode: string;
  accountLength: number;
  name: string;
}> = [
  { country: 'nigeria', currency: 'NGN', bankCode: '058', accountLength: 10, name: 'Ada Synthetic' },
  { country: 'ghana', currency: 'GHS', bankCode: 'GH001', accountLength: 12, name: 'Kojo Synthetic' },
  { country: 'kenya', currency: 'KES', bankCode: 'KCB01', accountLength: 11, name: 'Amina Synthetic' },
  { country: 'south-africa', currency: 'ZAR', bankCode: '632005', accountLength: 10, name: 'Lerato Synthetic' },
];

function syntheticAccountNumber(rng: SeededRandom, length: number): string {
  if (length <= 3) return rng.digits(length);
  return `000${rng.digits(length - 3)}`; // obvious non-production prefix
}

export function createSyntheticWalletFixtures(seed = DEFAULT_FIXTURE_SEED): SyntheticWallet[] {
  const labels = ['alice', 'bob', 'operator', 'treasury'] as const;
  const keys = Object.values(SYNTHETIC_WALLETS);
  return labels.map((label, i) => ({
    label,
    publicKey: keys[i] ?? keys[0],
    network: 'testnet' as const,
    synthetic: true as const,
  }));
}

export function createSyntheticBankFixtures(seed = DEFAULT_FIXTURE_SEED): SyntheticBankAccount[] {
  const rng = new SeededRandom(seed ^ 0x42414e4b);
  return BANK_FIXTURE_SPECS.map((spec) => ({
    provider: 'fake' as const,
    country: spec.country,
    bankCode: spec.bankCode,
    accountNumber: syntheticAccountNumber(rng, spec.accountLength),
    accountName: spec.name,
    currency: spec.currency,
    synthetic: true as const,
  }));
}

export function getSyntheticBankFixture(
  country: SyntheticBankAccount['country'],
  seed = DEFAULT_FIXTURE_SEED,
): SyntheticBankAccount {
  const fixture = createSyntheticBankFixtures(seed).find((f) => f.country === country);
  if (!fixture) throw new Error(`No synthetic bank fixture for country: ${country}`);
  return fixture;
}

export function createSyntheticPayoutFixtures(seed = DEFAULT_FIXTURE_SEED): SyntheticPayout[] {
  const rng = new SeededRandom(seed ^ 0x5041594f);
  const statuses: SyntheticPayout['status'][] = ['pending', 'success', 'failed', 'reversed'];
  const bank = getSyntheticBankFixture('nigeria', seed);
  return statuses.map((status, i) => {
    const amountMinor = (10000n + BigInt(i) * 2500n).toString();
    return {
      reference: `tx_syn_${rng.hex(8)}`,
      idempotencyKey: `idem_syn_${rng.hex(8)}`,
      recipientCode: `RCP_syn_${rng.hex(6)}`,
      amount: (Number(amountMinor) / 100).toFixed(2),
      amountMinor,
      currency: 'NGN' as const,
      status,
      accountNumber: bank.accountNumber,
      bankCode: bank.bankCode,
      synthetic: true as const,
    };
  });
}

export function createSyntheticWebhookEvent(
  event: SyntheticWebhookEvent['event'],
  overrides: Partial<SyntheticWebhookEvent['data']> = {},
  seed = DEFAULT_FIXTURE_SEED,
): SyntheticWebhookEvent {
  const rng = new SeededRandom(seed ^ 0x57454248);
  const statusMap: Record<SyntheticWebhookEvent['event'], string> = {
    'transfer.success': 'success',
    'transfer.failed': 'failed',
    'transfer.reversed': 'reversed',
  };
  const base: SyntheticWebhookEvent['data'] = {
    id: `evt_syn_${rng.hex(6)}`,
    reference: `tx_syn_${rng.hex(8)}`,
    amount: 500000,
    recipient: `RCP_syn_${rng.hex(6)}`,
    status: statusMap[event],
  };
  if (event === 'transfer.failed') base.failure_reason = 'Synthetic provider decline';
  return { event, data: { ...base, ...overrides }, synthetic: true };
}

export function createSignedSyntheticWebhook(
  event: SyntheticWebhookEvent['event'],
  secret: string,
  overrides: Partial<SyntheticWebhookEvent['data']> = {},
  seed = DEFAULT_FIXTURE_SEED,
): { payload: string; signature: string; event: SyntheticWebhookEvent } {
  if (!secret || secret.trim().length === 0) throw new Error('Webhook signing secret is required');
  const webhookEvent = createSyntheticWebhookEvent(event, overrides, seed);
  const payload = JSON.stringify(webhookEvent);
  const signature = crypto.createHmac('sha512', secret).update(payload).digest('hex');
  return { payload, signature, event: webhookEvent };
}

export const SYNTHETIC_FIXTURE_DEFAULTS = {
  seed: DEFAULT_FIXTURE_SEED,
  marker: SYNTHETIC_MARKER,
  wallets: SYNTHETIC_WALLETS,
  contracts: SYNTHETIC_CONTRACTS,
} as const;
