import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PayoutAuditLedger } from '../../auditLedger';
import {
  PayoutReconciliationService,
  reconcileAmbiguousInitiation,
} from '../../reconciliation';
import { FakePayoutProvider } from '../fakeProvider';
import { PayoutProviderError } from '../types';
import { AmbiguousInitiationError } from '../../timeoutBudget';
import { clearTransferStore, setTransferStatus } from '@/lib/transferStore';

const request = {
  source: 'balance',
  amount: '25.00',
  recipient: 'RCP_SANDBOX',
  reference: 'sandbox_ambiguous_ref',
};

function setAmbiguousRecord(reference: string) {
  setTransferStatus({
    reference,
    status: 'pending',
    amount: 25,
    updatedAt: new Date().toISOString(),
    credentialVersion: 'sandbox-v1',
    timeoutOutcome: 'ambiguous',
    reconciled: false,
  });
}

describe('sandbox payout provider ambiguous-outcome contract', () => {
  beforeEach(() => {
    clearTransferStore();
    vi.stubEnv('PAYOUT_DATA_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('recovers accepted-but-timeout transfers by status lookup without initiating again', async () => {
    const provider = new FakePayoutProvider();
    const initiate = vi.spyOn(provider, 'initiateTransfer');
    const checkStatus = vi.spyOn(provider, 'checkTransferStatus');

    await expect(
      (async () => {
        await provider.initiateTransfer(request);
        throw new AmbiguousInitiationError(request.reference, 100);
      })(),
    ).rejects.toBeInstanceOf(AmbiguousInitiationError);
    setAmbiguousRecord(request.reference);

    const result = await reconcileAmbiguousInitiation(
      request.reference,
      'sandbox-v1',
      provider,
    );

    expect(result).toMatchObject({
      reconciled: true,
      outcome: 'known',
      record: {
        reference: request.reference,
        status: 'pending',
        timeoutOutcome: 'known',
        reconciled: true,
      },
    });
    expect(initiate).toHaveBeenCalledTimes(1);
    expect(checkStatus).toHaveBeenCalledOnce();
  });

  it('returns the original provider transfer for a duplicate reference', async () => {
    const provider = new FakePayoutProvider();

    const first = await provider.initiateTransfer(request);
    const duplicate = await provider.initiateTransfer(request);

    expect(duplicate).toBe(first);
    expect(duplicate.reference).toBe(request.reference);
  });

  it('keeps an ambiguous transfer pending when status lookup returns not found', async () => {
    const provider = new FakePayoutProvider();
    const initiate = vi.spyOn(provider, 'initiateTransfer');
    const reference = 'sandbox_status_not_found';
    setAmbiguousRecord(reference);

    const result = await reconcileAmbiguousInitiation(
      reference,
      'sandbox-v1',
      provider,
    );

    expect(result).toMatchObject({
      reconciled: false,
      outcome: 'not_found',
      record: {
        reference,
        status: 'pending',
        timeoutOutcome: 'ambiguous',
        reconciled: false,
      },
    });
    expect(initiate).not.toHaveBeenCalled();
  });

  it('surfaces provider status failures without initiating a replacement transfer', async () => {
    const provider = new FakePayoutProvider();
    const reference = 'sandbox_status_unavailable';
    const statusError = new PayoutProviderError({
      message: 'Provider status service unavailable',
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    provider.simulateError('checkTransferStatus', statusError);
    const initiate = vi.spyOn(provider, 'initiateTransfer');
    setAmbiguousRecord(reference);

    await expect(
      reconcileAmbiguousInitiation(reference, 'sandbox-v1', provider),
    ).rejects.toBe(statusError);
    expect(initiate).not.toHaveBeenCalled();
  });

  it('preserves a settled local status when provider status is stale', async () => {
    const provider = new FakePayoutProvider();
    const reference = 'sandbox_status_regression';
    const initiate = vi.spyOn(provider, 'initiateTransfer');
    await provider.initiateTransfer({ ...request, reference });
    setTransferStatus({
      reference,
      status: 'success',
      amount: 25,
      updatedAt: new Date().toISOString(),
      credentialVersion: 'sandbox-v1',
      timeoutOutcome: 'ambiguous',
      reconciled: false,
    });

    const result = await reconcileAmbiguousInitiation(
      reference,
      'sandbox-v1',
      provider,
    );

    expect(result).toMatchObject({
      reconciled: false,
      outcome: 'conflict',
      record: { reference, status: 'success' },
    });
    expect(initiate).toHaveBeenCalledOnce();
  });

  it('rejects delayed success events after a reversal without regressing state', () => {
    const reconciliation = new PayoutReconciliationService(
      undefined,
      new PayoutAuditLedger(),
    );
    const reference = 'sandbox_delayed_webhook';

    const reversed = reconciliation.reconcileEvent({
      eventId: 'sandbox-reversed-1',
      payoutReference: reference,
      eventType: 'transfer.reversed',
      currentStatus: 'pending',
    });
    const delayedSuccess = reconciliation.reconcileEvent({
      eventId: 'sandbox-delayed-success-1',
      payoutReference: reference,
      eventType: 'transfer.success',
      currentStatus: reversed.effectiveStatus,
      payload: { reference, status: 'success' },
    });

    expect(reversed.effectiveStatus).toBe('reversed');
    expect(delayedSuccess.decision).toBe('REJECTED_OUT_OF_ORDER');
    expect(delayedSuccess.effectiveStatus).toBe('reversed');
  });
});
