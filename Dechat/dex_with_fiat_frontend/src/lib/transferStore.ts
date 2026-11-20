import {
  PayoutStatus,
  PayoutActor,
  PayoutTransitionRecord,
  validatePayoutTransition,
} from './payout/payoutLifecycle';

export {
  type PayoutStatus,
  type PayoutActor,
  type PayoutTransitionRecord,
  InvalidPayoutTransitionError,
} from './payout/payoutLifecycle';

type ReplayCacheEntry = {
  seenAt: number;
};

const DEFAULT_REPLAY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REPLAY_MAX_SIZE = 1000;

const replayCache = new Map<string, ReplayCacheEntry>();

function pruneReplayCache(now = Date.now()) {
  for (const [key, entry] of replayCache.entries()) {
    if (now - entry.seenAt > DEFAULT_REPLAY_TTL_MS) {
      replayCache.delete(key);
    }
  }

  while (replayCache.size > DEFAULT_REPLAY_MAX_SIZE) {
    const oldestKey = replayCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    replayCache.delete(oldestKey);
  }
}

export function isReplayEvent(cacheKey: string): boolean {
  const now = Date.now();
  pruneReplayCache(now);

  if (replayCache.has(cacheKey)) {
    return true;
  }

  replayCache.set(cacheKey, { seenAt: now });
  return false;
}

export function replayCacheStats() {
  return {
    size: replayCache.size,
    ttlMs: DEFAULT_REPLAY_TTL_MS,
    maxSize: DEFAULT_REPLAY_MAX_SIZE,
  };
}

/**
 * In-memory store for transfer status and payout lifecycle tracking.
 */
export interface TransferStatusRecord {
  reference: string;
  status: PayoutStatus;
  amount: number;
  amountMinor?: bigint;
  currency?: string;
  failureReason?: string;
  updatedAt: string;
  updatedAtMs?: number;
  clientSessionId?: string;
  providerReference?: string;
  history?: PayoutTransitionRecord[];
  reconciliationAttempts?: number;
  lastReconciledAt?: string;
  lastReconciliationResult?:
    | 'transitioned'
    | 'no_change'
    | 'provider_unavailable'
    | 'invalid_transition'
    | 'error';
  nextRetryAt?: number;
}

export interface TransitionPayoutParams {
  reference: string;
  targetStatus: PayoutStatus;
  actor: PayoutActor | string;
  providerReference?: string;
  reason?: string;
  amount?: number;
  clientSessionId?: string;
  failureReason?: string;
  timestamp?: string;
}

// Key is the transfer reference
export const transferStore = new Map<string, TransferStatusRecord>();

export function getTransferStatus(
  reference: string,
): TransferStatusRecord | undefined {
  return transferStore.get(reference);
}

export function transitionPayoutStatus({
  reference,
  targetStatus,
  actor,
  providerReference,
  reason,
  amount,
  clientSessionId,
  failureReason,
  timestamp = new Date().toISOString(),
}: TransitionPayoutParams): TransferStatusRecord {
  const existing = transferStore.get(reference);
  const currentStatus: PayoutStatus | 'none' = existing?.status ?? 'none';

  if (existing && currentStatus === targetStatus) {
    return existing;
  }

  validatePayoutTransition(currentStatus, targetStatus, reference);

  const transitionRecord: PayoutTransitionRecord = {
    fromStatus: currentStatus,
    toStatus: targetStatus,
    actor,
    providerReference: providerReference ?? existing?.providerReference,
    timestamp,
    reason,
  };

  const history = existing?.history
    ? [...existing.history, transitionRecord]
    : [transitionRecord];
  const parsedTimestamp = Date.parse(timestamp);
  const updatedRecord: TransferStatusRecord = {
    ...existing,
    reference,
    status: targetStatus,
    amount: amount ?? existing?.amount ?? 0,
    failureReason: failureReason ?? existing?.failureReason,
    updatedAt: timestamp,
    updatedAtMs: Number.isNaN(parsedTimestamp)
      ? existing?.updatedAtMs
      : parsedTimestamp,
    clientSessionId: clientSessionId ?? existing?.clientSessionId,
    providerReference: providerReference ?? existing?.providerReference,
    history,
  };

  transferStore.set(reference, updatedRecord);
  return updatedRecord;
}

export function setTransferStatus(
  record: TransferStatusRecord,
): TransferStatusRecord {
  const existing = transferStore.get(record.reference);
  const currentStatus: PayoutStatus | 'none' = existing?.status ?? 'none';

  if (currentStatus !== record.status) {
    const transitioned = transitionPayoutStatus({
      reference: record.reference,
      targetStatus: record.status,
      actor: 'system',
      providerReference: record.providerReference,
      reason: record.failureReason ?? 'Status update',
      amount: record.amount,
      clientSessionId: record.clientSessionId,
      failureReason: record.failureReason,
      timestamp: record.updatedAt,
    });
    const merged: TransferStatusRecord = {
      ...transitioned,
      ...record,
      history: transitioned.history ?? record.history,
    };
    transferStore.set(record.reference, merged);
    return merged;
  }

  const merged: TransferStatusRecord = {
    ...existing,
    ...record,
    history: existing?.history ?? record.history,
  };
  transferStore.set(record.reference, merged);
  return merged;
}

export function getAllTransfers(): TransferStatusRecord[] {
  return Array.from(transferStore.values());
}

export function clearTransferStore(): void {
  transferStore.clear();
  replayCache.clear();
}
