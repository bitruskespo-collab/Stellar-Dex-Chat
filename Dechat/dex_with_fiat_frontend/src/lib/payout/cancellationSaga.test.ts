import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  executeCancellationSaga,
  getSagaStepsForPayout,
  getPendingCompensationWork,
  retryCompensationWork,
  resetSagaStores,
} from './cancellationSaga';
import { setTransferStatus, transferStore } from '@/lib/transferStore';
import * as registry from './providers/registry';

describe('Payout Cancellation Provider-Aware Saga (#43)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transferStore.clear();
    resetSagaStores();
  });

  describe('Modeled Outcomes & Linkage to Original Payout', () => {
    it('models provider_confirmed outcome when provider confirms cancellation', async () => {
      const reference = 'ref-confirmed-1';
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 5000,
        updatedAt: new Date().toISOString(),
        clientSessionId: 'session-123',
      });

      const mockProvider = {
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockResolvedValue({
          status: 'confirmed',
          cancellable: true,
          message: 'Cancelled at provider',
        }),
      };
      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue(mockProvider as any);

      const result = await executeCancellationSaga({
        reference,
        clientSessionId: 'session-123',
        reason: 'User requested',
      });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('provider_confirmed');
      expect(result.status).toBe(200);

      // Verify every step is linked to the original payout
      const steps = getSagaStepsForPayout(reference);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.every((s) => s.payoutReference === reference)).toBe(true);
      expect(steps.map((s) => s.step)).toContain('cancellation_requested');
      expect(steps.map((s) => s.step)).toContain('provider_confirmed');
    });

    it('models rejected outcome for non-existent payout', async () => {
      const result = await executeCancellationSaga({
        reference: 'non-existent-ref',
      });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('rejected');
      expect(result.status).toBe(404);
      expect(result.code).toBe('TRANSFER_NOT_FOUND');
    });

    it('models rejected outcome for unauthorized client session', async () => {
      const reference = 'ref-auth-check';
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 5000,
        updatedAt: new Date().toISOString(),
        clientSessionId: 'correct-session',
      });

      const result = await executeCancellationSaga({
        reference,
        clientSessionId: 'wrong-session',
      });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('rejected');
      expect(result.status).toBe(403);
    });
  });

  describe('Irreversible Settlement Prevention', () => {
    it('prevents cancellation after irreversible settlement (locally settled)', async () => {
      const reference = 'ref-settled-local';
      setTransferStatus({
        reference,
        status: 'success', // Irreversibly settled
        amount: 10000,
        updatedAt: new Date().toISOString(),
      });

      const result = await executeCancellationSaga({ reference });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('rejected');
      expect(result.status).toBe(409);
      expect(result.code).toBe('TRANSFER_SETTLED');
      expect(result.message).toMatch(/irreversible/i);

      // Verify steps linked
      const steps = getSagaStepsForPayout(reference);
      const settlementStep = steps.find((s) => s.step === 'settlement_check');
      expect(settlementStep).toBeDefined();
      expect(settlementStep?.status).toBe('failed');
      expect(settlementStep?.outcome).toBe('rejected');
    });
  });

  describe('Cancellation Race Against Settlement', () => {
    it('rejects cancellation when transfer settles at provider during the race', async () => {
      const reference = 'ref-race-settled';
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 5000,
        updatedAt: new Date().toISOString(),
      });

      // Provider indicates settlement won the race
      const mockProvider = {
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockResolvedValue({
          status: 'settled',
          cancellable: false,
          message: 'Transfer settled at provider before cancellation arrived',
        }),
      };
      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue(mockProvider as any);

      const result = await executeCancellationSaga({ reference });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('rejected');
      expect(result.status).toBe(409);
      expect(result.code).toBe('TRANSFER_SETTLED');

      // Local status should be updated to settled (success)
      const updated = transferStore.get(reference);
      expect(updated?.status).toBe('success');

      // Saga steps reflect race resolution
      const steps = getSagaStepsForPayout(reference);
      const rejectStep = steps.find((s) => s.step === 'cancellation_rejected');
      expect(rejectStep).toBeDefined();
      expect(rejectStep?.details?.reason).toMatch(/race condition/i);
    });

    it('rejects cancellation when provider rejects the cancellation request', async () => {
      const reference = 'ref-provider-reject';
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 5000,
        updatedAt: new Date().toISOString(),
      });

      const mockProvider = {
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockResolvedValue({
          status: 'rejected',
          cancellable: false,
          message: 'Transfer is past cancellation cutoff window',
        }),
      };
      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue(mockProvider as any);

      const result = await executeCancellationSaga({ reference });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('rejected');
      expect(result.status).toBe(409);
      expect(result.code).toBe('CANCELLATION_REJECTED');
    });
  });

  describe('Provider Timeout & Retryable Compensation Work', () => {
    it('persists retryable compensation work and models compensated outcome on provider timeout', async () => {
      const reference = 'ref-timeout-comp';
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 5000,
        updatedAt: new Date().toISOString(),
      });

      // Provider throws timeout
      const mockProvider = {
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn(),
        cancelTransfer: vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection to provider timed out')),
      };
      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue(mockProvider as any);

      const result = await executeCancellationSaga({ reference });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('compensated');
      expect(result.status).toBe(202);
      expect(result.compensationWorkId).toBeDefined();

      // Verify compensation work is persisted
      const pendingWork = getPendingCompensationWork();
      expect(pendingWork.length).toBe(1);
      expect(pendingWork[0].payoutReference).toBe(reference);
      expect(pendingWork[0].status).toBe('pending');
      expect(pendingWork[0].action).toBe('reconcile_provider_settlement');

      // Verify saga step linked to original payout
      const steps = getSagaStepsForPayout(reference);
      const compStep = steps.find((s) => s.step === 'compensation_scheduled');
      expect(compStep).toBeDefined();
      expect(compStep?.outcome).toBe('compensated');
    });

    it('successfully executes and completes retryable compensation work', async () => {
      const reference = 'ref-retry-comp';
      setTransferStatus({
        reference,
        status: 'pending',
        amount: 5000,
        updatedAt: new Date().toISOString(),
      });

      // Initially times out
      const mockProvider = {
        name: 'paystack' as const,
        verifyAccount: vi.fn(),
        createRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        checkTransferStatus: vi.fn().mockResolvedValue({ status: 'cancelled' }),
        cancelTransfer: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')),
      };
      vi.spyOn(registry, 'getPayoutProvider').mockReturnValue(mockProvider as any);

      const result = await executeCancellationSaga({ reference });
      expect(result.compensationWorkId).toBeDefined();

      // Now retry the compensation work
      const retryResult = await retryCompensationWork(result.compensationWorkId!);
      expect(retryResult.success).toBe(true);
      expect(retryResult.work.status).toBe('completed');

      // Queue is now empty of pending work
      expect(getPendingCompensationWork().length).toBe(0);

      // Local status updated to cancelled
      expect(transferStore.get(reference)?.status).toBe('cancelled');
    });
  });
});
