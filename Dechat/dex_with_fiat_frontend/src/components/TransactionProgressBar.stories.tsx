import type { Meta, StoryObj } from '@storybook/react';
import { TransactionProgressBar } from './TransactionProgressBar';

/**
 * Storybook configuration for TransactionProgressBar
 * Illustrating all UI states across the transaction lifecycle.
 */
const meta: Meta<typeof TransactionProgressBar> = {
  title: 'Components/TransactionProgressBar',
  component: TransactionProgressBar,
  tags: ['autodocs'],
  argTypes: {
    currentStep: {
      control: { type: 'select' },
      options: [
        'idle',
        'wallet_signing',
        'submitting',
        'confirming_on_chain',
        'provider_dispatch',
        'settled',
        'failed',
        'retryable_error',
        'read_only_outage',
      ],
    },
    progressPercent: {
      control: { type: 'range', min: 0, max: 100, step: 5 },
    },
    onRetry: { action: 'retried' },
    onCancel: { action: 'cancelled' },
  },
};

export default meta;
type Story = StoryObj<typeof TransactionProgressBar>;

// 1. Idle state
export const Idle: Story = {
  args: {
    currentStep: 'idle',
    progressPercent: 0,
    title: 'Deposit Transaction',
  },
};

// 2. Waiting for Wallet Signature
export const WalletSigning: Story = {
  args: {
    currentStep: 'wallet_signing',
    progressPercent: 20,
    title: 'Freighter Approval',
  },
};

// 3. Submitting to RPC
export const SubmittingToRPC: Story = {
  args: {
    currentStep: 'submitting',
    progressPercent: 40,
    title: 'RPC Submission',
  },
};

// 4. Confirming on Soroban Ledger
export const ConfirmingOnChain: Story = {
  args: {
    currentStep: 'confirming_on_chain',
    progressPercent: 65,
    title: 'Consensus Confirmation',
  },
};

// 5. Provider Dispatch
export const ProviderDispatch: Story = {
  args: {
    currentStep: 'provider_dispatch',
    progressPercent: 85,
    title: 'Fiat Payout Dispatch',
  },
};

// 6. Fully Settled (Success)
export const Settled: Story = {
  args: {
    currentStep: 'settled',
    progressPercent: 100,
    title: 'Transaction Complete',
  },
};

// 7. Terminal Failure
export const TerminalFailure: Story = {
  args: {
    currentStep: 'failed',
    progressPercent: 50,
    title: 'Contract Error (1002)',
    errorMessage: 'Account unauthorized or denied by security policy.',
  },
};

// 8. Retryable Error (e.g. Nonce drift or network timeout)
export const RetryableError: Story = {
  args: {
    currentStep: 'retryable_error',
    progressPercent: 40,
    title: 'Transient RPC Timeout',
    errorMessage: 'Network timeout reached during submission. Safe to retry.',
  },
};

// 9. Read-Only Outage Mode
export const ReadOnlyOutage: Story = {
  args: {
    currentStep: 'read_only_outage',
    progressPercent: 15,
    title: 'RPC Outage Active',
    errorMessage: 'Soroban RPC connectivity lost. Safe inspection active; writes paused.',
  },
};
