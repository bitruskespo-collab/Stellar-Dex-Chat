import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getPaymentStatusCursor,
  getPaymentStatusReplay,
  PAYMENT_STATUS_REPLAY_LIMIT,
  publishPaymentStatus,
  resetPaymentStatusEventsForTest,
  subscribeToPaymentStatus,
} from './paymentStatusEvents';

const statusEvent = {
  reference: 'ref-1',
  status: 'success' as const,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('payment status event replay', () => {
  afterEach(() => {
    resetPaymentStatusEventsForTest();
    vi.restoreAllMocks();
  });

  it('assigns stable per-session cursors and replays only events after a cursor', () => {
    publishPaymentStatus('session-1', statusEvent);
    publishPaymentStatus('session-1', { ...statusEvent, reference: 'ref-2' });
    publishPaymentStatus('session-2', statusEvent);

    expect(getPaymentStatusCursor('session-1')).toBe('2');
    expect(getPaymentStatusCursor('session-2')).toBe('1');
    expect(getPaymentStatusReplay('session-1', '1')).toEqual({
      events: [{ ...statusEvent, reference: 'ref-2', id: '2' }],
      latestCursor: '2',
      expired: false,
    });
  });

  it('bounds replay retention and reports expired or future cursors', () => {
    for (let index = 0; index <= PAYMENT_STATUS_REPLAY_LIMIT; index += 1) {
      publishPaymentStatus('session-1', {
        ...statusEvent,
        reference: `ref-${index}`,
      });
    }

    const replay = getPaymentStatusReplay('session-1', '1');
    expect(replay.events).toHaveLength(PAYMENT_STATUS_REPLAY_LIMIT);
    expect(replay.events[0].id).toBe('2');
    expect(replay.expired).toBe(false);
    expect(getPaymentStatusReplay('session-1', '0')).toMatchObject({
      events: [],
      expired: true,
    });
    expect(getPaymentStatusReplay('session-1', '1000')).toMatchObject({
      events: [],
      expired: true,
    });
  });

  it('does not let a failing stream listener fail payout event publishing', () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const received: string[] = [];
    subscribeToPaymentStatus('session-1', () => {
      throw new Error('closed stream');
    });
    subscribeToPaymentStatus('session-1', (event) => {
      received.push(event.id ?? '');
    });

    expect(() => publishPaymentStatus('session-1', statusEvent)).not.toThrow();
    expect(received).toEqual(['1']);
    expect(logError).toHaveBeenCalledOnce();
  });
});
