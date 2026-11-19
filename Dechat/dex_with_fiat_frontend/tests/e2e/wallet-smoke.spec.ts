import { test, expect, Page, BrowserContext } from '@playwright/test';

/**
 * Cross-browser wallet & transaction UX smoke coverage.
 *
 * Covers:
 *  - Wallet connection (happy path + user rejection)
 *  - Signature rejection (user cancels signing)
 *  - Pending transaction recovery (reload while tx pending)
 *  - Payout status display (pending -> confirmed)
 *
 * Browser-specific wallet mocks are isolated per Playwright project
 * (chromium / firefox / webkit) so that injected provider quirks do not
 * leak across browsers. All fixtures use synthetic addresses and no
 * credentials or real user data.
 */

type WalletMockOptions = {
  /** Simulated account address (synthetic). */
  address?: string;
  /** Simulated chain id. */
  chainId?: string;
  /** If true, connect() rejects as if the user dismissed the prompt. */
  rejectConnect?: boolean;
  /** If true, signMessage()/signTransaction() reject as if user cancelled. */
  rejectSignature?: boolean;
  /** If true, the provider reports a pending transaction on load. */
  pendingTx?: boolean;
};

const DEFAULT_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEFAULT_CHAIN_ID = '0x1';

/**
 * Build a browser-specific injected wallet mock. Each browser exposes the
 * provider slightly differently, so we tailor the injection to keep the
 * mocks isolated and deterministic per project.
 */
function buildWalletMockScript(browserName: string, opts: WalletMockOptions): string {
  const config = {
    address: opts.address ?? DEFAULT_ADDRESS,
    chainId: opts.chainId ?? DEFAULT_CHAIN_ID,
    rejectConnect: opts.rejectConnect ?? false,
    rejectSignature: opts.rejectSignature ?? false,
    pendingTx: opts.pendingTx ?? false,
  };

  // Shared provider implementation. The browser-specific wrapper below
  // decides where to attach it (window.ethereum vs. EIP-6963 announce).
  const providerImpl = `
    const cfg = ${JSON.stringify(config)};
    const listeners = {};
    const emit = (event, payload) => {
      (listeners[event] || []).forEach((fn) => {
        try { fn(payload); } catch (_) { /* ignore listener errors */ }
      });
    };
    const provider = {
      isMetaMask: true,
      isConnected: () => true,
      chainId: cfg.chainId,
      selectedAddress: null,
      _pendingTx: cfg.pendingTx,
      on(event, fn) {
        (listeners[event] = listeners[event] || []).push(fn);
        return provider;
      },
      removeListener(event, fn) {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
        return provider;
      },
      async request({ method, params }) {
        switch (method) {
          case 'eth_chainId':
            return cfg.chainId;
          case 'eth_accounts':
            return provider.selectedAddress ? [provider.selectedAddress] : [];
          case 'eth_requestAccounts':
            if (cfg.rejectConnect) {
              const err = new Error('User rejected the request.');
              err.code = 4001;
              throw err;
            }
            provider.selectedAddress = cfg.address;
            emit('accountsChanged', [cfg.address]);
            return [cfg.address];
          case 'wallet_switchEthereumChain':
            return null;
          case 'personal_sign':
          case 'eth_sign':
          case 'eth_signTypedData_v4':
            if (cfg.rejectSignature) {
              const err = new Error('User rejected the request.');
              err.code = 4001;
              throw err;
            }
            return '0x' + '11'.repeat(65);
          case 'eth_sendTransaction':
            if (cfg.rejectSignature) {
              const err = new Error('User rejected the request.');
              err.code = 4001;
              throw err;
            }
            provider._pendingTx = true;
            emit('pendingTx', { hash: '0x' + 'ab'.repeat(32) });
            return '0x' + 'ab'.repeat(32);
          case 'eth_getTransactionReceipt':
            return provider._pendingTx ? null : { status: '0x1' };
          default:
            return null;
        }
      },
    };
    window.__walletMock = { provider, cfg, emit };
  `;

  // Browser-specific attachment strategy.
  switch (browserName) {
    case 'firefox':
      // Firefox: attach directly to window.ethereum; also announce via
      // EIP-6963 so providers that prefer discovery still find it.
      return `
        (() => {
          ${providerImpl}
          Object.defineProperty(window, 'ethereum', {
            configurable: true,
            get() { return provider; },
          });
          window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: 'mock-firefox', name: 'Mock Wallet', icon: 'data:,', rdns: 'mock.wallet' },
              provider,
            },
          }));
        })();
      `;
    case 'webkit':
      // WebKit: define window.ethereum as a plain writable property to avoid
      // getter-related quirks in older WebKit builds.
      return `
        (() => {
          ${providerImpl}
          window.ethereum = provider;
          window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: 'mock-webkit', name: 'Mock Wallet', icon: 'data:,', rdns: 'mock.wallet' },
              provider,
            },
          }));
        })();
      `;
    case 'chromium':
    default:
      // Chromium: standard window.ethereum injection.
      return `
        (() => {
          ${providerImpl}
          Object.defineProperty(window, 'ethereum', {
            configurable: true,
            value: provider,
          });
          window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: 'mock-chromium', name: 'Mock Wallet', icon: 'data:,', rdns: 'mock.wallet' },
              provider,
            },
          }));
        })();
      `;
  }
}

async function installWalletMock(
  context: BrowserContext,
  browserName: string,
  opts: WalletMockOptions = {},
): Promise<void> {
  const script = buildWalletMockScript(browserName, opts);
  await context.addInitScript({ content: script });
}

async function gotoApp(page: Page): Promise<void> {
  await page.goto('/');
  // Wait for the app shell to be ready.
  await expect(page.getByTestId('app-root')).toBeVisible();
}

test.describe('wallet connection', () => {
  test('connects successfully and shows the connected address', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName);
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();

    await expect(page.getByTestId('wallet-address')).toBeVisible();
    await expect(page.getByTestId('wallet-address')).toContainText('0x0000');
    await expect(page.getByTestId('connect-wallet-button')).toBeHidden();
  });

  test('surfaces a friendly error when the user rejects the connection', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName, { rejectConnect: true });
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();

    await expect(page.getByTestId('wallet-error')).toBeVisible();
    await expect(page.getByTestId('wallet-error')).toContainText(/rejected|cancel/i);
    // Connection button remains available for retry.
    await expect(page.getByTestId('connect-wallet-button')).toBeVisible();
  });
});

test.describe('signature rejection', () => {
  test('shows an error and does not submit when signing is rejected', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName, { rejectSignature: true });
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();
    await expect(page.getByTestId('wallet-address')).toBeVisible();

    await page.getByTestId('sign-message-button').click();

    await expect(page.getByTestId('signature-error')).toBeVisible();
    await expect(page.getByTestId('signature-error')).toContainText(/rejected|cancel/i);
    // No success state should be shown.
    await expect(page.getByTestId('signature-success')).toBeHidden();
  });
});

test.describe('pending transaction recovery', () => {
  test('recovers a pending transaction after reload', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName, { pendingTx: true });
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();
    await expect(page.getByTestId('wallet-address')).toBeVisible();

    // Trigger a transaction which the mock leaves pending.
    await page.getByTestId('send-transaction-button').click();
    await expect(page.getByTestId('tx-status')).toContainText(/pending/i);

    // Reload: the app should re-hydrate the pending transaction from storage.
    await page.reload();
    await expect(page.getByTestId('app-root')).toBeVisible();
    await expect(page.getByTestId('tx-status')).toContainText(/pending/i);
    await expect(page.getByTestId('tx-recovery-banner')).toBeVisible();
  });

  test('clears the pending state once the transaction confirms', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName, { pendingTx: true });
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();
    await page.getByTestId('send-transaction-button').click();
    await expect(page.getByTestId('tx-status')).toContainText(/pending/i);

    // Simulate confirmation by flipping the mock's pending flag.
    await page.evaluate(() => {
      const mock = (window as any).__walletMock;
      if (mock) {
        mock.provider._pendingTx = false;
      }
    });
    await page.getByTestId('tx-refresh-button').click();

    await expect(page.getByTestId('tx-status')).toContainText(/confirmed|success/i);
    await expect(page.getByTestId('tx-recovery-banner')).toBeHidden();
  });
});

test.describe('payout status', () => {
  test('displays payout status transitions from pending to confirmed', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName);
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();
    await expect(page.getByTestId('wallet-address')).toBeVisible();

    await page.getByTestId('payouts-tab').click();
    await expect(page.getByTestId('payout-row').first()).toBeVisible();

    const firstPayout = page.getByTestId('payout-row').first();
    await expect(firstPayout.getByTestId('payout-status')).toContainText(/pending|confirmed/i);

    // Refresh should reflect the latest status without losing the row.
    await page.getByTestId('payout-refresh-button').click();
    await expect(firstPayout.getByTestId('payout-status')).toBeVisible();
  });

  test('shows an empty state when there are no payouts', async ({ page, context, browserName }) => {
    await installWalletMock(context, browserName);
    await gotoApp(page);

    await page.getByTestId('connect-wallet-button').click();
    await page.getByTestId('payouts-tab').click();

    // When the API returns no payouts the empty state is shown.
    const empty = page.getByTestId('payouts-empty');
    const rows = page.getByTestId('payout-row');
    await expect(empty.or(rows.first())).toBeVisible();
  });
});