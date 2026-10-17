import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import StellarFiatModal from '../StellarFiatModal';

const mockDepositToContract = vi.fn();
const mockWithdrawFromContract = vi.fn();
const mockVerifyNetworkAndContractIdentity = vi.fn();
const mockCheckTransactionStatus = vi.fn();
const mockPollTransaction = vi.fn();
const mockSignTx = vi.fn();
const mockRefetchStats = vi.fn().mockResolvedValue(undefined);
const mockRefreshXlmBalance = vi.fn().mockResolvedValue(undefined);

const TEST_ACCOUNT_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TEST_ACCOUNT_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

let currentWalletAddress = TEST_ACCOUNT_A;
let currentNetworkPassphrase = 'Test SDF Network ; September 2015';

vi.mock('@/lib/stellarContract', () => ({
  BRIDGE_LIMIT_WARNING_PERCENT: 80,
  CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  depositToContract: (...args: unknown[]) => mockDepositToContract(...args),
  withdrawFromContract: (...args: unknown[]) => mockWithdrawFromContract(...args),
  verifyNetworkAndContractIdentity: (...args: unknown[]) =>
    mockVerifyNetworkAndContractIdentity(...args),
  checkTransactionStatus: (...args: unknown[]) => mockCheckTransactionStatus(...args),
  pollTransaction: (...args: unknown[]) => mockPollTransaction(...args),
  clearCache: vi.fn(),
  simulateDeposit: vi.fn().mockResolvedValue(null),
  simulateWithdraw: vi.fn().mockResolvedValue(null),
  getStellarDeploymentConfig: vi.fn().mockReturnValue({
    network: 'TESTNET',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    xlmSacId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  }),
}));

vi.mock('@/contexts/StellarWalletContext', () => ({
  useStellarWallet: () => ({
    connection: {
      isConnected: true,
      publicKey: currentWalletAddress,
      address: currentWalletAddress,
      network: 'TESTNET',
      networkPassphrase: currentNetworkPassphrase,
    },
    signTx: (...args: unknown[]) => mockSignTx(...args),
    xlmBalance: '100.0',
    refreshXlmBalance: mockRefreshXlmBalance,
    contextVersion: 1,
  }),
}));

vi.mock('@/hooks/useBridgeStats', () => ({
  default: () => ({
    limit: 100_000_000_000n,
    loading: false,
    error: null,
    refetchStats: mockRefetchStats,
  }),
}));

vi.mock('@/lib/cryptoPriceService', () => ({
  getTokenPriceWithStatus: vi.fn().mockResolvedValue({
    price: 0.12,
    stale: false,
    source: 'live',
  }),
  formatFiatAmount: vi.fn().mockReturnValue('$1.20'),
}));

vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({ addNotification: vi.fn() }),
}));

vi.mock('@/hooks/useTxHistory', () => ({
  useTxHistory: () => ({
    addEntry: vi.fn(),
    entries: [],
    clearEntries: vi.fn(),
    updateEntry: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAccessibleModal', () => ({
  useAccessibleModal: () => undefined,
}));

vi.mock('@/lib/receipt', () => ({
  downloadReceipt: vi.fn(),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({
    fiatCurrency: 'usd',
    currencySymbol: '$',
    highValueThreshold: 500,
    twoFactorEnabled: false,
  }),
}));

vi.mock('@/hooks/useIdempotentAction', () => ({
  useIdempotentAction: () => ({
    execute: async (fn: (key: string) => Promise<void>) => {
      await fn('test-key');
    },
    isProcessing: false,
  }),
}));

describe('StellarFiatModal Issues Integration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    currentWalletAddress = TEST_ACCOUNT_A;
    currentNetworkPassphrase = 'Test SDF Network ; September 2015';
    mockPollTransaction.mockResolvedValue('HASHPOLL');
    mockVerifyNetworkAndContractIdentity.mockResolvedValue({ isValid: true });
  });

  afterEach(() => {
    cleanup();
  });

  describe('Issue #56: Network and contract identity verification before writes', () => {
    it('displays env mismatch banner and disables submit when identity verification fails', async () => {
      mockVerifyNetworkAndContractIdentity.mockResolvedValue({
        isValid: false,
        reason: 'CONTRACT_NOT_FOUND',
        message: 'Contract not deployed on this network.',
        recoveryGuidance: 'Deploy the contract or configure the correct contract ID.',
      });

      render(<StellarFiatModal isOpen={true} onClose={vi.fn()} defaultAmount="10" />);

      await waitFor(() => {
        expect(screen.getByTestId('env-mismatch-banner')).toBeInTheDocument();
      });

      expect(screen.getByText('Contract not deployed on this network.')).toBeInTheDocument();
      expect(screen.getByText(/Deploy the contract/)).toBeInTheDocument();

      const submitBtn = screen.getByRole('button', { name: /Deposit/i });
      expect(submitBtn).toBeDisabled();
    });
  });

  describe('Issue #54: Detect wallet context changes during signing', () => {
    it('shows recoverable message and rebuild button when context changes during signing', async () => {
      mockDepositToContract.mockImplementation(async (_pubKey, _stroops, signFn) => {
        // Trigger signing, which fails because wallet context switched
        await signFn('MOCK_XDR');
      });
      mockSignTx.mockRejectedValue(
        new Error('WALLET_CONTEXT_CHANGED: Freighter account changed prior to signing.'),
      );

      render(<StellarFiatModal isOpen={true} onClose={vi.fn()} defaultAmount="10" />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Deposit/i })).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Deposit/i }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('context-changed-view')).toBeInTheDocument();
      });

      expect(screen.getByTestId('recoverable-context-message')).toBeInTheDocument();

      const rebuildBtn = screen.getByTestId('confirm-rebuild-button');
      expect(rebuildBtn).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(rebuildBtn);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('context-changed-view')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Deposit/i })).toBeInTheDocument();
      });
    });
  });

  describe('Issue #57: Transaction replacement and safe retry semantics', () => {
    it('handles confirmation timeout with authoritative status query and duplicate-risk confirmation', async () => {
      mockDepositToContract.mockImplementation(
        async (_pubKey, _stroops, _signFn, onHashKnown) => {
          onHashKnown('HASH_TIMEOUT_123');
          throw new Error('Transaction confirmation timed out after 20 attempts');
        },
      );

      render(<StellarFiatModal isOpen={true} onClose={vi.fn()} defaultAmount="10" />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Deposit/i })).not.toBeDisabled();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Deposit/i }));
      });

      await waitFor(() => {
        expect(screen.getByTestId('timeout-view')).toBeInTheDocument();
      });

      expect(screen.getByText('HASH_TIMEOUT_123')).toBeInTheDocument();

      // Query authoritative status button
      const checkStatusBtn = screen.getByTestId('check-status-button');
      mockCheckTransactionStatus.mockResolvedValueOnce({
        status: 'not_found',
        hash: 'HASH_TIMEOUT_123',
      });

      await act(async () => {
        fireEvent.click(checkStatusBtn);
      });

      await waitFor(() => {
        expect(screen.getByTestId('status-outcome')).toBeInTheDocument();
      });

      expect(screen.getByText(/not_found/i)).toBeInTheDocument();

      // Replacement button must be disabled until duplicate-risk checkbox is checked
      const replacementBtn = screen.getByTestId('confirm-replacement-button');
      expect(replacementBtn).toBeDisabled();

      const checkbox = screen.getByTestId('duplicate-risk-checkbox');
      await act(async () => {
        fireEvent.click(checkbox);
      });

      expect(replacementBtn).not.toBeDisabled();

      // Confirm replacement clears timeout state
      await act(async () => {
        fireEvent.click(replacementBtn);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('timeout-view')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Deposit/i })).toBeInTheDocument();
      });
    });
  });

  describe('Issue #58: Multi-account session state isolation', () => {
    it('does not display pending transaction from another account', async () => {
      // Store pending tx for Account B
      const pendingKeyB = `stellar_pending_tx_TESTNET_${TEST_ACCOUNT_B}`;
      localStorage.setItem(
        pendingKeyB,
        JSON.stringify({
          hash: 'HASH_ACCOUNT_B',
          amount: '50',
          isAdminMode: false,
          recipient: '',
          account: TEST_ACCOUNT_B,
          network: 'TESTNET',
        }),
      );

      // Connected as Account A
      currentWalletAddress = TEST_ACCOUNT_A;

      render(<StellarFiatModal isOpen={true} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Deposit/i })).toBeInTheDocument();
      });

      // Should NOT be showing loading or timeout state for Account B's tx
      expect(screen.queryByTestId('timeout-view')).not.toBeInTheDocument();
      expect(screen.queryByText('HASH_ACCOUNT_B')).not.toBeInTheDocument();
    });
  });
});
