import { describe, it, expect, beforeEach } from 'vitest';
import {
  PayoutStatus,
  ALLOWED_PAYOUT_TRANSITIONS,
  canTransitionPayoutStatus,
  validatePayoutTransition,
  InvalidPayoutTransitionError,
} from './payoutLifecycle';
import {
  transferStore,
  getTransferStatus,
  transitionPayoutStatus,
  clearTransferStore,
} from '../transferStore';

describe('Payout Lifecycle State Machine (Issue #33)', () => {
  beforeEach(() => {
    clearTransferStore();
  });

  describe('Transition rules matrix', () => {
    it('allows valid transitions from none', () => {
      expect(canTransitionPayoutStatus('none', 'pending')).toBe(true);
      expect(canTransitionPayoutStatus('none', 'initiated')).toBe(true);
      expect(canTransitionPayoutStatus('none', 'success')).toBe(false);
      expect(canTransitionPayoutStatus('none', 'reversed')).toBe(false);
    });

    it('allows valid transitions from pending', () => {
      expect(canTransitionPayoutStatus('pending', 'success')).toBe(true);
      expect(canTransitionPayoutStatus('pending', 'failed')).toBe(true);
      expect(canTransitionPayoutStatus('pending', 'cancelled')).toBe(true);
      expect(canTransitionPayoutStatus('pending', 'reversed')).toBe(false);
    });

    it('allows only reversal from success', () => {
      expect(canTransitionPayoutStatus('success', 'reversed')).toBe(true);
      expect(canTransitionPayoutStatus('success', 'failed')).toBe(false);
      expect(canTransitionPayoutStatus('success', 'cancelled')).toBe(false);
      expect(canTransitionPayoutStatus('success', 'pending')).toBe(false);
    });

    it('makes terminal states immutable', () => {
      const terminalStates: PayoutStatus[] = ['failed', 'reversed', 'cancelled'];
      const allStates: PayoutStatus[] = [
        'initiated',
        'pending',
        'success',
        'failed',
        'reversed',
        'cancelled',
      ];

      for (const terminal of terminalStates) {
        for (const target of allStates) {
          if (target === terminal) {
            // Self-transition is an idempotent no-op
            expect(canTransitionPayoutStatus(terminal, target)).toBe(true);
          } else {
            expect(canTransitionPayoutStatus(terminal, target)).toBe(false);
          }
        }
      }
    });

    it('throws InvalidPayoutTransitionError on invalid transitions', () => {
      expect(() =>
        validatePayoutTransition('cancelled', 'success', 'ref_1'),
      ).toThrow(InvalidPayoutTransitionError);

      expect(() =>
        validatePayoutTransition('failed', 'success', 'ref_2'),
      ).toThrow(InvalidPayoutTransitionError);

      expect(() =>
        validatePayoutTransition('reversed', 'pending', 'ref_3'),
      ).toThrow(InvalidPayoutTransitionError);
    });
  });

  describe('transitionPayoutStatus store integration', () => {
    it('initiates and transitions through settlement', () => {
      const ref = 'TRF_settle_1';
      const record1 = transitionPayoutStatus({
        reference: ref,
        targetStatus: 'pending',
        actor: 'user',
        providerReference: 'PRV_123',
        reason: 'User initiation',
        amount: 5000,
      });

      expect(record1.status).toBe('pending');
      expect(record1.history).toHaveLength(1);
      expect(record1.history![0]).toMatchObject({
        fromStatus: 'none',
        toStatus: 'pending',
        actor: 'user',
        providerReference: 'PRV_123',
        reason: 'User initiation',
      });

      const record2 = transitionPayoutStatus({
        reference: ref,
        targetStatus: 'success',
        actor: 'webhook',
        providerReference: 'PRV_123',
        reason: 'Webhook transfer.success',
      });

      expect(record2.status).toBe('success');
      expect(record2.history).toHaveLength(2);
      expect(record2.history![1]).toMatchObject({
        fromStatus: 'pending',
        toStatus: 'success',
        actor: 'webhook',
        providerReference: 'PRV_123',
      });
    });

    it('transitions from success to reversed', () => {
      const ref = 'TRF_rev_1';
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'pending',
        actor: 'user',
      });
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'success',
        actor: 'webhook',
      });
      const reversed = transitionPayoutStatus({
        reference: ref,
        targetStatus: 'reversed',
        actor: 'webhook',
        reason: 'Bank chargeback/reversal',
      });

      expect(reversed.status).toBe('reversed');
      expect(reversed.history).toHaveLength(3);
      expect(reversed.history![2].toStatus).toBe('reversed');
    });

    it('rejects out-of-order webhook events arriving after cancellation', () => {
      const ref = 'TRF_ooo_1';
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'pending',
        actor: 'user',
      });
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'cancelled',
        actor: 'user',
        reason: 'User cancelled payout',
      });

      // An out-of-order success webhook arrives after user cancellation
      expect(() =>
        transitionPayoutStatus({
          reference: ref,
          targetStatus: 'success',
          actor: 'webhook',
          reason: 'Delayed success callback',
        }),
      ).toThrow(InvalidPayoutTransitionError);

      // Verify the state remains 'cancelled' and was not overwritten
      const stored = getTransferStatus(ref);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.history).toHaveLength(2);
    });

    it('rejects out-of-order polling arriving after failure', () => {
      const ref = 'TRF_ooo_2';
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'pending',
        actor: 'user',
      });
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'failed',
        actor: 'webhook',
        reason: 'Account closed',
      });

      expect(() =>
        transitionPayoutStatus({
          reference: ref,
          targetStatus: 'success',
          actor: 'polling',
          reason: 'Stale poll response',
        }),
      ).toThrow(InvalidPayoutTransitionError);

      const stored = getTransferStatus(ref);
      expect(stored?.status).toBe('failed');
    });

    it('treats duplicate events with the same status as idempotent no-ops', () => {
      const ref = 'TRF_dup_1';
      transitionPayoutStatus({
        reference: ref,
        targetStatus: 'pending',
        actor: 'user',
      });
      const success1 = transitionPayoutStatus({
        reference: ref,
        targetStatus: 'success',
        actor: 'webhook',
      });

      // Duplicate webhook
      const success2 = transitionPayoutStatus({
        reference: ref,
        targetStatus: 'success',
        actor: 'webhook',
      });

      expect(success2.status).toBe('success');
      // History does not grow for duplicate identical status
      expect(success2.history).toHaveLength(success1.history?.length ?? 2);
    });
  });
});
