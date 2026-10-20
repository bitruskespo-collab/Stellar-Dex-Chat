import type { Meta, StoryObj } from '@storybook/react';
import { TransactionProgressBar } from './TransactionProgressBar';

/**
 * Storybook stories for transaction_progress_bar
 * Illustrating all UI states: idle, wallet_signing, submitting, confirming_on_chain,
 * provider_dispatch, settled, failed, retryable_error, and read_only_outage.
 */
const meta: Meta<typeof TransactionProgressBar> = {
  title: 'Components/transaction_progress_bar',
  component: TransactionProgressBar,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof TransactionProgressBar>;

export const Idle: Story = {
  args: {
    currentStep: 'idle',
    progressPercent: 0,
    title: 'Idle State',
  },
};

export const WalletSigning: Story = {
  args: {
    currentStep: 'wallet_signing',
    progressPercent: 20,
    title: 'Wallet Signing State',
  },
};

export const Submitting: Story = {
  args: {
    currentStep: 'submitting',
    progressPercent: 40,
    title: 'Submitting State',
  },
};

export const ConfirmingOnChain: Story = {
  args: {
    currentStep: 'confirming_on_chain',
    progressPercent: 65,
    title: 'Confirming On-Chain State',
  },
};

export const ProviderDispatch: Story = {
  args: {
    currentStep: 'provider_dispatch',
    progressPercent: 85,
    title: 'Provider Dispatch State',
  },
};

export const SettledSuccess: Story = {
  args: {
    currentStep: 'settled',
    progressPercent: 100,
    title: 'Settled Success State',
  },
};

export const TerminalFailure: Story = {
  args: {
    currentStep: 'failed',
    progressPercent: 50,
    title: 'Terminal Failure State',
    errorMessage: 'Terminal rejection from payout provider.',
  },
};

export const RetryableError: Story = {
  args: {
    currentStep: 'retryable_error',
    progressPercent: 40,
    title: 'Retryable Error State',
    errorMessage: 'RPC rate limited. Safe retry available.',
  },
};

export const ReadOnlyOutage: Story = {
  args: {
    currentStep: 'read_only_outage',
    progressPercent: 10,
    title: 'Degraded Read-Only Outage State',
    errorMessage: 'Safe inspection mode active; writes blocked.',
  },
};
