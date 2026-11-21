import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const freighter = vi.hoisted(() => ({
  isConnected: vi.fn(),
  isAllowed: vi.fn(),
  setAllowed: vi.fn(),
  getAddress: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => freighter);

import { StellarWalletProvider, useStellarWallet } from '../StellarWalletContext';

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <StellarWalletProvider>{children}</StellarWalletProvider>
);

describe('Freighter-mocked transitions (#273)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    freighter.isConnected.mockResolvedValue({ isConnected: true });
    freighter.isAllowed.mockResolvedValue({ isAllowed: true });
    freighter.setAllowed.mockResolvedValue({ isAllowed: true });
    freighter.getAddress.mockResolvedValue({ address: ADDR_A });
    freighter.getNetwork.mockResolvedValue({
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    freighter.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED' });
  });

  it('blocks signing when account changes during confirmation/signing', async () => {
    const { result } = renderHook(() => useStellarWallet(), { wrapper });
    await act(async () => { await result.current.connect(); });

    freighter.getAddress.mockResolvedValue({ address: ADDR_B });
    await expect(
      result.current.signTx('XDR', { address: ADDR_A, networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).rejects.toThrow('WALLET_CONTEXT_CHANGED');
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it('blocks signing when network switches to wrong network before write', async () => {
    const { result } = renderHook(() => useStellarWallet(), { wrapper });
    await act(async () => { await result.current.connect(); });

    freighter.getNetwork.mockResolvedValue({
      network: 'PUBLIC',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    await expect(
      result.current.signTx('XDR', { address: ADDR_A, networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).rejects.toThrow('WALLET_CONTEXT_CHANGED');
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it('clears account-scoped pending UI state on disconnect', async () => {
    localStorage.setItem(`stellar_pending_tx_TESTNET_${ADDR_A}`, JSON.stringify({ hash: 'h' }));
    localStorage.setItem('stellar_pending_tx', JSON.stringify({ hash: 'h', account: ADDR_A }));
    const { result } = renderHook(() => useStellarWallet(), { wrapper });
    await act(async () => { await result.current.connect(); });

    act(() => { result.current.disconnect(); });

    expect(localStorage.getItem(`stellar_pending_tx_TESTNET_${ADDR_A}`)).toBeNull();
    expect(localStorage.getItem('stellar_pending_tx')).toBeNull();
    expect(result.current.connection.isConnected).toBe(false);
  });
});
