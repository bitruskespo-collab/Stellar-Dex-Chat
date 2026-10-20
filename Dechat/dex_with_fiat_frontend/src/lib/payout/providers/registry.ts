import type { PayoutProvider, PayoutProviderName } from './types';
import { paystackProvider } from './paystackProvider';
import { fakePayoutProvider } from './fakeProvider';
import { serverEnv as env } from '@/lib/serverEnv';

const providers: Record<PayoutProviderName, PayoutProvider> = {
  paystack: paystackProvider,
  fake: fakePayoutProvider,
};

let overrideProvider: PayoutProvider | null = null;

export function registerPayoutProvider(
  name: PayoutProviderName,
  provider: PayoutProvider,
): void {
  providers[name] = provider;
}

export function setPayoutProviderForTesting(
  provider: PayoutProvider | null,
): void {
  overrideProvider = provider;
}

export function getPayoutProvider(name?: string): PayoutProvider {
  if (overrideProvider) {
    return overrideProvider;
  }

  const providerName = (name ||
    env.PAYOUT_PROVIDER ||
    'paystack') as PayoutProviderName;

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Unsupported payout provider: ${providerName}`);
  }

  return provider;
}
