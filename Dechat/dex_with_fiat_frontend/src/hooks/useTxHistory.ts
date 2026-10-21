'use client';

import { useSyncExternalStore } from 'react';
import { TransactionHistoryEntry } from '@/types';
import { useStellarWallet } from '@/contexts/StellarWalletContext';

const BASE_TX_HISTORY_KEY = 'stellar_tx_history';

class TxHistoryStore {
  private entries: TransactionHistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private storageKey: string;

  constructor(scope: string) {
    this.storageKey = `${BASE_TX_HISTORY_KEY}_${scope}`;
    if (typeof window === 'undefined') {
      return;
    }

    let stored = localStorage.getItem(this.storageKey);
    // Backward compatibility for unscoped storage if scope is anonymous
    if (!stored && scope.endsWith('_anonymous')) {
      stored = localStorage.getItem(BASE_TX_HISTORY_KEY);
    }
    if (!stored) {
      return;
    }

    try {
      const parsed = JSON.parse(stored) as Array<
        Omit<TransactionHistoryEntry, 'createdAt'> & { createdAt: string }
      >;
      this.entries = parsed.map((entry) => ({
        ...entry,
        createdAt: new Date(entry.createdAt),
      }));
    } catch {
      this.entries = [];
    }
  }

  private emit() {
    this.listeners.forEach((listener) => listener());

    if (typeof window !== 'undefined') {
      localStorage.setItem(this.storageKey, this.exportEntries());
    }
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return this.entries;
  }

  addEntry(entry: Omit<TransactionHistoryEntry, 'id' | 'createdAt'>) {
    const nextEntry: TransactionHistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
    };

    this.entries = [nextEntry, ...this.entries].slice(0, 100);
    this.emit();
    return nextEntry;
  }

  updateEntry(id: string, updates: Partial<TransactionHistoryEntry>) {
    this.entries = this.entries.map((entry) =>
      entry.id === id ? { ...entry, ...updates } : entry,
    );
    this.emit();
  }

  clearEntries() {
    this.entries = [];
    this.emit();
  }

  exportEntries() {
    return JSON.stringify(
      this.entries.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      })),
      null,
      2,
    );
  }
}

const storeMap = new Map<string, TxHistoryStore>();

export function getTxHistoryStore(account?: string, network?: string): TxHistoryStore {
  const scope = `${network || 'TESTNET'}_${account || 'anonymous'}`;
  let store = storeMap.get(scope);
  if (!store) {
    store = new TxHistoryStore(scope);
    storeMap.set(scope, store);
  }
  return store;
}

const EMPTY_TX_HISTORY: TransactionHistoryEntry[] = [];

export function useTxHistory(accountParam?: string, networkParam?: string) {
  let walletAddress = accountParam;
  let walletNetwork = networkParam;

  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const wallet = useStellarWallet();
    if (!walletAddress) walletAddress = wallet.connection.address;
    if (!walletNetwork) walletNetwork = wallet.connection.network;
  } catch {
    // Outside StellarWalletProvider
  }

  const store = getTxHistoryStore(walletAddress, walletNetwork);

  const entries = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => EMPTY_TX_HISTORY,
  );

  return {
    entries,
    addEntry: store.addEntry.bind(store),
    updateEntry: store.updateEntry.bind(store),
    clearEntries: store.clearEntries.bind(store),
    exportEntries: store.exportEntries.bind(store),
  };
}

