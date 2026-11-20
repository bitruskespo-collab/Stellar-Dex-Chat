export interface ContractEvent {
  id: string;
  type: 'deposit' | 'withdraw';
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  actor: string;
  amount: string;
  token?: string;
  version: number;
  projectionVersion: number;
  projectionChecksum: string;
  activeProjectionId: string;
}

export interface IndexerState {
  lastPagingToken: string;
  lastLedger: number;
  updatedAt: string;
  projectionVersion: number;
  projectionChecksum: string;
  activeProjectionId: string;
}