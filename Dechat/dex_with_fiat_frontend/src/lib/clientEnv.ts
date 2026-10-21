import { z } from 'zod';

export const formatErrors = (
  errors: z.ZodFormattedError<Map<string, string>, string>,
) =>
  Object.entries(errors)
    .map(([name, value]) => {
      if (value && '_errors' in value && value._errors.length) {
        return `${name}: ${value._errors.join(', ')}`;
      }
      return null;
    })
    .filter(Boolean)
    .join('\n');

export const clientSchema = z.object({
  NEXT_PUBLIC_FIAT_BRIDGE_CONTRACT: z
    .string()
    .default('CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR'),
  NEXT_PUBLIC_XLM_SAC_CONTRACT: z
    .string()
    .default('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
  NEXT_PUBLIC_STELLAR_RPC_URL: z
    .string()
    .url()
    .default('https://soroban-testnet.stellar.org'),
  NEXT_PUBLIC_STELLAR_NETWORK: z.string().default('TESTNET'),
  NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE: z
    .string()
    .default('Test SDF Network ; September 2015'),
  NEXT_PUBLIC_STELLAR_HORIZON_URL: z
    .string()
    .url()
    .optional(),
  NEXT_PUBLIC_SENTRY_DSN: z
    .string()
    .url()
    .optional(),
});

const processClientEnvVars = () => {
  const clientVars = {
    NEXT_PUBLIC_FIAT_BRIDGE_CONTRACT:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_FIAT_BRIDGE_CONTRACT : undefined,
    NEXT_PUBLIC_XLM_SAC_CONTRACT:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_XLM_SAC_CONTRACT : undefined,
    NEXT_PUBLIC_STELLAR_RPC_URL:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_STELLAR_RPC_URL : undefined,
    NEXT_PUBLIC_STELLAR_NETWORK:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_STELLAR_NETWORK : undefined,
    NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE : undefined,
    NEXT_PUBLIC_STELLAR_HORIZON_URL:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL : undefined,
    NEXT_PUBLIC_SENTRY_DSN:
      typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_SENTRY_DSN : undefined,
  };

  const parsed = clientSchema.safeParse(clientVars);

  if (!parsed.success) {
    console.error(
      '❌ Invalid client environment variables:\n',
      formatErrors(parsed.error.format()),
    );
    throw new Error('Invalid client environment variables');
  }

  return parsed.data;
};

export const clientEnv = processClientEnvVars();

export interface StellarDeploymentConfig {
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl?: string;
  contractId: string;
  xlmSacId: string;
}

export function getStellarDeploymentConfig(): StellarDeploymentConfig {
  return {
    network: clientEnv.NEXT_PUBLIC_STELLAR_NETWORK,
    networkPassphrase: clientEnv.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
    rpcUrl: clientEnv.NEXT_PUBLIC_STELLAR_RPC_URL,
    horizonUrl: clientEnv.NEXT_PUBLIC_STELLAR_HORIZON_URL,
    contractId: clientEnv.NEXT_PUBLIC_FIAT_BRIDGE_CONTRACT,
    xlmSacId: clientEnv.NEXT_PUBLIC_XLM_SAC_CONTRACT,
  };
}

