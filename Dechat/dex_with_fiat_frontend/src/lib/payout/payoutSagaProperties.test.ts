import { describe, expect, it } from 'vitest';
import { isTerminalPayoutStatus, type PayoutStatus } from './payoutLifecycle';
import {
  applyPayoutSagaSequence,
  generatePayoutSagaSequence,
  generatePayoutSagaSequences,
  PAYOUT_RELEASE_STATUSES,
  type PayoutSagaEvent,
  type PayoutSagaSequence,
} from './payoutSagaProperties';

type EventInput = Omit<PayoutSagaEvent, 'eventId'> & {
  eventId?: string;
};

function makeSequence(
  reference: string,
  inputs: EventInput[],
): PayoutSagaSequence {
  return {
    seed: 0,
    reference,
    events: inputs.map((input, index) => ({
      ...input,
      eventId: input.eventId ?? `${reference}-e${index}`,
    })),
  };
}

function event(
  kind: PayoutSagaEvent['kind'],
  targetStatus: PayoutStatus,
  actor: PayoutSagaEvent['actor'],
  reason: string,
): EventInput {
  return { kind, targetStatus, actor, reason };
}

describe('Payout saga stateful property tests (#266)', () => {
  it('generates deterministic sequences for a seed', () => {
    expect(generatePayoutSagaSequence(42)).toEqual(
      generatePayoutSagaSequence(42),
    );
    expect(generatePayoutSagaSequence(42).events).not.toEqual(
      generatePayoutSagaSequence(43).events,
    );
  });

  it('generates retries, duplicates, cancellation, reversal, and unauthorized attempts', () => {
    const sequences = generatePayoutSagaSequences(120);

    expect(
      sequences.every((sequence) =>
        sequence.events.some((item) => item.kind === 'retry'),
      ),
    ).toBe(true);
    expect(
      sequences.every((sequence) =>
        sequence.events.some((item) => item.kind === 'duplicate_callback'),
      ),
    ).toBe(true);
    expect(
      sequences.every((sequence) =>
        sequence.events.some((item) => item.kind === 'stale_callback'),
      ),
    ).toBe(true);
    expect(
      sequences.every((sequence) =>
        sequence.events.some((item) => item.kind === 'unauthorized_transition'),
      ),
    ).toBe(true);
    expect(
      sequences.some((sequence) =>
        sequence.events.some((item) => item.kind === 'cancellation_request'),
      ),
    ).toBe(true);
    expect(
      sequences.some((sequence) =>
        sequence.events.some((item) => item.kind === 'reversal_callback'),
      ),
    ).toBe(true);
  });

  it('keeps terminal states monotonic across generated event sequences', () => {
    for (const sequence of generatePayoutSagaSequences(200)) {
      const result = applyPayoutSagaSequence(sequence);
      const terminalIndex = result.observedStatuses.findIndex(
        isTerminalPayoutStatus,
      );
      const label = `seed ${sequence.seed}`;

      expect(result.status, label).not.toBe('none');
      expect(isTerminalPayoutStatus(result.status as PayoutStatus), label).toBe(
        true,
      );

      if (terminalIndex >= 0) {
        const terminalStatus = result.observedStatuses[terminalIndex];
        expect(
          result.observedStatuses
            .slice(terminalIndex)
            .every((status) => status === terminalStatus),
          label,
        ).toBe(true);
      }

      const terminalHistoryIndex = result.history.findIndex((record) =>
        isTerminalPayoutStatus(record.toStatus),
      );
      if (terminalHistoryIndex >= 0) {
        expect(
          result.history.slice(terminalHistoryIndex + 1),
          label,
        ).toHaveLength(0);
      }
    }
  });

  it('settles and releases at most once across generated event sequences', () => {
    for (const sequence of generatePayoutSagaSequences(200)) {
      const result = applyPayoutSagaSequence(sequence);
      const label = `seed ${sequence.seed}`;

      expect(result.settlementCount, label).toBeLessThanOrEqual(1);
      expect(result.releaseCount, label).toBeLessThanOrEqual(1);
      expect(result.appliedCount, label).toBe(result.history.length);
      expect(
        result.history.filter((item) => item.toStatus === 'success'),
        label,
      ).toHaveLength(result.settlementCount);
      expect(
        result.history.filter((item) =>
          PAYOUT_RELEASE_STATUSES.includes(item.toStatus),
        ),
        label,
      ).toHaveLength(result.releaseCount);
      expect(result.duplicateCount, label).toBeGreaterThan(0);
      expect(result.unauthorizedCount, label).toBeGreaterThan(0);
      expect(result.rejectedCount, label).toBeGreaterThan(0);
    }
  });

  it('settles exactly once on the normal path', () => {
    const settlement = {
      ...event('settlement_callback', 'success', 'webhook', 'Settled'),
      eventId: 'normal-path-e1',
    };
    const result = applyPayoutSagaSequence(
      makeSequence('normal-path', [
        event('initiation', 'pending', 'user', 'Initiation'),
        settlement,
        {
          ...settlement,
          kind: 'duplicate_callback' as const,
          reason: 'Duplicate settled',
        },
        event('stale_callback', 'success', 'webhook', 'Stale settled'),
      ]),
    );

    expect(result.status).toBe('success');
    expect(result.settlementCount).toBe(1);
    expect(result.releaseCount).toBe(0);
    expect(result.duplicateCount).toBe(1);
    expect(result.appliedCount).toBe(2);
  });

  it('does not settle after a terminal failure', () => {
    const result = applyPayoutSagaSequence(
      makeSequence('failure-path', [
        event('initiation', 'pending', 'user', 'Initiation'),
        event('failure_callback', 'failed', 'webhook', 'Provider failed'),
        event('retry', 'success', 'polling', 'Retry after failure'),
      ]),
    );

    expect(result.status).toBe('failed');
    expect(result.settlementCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
    expect(result.history).toHaveLength(2);
  });

  it('releases exactly once on cancellation and ignores later settlement', () => {
    const result = applyPayoutSagaSequence(
      makeSequence('cancel-path', [
        event('initiation', 'pending', 'user', 'Initiation'),
        event('cancellation_request', 'cancelled', 'user', 'Cancelled'),
        event('duplicate_callback', 'cancelled', 'system', 'Duplicate cancel'),
        event('stale_callback', 'success', 'webhook', 'Late settlement'),
      ]),
    );

    expect(result.status).toBe('cancelled');
    expect(result.releaseCount).toBe(1);
    expect(result.settlementCount).toBe(0);
    expect(result.rejectedCount).toBe(1);
  });

  it('releases exactly once after settlement is reversed', () => {
    const result = applyPayoutSagaSequence(
      makeSequence('reversal-path', [
        event('initiation', 'pending', 'user', 'Initiation'),
        event('settlement_callback', 'success', 'webhook', 'Settled'),
        event('reversal_callback', 'reversed', 'webhook', 'Reversed'),
        event('stale_callback', 'success', 'webhook', 'Late settlement'),
      ]),
    );

    expect(result.status).toBe('reversed');
    expect(result.settlementCount).toBe(1);
    expect(result.releaseCount).toBe(1);
    expect(result.rejectedCount).toBe(1);
  });

  it('rejects unauthorized settlement and reversal attempts', () => {
    const result = applyPayoutSagaSequence(
      makeSequence('auth-path', [
        event('initiation', 'pending', 'user', 'Initiation'),
        event(
          'unauthorized_transition',
          'reversed',
          'attacker',
          'Unauthorized reversal',
        ),
        event(
          'unauthorized_transition',
          'success',
          'attacker',
          'Unauthorized settlement',
        ),
        event('cancellation_request', 'cancelled', 'admin', 'Admin cancel'),
      ]),
    );

    expect(result.status).toBe('cancelled');
    expect(result.unauthorizedCount).toBe(2);
    expect(result.settlementCount).toBe(0);
    expect(result.releaseCount).toBe(1);
    expect(result.history).toHaveLength(2);
  });

  it('bounds pending retries without settling or releasing', () => {
    const result = applyPayoutSagaSequence(
      makeSequence('retry-path', [
        event('initiation', 'pending', 'user', 'Initiation'),
        event('retry', 'pending', 'polling', 'Retry 1'),
        event('retry', 'pending', 'polling', 'Retry 2'),
        event('retry', 'pending', 'polling', 'Retry 3'),
        event('retry', 'pending', 'polling', 'Retry 4'),
        event('retry', 'pending', 'polling', 'Retry 5'),
      ]),
    );

    expect(result.status).toBe('pending');
    expect(result.appliedCount).toBe(1);
    expect(result.settlementCount).toBe(0);
    expect(result.releaseCount).toBe(0);
    expect(result.history).toHaveLength(1);
  });
});
