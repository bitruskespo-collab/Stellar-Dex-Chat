import {
  InvalidPayoutTransitionError,
  type PayoutActor,
  type PayoutStatus,
  type PayoutTransitionRecord,
} from './payoutLifecycle';
import {
  clearTransferStore,
  getTransferStatus,
  transitionPayoutStatus,
} from '../transferStore';

export type PayoutSagaEventKind =
  | 'initiation'
  | 'retry'
  | 'duplicate_callback'
  | 'settlement_callback'
  | 'failure_callback'
  | 'cancellation_request'
  | 'cancellation_confirmation'
  | 'reversal_callback'
  | 'reconciliation'
  | 'stale_callback'
  | 'unauthorized_transition';

export interface PayoutSagaEvent {
  eventId: string;
  kind: PayoutSagaEventKind;
  targetStatus: PayoutStatus;
  actor: PayoutActor | 'attacker';
  reason: string;
  providerReference?: string;
}

export interface PayoutSagaSequence {
  seed: number;
  reference: string;
  events: PayoutSagaEvent[];
}

export interface PayoutSagaApplicationResult {
  status: PayoutStatus | 'none';
  observedStatuses: PayoutStatus[];
  history: PayoutTransitionRecord[];
  settlementCount: number;
  releaseCount: number;
  appliedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  unauthorizedCount: number;
}

export const PAYOUT_RELEASE_STATUSES: readonly PayoutStatus[] = [
  'cancelled',
  'reversed',
];

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function generatePayoutSagaSequence(seed: number): PayoutSagaSequence {
  const random = createRandom(seed);
  const reference = `payout-seq-${seed.toString(36)}`;
  const events: PayoutSagaEvent[] = [];
  let eventCounter = 0;

  const emit = (
    kind: PayoutSagaEventKind,
    targetStatus: PayoutStatus,
    actor: PayoutActor | 'attacker',
    reason: string,
    providerReference?: string,
  ): PayoutSagaEvent => {
    const event: PayoutSagaEvent = {
      eventId: `${reference}-e${eventCounter++}`,
      kind,
      targetStatus,
      actor,
      reason,
      providerReference,
    };
    events.push(event);
    return event;
  };

  const duplicate = (source: PayoutSagaEvent): PayoutSagaEvent => {
    const event: PayoutSagaEvent = {
      ...source,
      kind: 'duplicate_callback',
      reason: `Duplicate of ${source.eventId}`,
    };
    events.push(event);
    return event;
  };

  const scenario = Math.floor(random() * 6);
  const initiation = emit(
    'initiation',
    'pending',
    'user',
    'Payout initiation',
    `provider-${seed}`,
  );
  duplicate(initiation);

  if (scenario === 0) {
    const settlement = emit(
      'settlement_callback',
      'success',
      'webhook',
      'Provider settlement callback',
      `provider-${seed}`,
    );
    emit('retry', 'success', 'polling', 'Retried settlement callback');
    duplicate(settlement);
    const reversal = emit(
      'reversal_callback',
      'reversed',
      'webhook',
      'Chargeback reversal',
    );
    duplicate(reversal);
  } else if (scenario === 1) {
    emit('retry', 'pending', 'polling', 'Pending status retry');
    const cancellation = emit(
      'cancellation_request',
      'cancelled',
      'user',
      'User cancellation',
    );
    emit(
      'cancellation_confirmation',
      'cancelled',
      'system',
      'Provider cancellation confirmation',
    );
    duplicate(cancellation);
  } else if (scenario === 2) {
    const failure = emit(
      'failure_callback',
      'failed',
      'webhook',
      'Provider failure callback',
    );
    emit('retry', 'success', 'polling', 'Retry after terminal failure');
    duplicate(failure);
  } else if (scenario === 3) {
    emit('retry', 'pending', 'polling', 'Pending status retry');
    const settlement = emit(
      'settlement_callback',
      'success',
      'webhook',
      'Provider settlement callback',
    );
    duplicate(settlement);
    emit('retry', 'success', 'polling', 'Settlement callback retry');
    emit('reversal_callback', 'reversed', 'admin', 'Manual reversal');
  } else if (scenario === 4) {
    emit('retry', 'pending', 'polling', 'Pending status retry');
    emit('reconciliation', 'pending', 'system', 'Reconciliation after timeout');
    const cancellation = emit(
      'cancellation_request',
      'cancelled',
      'admin',
      'Recovered cancellation',
    );
    duplicate(cancellation);
    emit('reconciliation', 'cancelled', 'system', 'Terminal reconciliation');
  } else {
    emit('retry', 'pending', 'polling', 'Pending status retry');
    emit(
      'unauthorized_transition',
      'reversed',
      'attacker',
      'Unauthorized reversal attempt',
    );
    const cancellation = emit(
      'cancellation_request',
      'cancelled',
      'admin',
      'Administrator cancellation',
    );
    emit(
      'unauthorized_transition',
      'success',
      'attacker',
      'Unauthorized settlement attempt',
    );
    duplicate(cancellation);
  }

  emit('stale_callback', 'success', 'webhook', 'Stale settlement callback');
  emit(
    'unauthorized_transition',
    'reversed',
    'attacker',
    'Guarded reversal attempt',
  );

  const noiseCount = 6 + Math.floor(random() * 7);
  for (let index = 0; index < noiseCount; index += 1) {
    const choice = random();
    const priorEvent = events[Math.floor(random() * events.length)];

    if (choice < 0.2) {
      duplicate(priorEvent);
    } else if (choice < 0.4) {
      emit('retry', 'pending', 'polling', 'Pending status retry');
    } else if (choice < 0.6) {
      emit(
        'unauthorized_transition',
        'reversed',
        'attacker',
        'Unauthorized reversal attempt',
      );
    } else if (choice < 0.8) {
      emit('stale_callback', 'success', 'webhook', 'Out-of-order settlement');
    } else {
      emit('reconciliation', 'pending', 'system', 'Reconciliation poll');
    }
  }

  return { seed, reference, events };
}

export function generatePayoutSagaSequences(
  count: number,
  startSeed = 1,
): PayoutSagaSequence[] {
  return Array.from({ length: count }, (_, index) =>
    generatePayoutSagaSequence(startSeed + index),
  );
}

function isAuthorizedSagaEvent(event: PayoutSagaEvent): boolean {
  if (event.actor === 'attacker') {
    return false;
  }
  if (event.targetStatus === 'cancelled') {
    return (
      event.actor === 'user' ||
      event.actor === 'admin' ||
      event.actor === 'system'
    );
  }
  if (event.targetStatus === 'reversed') {
    return (
      event.actor === 'admin' ||
      event.actor === 'system' ||
      event.actor === 'webhook'
    );
  }
  return true;
}

export function applyPayoutSagaSequence(
  sequence: PayoutSagaSequence,
): PayoutSagaApplicationResult {
  clearTransferStore();
  const seenEventIds = new Set<string>();
  const observedStatuses: PayoutStatus[] = [];
  let settlementCount = 0;
  let releaseCount = 0;
  let appliedCount = 0;
  let duplicateCount = 0;
  let rejectedCount = 0;
  let unauthorizedCount = 0;

  for (const event of sequence.events) {
    if (seenEventIds.has(event.eventId)) {
      duplicateCount += 1;
      continue;
    }
    seenEventIds.add(event.eventId);

    if (!isAuthorizedSagaEvent(event)) {
      unauthorizedCount += 1;
      continue;
    }

    const before = getTransferStatus(sequence.reference);
    const beforeHistoryLength = before?.history?.length ?? 0;

    try {
      const after = transitionPayoutStatus({
        reference: sequence.reference,
        targetStatus: event.targetStatus,
        actor: event.actor,
        providerReference: event.providerReference,
        reason: event.reason,
        amount: 5000,
      });
      const afterHistoryLength = after.history?.length ?? 0;

      if (afterHistoryLength > beforeHistoryLength) {
        appliedCount += 1;
        if (event.targetStatus === 'success') {
          settlementCount += 1;
        }
        if (PAYOUT_RELEASE_STATUSES.includes(event.targetStatus)) {
          releaseCount += 1;
        }
      }

      observedStatuses.push(after.status);
    } catch (error) {
      if (!(error instanceof InvalidPayoutTransitionError)) {
        throw error;
      }
      rejectedCount += 1;
      const current = getTransferStatus(sequence.reference);
      if (current) {
        observedStatuses.push(current.status);
      }
    }
  }

  const finalRecord = getTransferStatus(sequence.reference);
  return {
    status: finalRecord?.status ?? 'none',
    observedStatuses,
    history: finalRecord?.history ?? [],
    settlementCount,
    releaseCount,
    appliedCount,
    duplicateCount,
    rejectedCount,
    unauthorizedCount,
  };
}
