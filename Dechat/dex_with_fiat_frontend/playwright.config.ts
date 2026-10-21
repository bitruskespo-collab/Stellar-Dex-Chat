import { defineConfig, devices } from '@playwright/test';

// Issue #126: E2E runs must never touch production networks or live money.
// Fail fast if any network/RPC configuration points at a production endpoint.
const PRODUCTION_PATTERNS = [
  /mainnet/i,
  /public\.(?:futurenet|testnet|mainnet)/i,
  /soroban\.(?:stellar\.org|public)/i,
  /horizon\.stellar\.org/i,
  /api\.stellar\.org/i,
];

const NETWORK_ENV_KEYS = [
  'SOROBAN_RPC_URL',
  'STELLAR_RPC_URL',
  'NEXT_PUBLIC_SOROBAN_RPC_URL',
  'NEXT_PUBLIC_STELLAR_RPC_URL',
  'STELLAR_NETWORK',
  'NEXT_PUBLIC_STELLAR_NETWORK',
  'PAYOUT_PROVIDER_URL',
  'NEXT_PUBLIC_PAYOUT_PROVIDER_URL',
];

function assertNonProductionConfig(): void {
  const offenders: string[] = [];
  for (const key of NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    if (PRODUCTION_PATTERNS.some((pattern) => pattern.test(value))) {
      offenders.push(`${key}=${value}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `E2E refuses to run against production network configuration: ${offenders.join(', ')}`,
    );
  }
}

assertNonProductionConfig();

// Deterministic, isolated fixtures for each run. The harness provisions a
// disposable local Soroban node + contract and a payout provider stub, and
// tears them down (even on failure) via the global setup/teardown below.
const E2E_RUN_ID = process.env.E2E_RUN_ID ?? `run-${Date.now()}`;

const e2eEnv: Record<string, string> = {
  NEXT_PUBLIC_E2E: 'true',
  E2E_RUN_ID,
  // Force local, disposable endpoints; never inherit production values.
  SOROBAN_RPC_URL: process.env.E2E_SOROBAN_RPC_URL ?? 'http://127.0.0.1:8000/soroban/rpc',
  NEXT_PUBLIC_SOROBAN_RPC_URL:
    process.env.E2E_SOROBAN_RPC_URL ?? 'http://127.0.0.1:8000/soroban/rpc',
  STELLAR_NETWORK: 'local',
  NEXT_PUBLIC_STELLAR_NETWORK: 'local',
  PAYOUT_PROVIDER_URL: process.env.E2E_PAYOUT_PROVIDER_URL ?? 'http://127.0.0.1:8787',
  NEXT_PUBLIC_PAYOUT_PROVIDER_URL:
    process.env.E2E_PAYOUT_PROVIDER_URL ?? 'http://127.0.0.1:8787',
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  reporter: process.env.CI ? [['github'], ['html']] : 'html',
  globalSetup: './tests/e2e/fixtures/global-setup.ts',
  globalTeardown: './tests/e2e/fixtures/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'amount-property',
      testDir: './tests/property',
      testMatch: /amount.*\.(spec|test)\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'accessibility',
      testDir: './tests/a11y',
      testMatch: /.*\.(spec|test)\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.CI ? 'npx next start' : 'npx next dev --turbopack',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: e2eEnv,
  },
});
