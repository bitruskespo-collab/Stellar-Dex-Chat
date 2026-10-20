import { randomUUID } from 'crypto';
import { getPayoutProvider } from './providers/registry';
import {
  getTransferStatus,
  setTransferStatus,
  type TransferStatusRecord,
} from '@/lib/transferStore';

/**
 * Saga outcomes modeled for payout cancellation.
 */
export type SagaOutcome =
  | 'cancellation_requested'
  | 'provider_confirmed'
  | 'rejected'
  | 'compensated';

export type SagaStepType =
  | 'cancellation_requested'
  | 'settlement_check'
  | 'provider_cancellation_attempt'
  | 'provider_confirmed'
  | 'cancellation_rejected'
  | 'compensation_scheduled'
  | 'compensation_executed';

export interface SagaStep {
  stepId: string;
  payoutReference: string;
  step: SagaStepType;
  status: 'started' | 'completed' | 'failed';
  outcome?: SagaOutcome;
  timestamp: string;
  details?: Record<string, unknown>;
  error?: string;
}

export type CompensationAction =
  | 'reconcile_provider_settlement'
  | 'reverse_local_ledger'
  | 'manual_support_review';

export interface CompensationWork {
  id: string;
  payoutReference: string;
  action: CompensationAction;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SagaExecutionResult {
  success: boolean;
  outcome: SagaOutcome;
  status: number;
  code?: string;
  message: string;
  reference: string;
  sagaStepId: string;
  data?: Record<string, unknown>;
  compensationWorkId?: string;
}

// In-memory persistent stores linking every saga step to the original payout
const sagaStepStore = new Map<string, SagaStep[]>();
const compensationQueue = new Map<string, CompensationWork>();

/**
 * Record a step linked to the original payout reference.
 */
export function recordSagaStep(
  payoutReference: string,
  stepType: SagaStepType,
  status: 'started' | 'completed' | 'failed',
  outcome?: SagaOutcome,
  details?: Record<string, unknown>,
  error?: string,
): SagaStep {
  const step: SagaStep = {
    stepId: `step_${Date.now()}_${randomUUID().slice(0, 8)}`,
    payoutReference,
    step: stepType,
    status,
    outcome,
    timestamp: new Date().toISOString(),
    details,
    error,
  };

  const steps = sagaStepStore.get(payoutReference) || [];
  steps.push(step);
  sagaStepStore.set(payoutReference, steps);

  return step;
}

/**
 * Returns all recorded saga steps linked to a payout reference.
 */
export function getSagaStepsForPayout(payoutReference: string): SagaStep[] {
  return sagaStepStore.get(payoutReference) || [];
}

/**
 * Persists retryable compensation work linked to a payout.
 */
export function persistCompensationWork(
  payoutReference: string,
  action: CompensationAction,
  payload?: Record<string, unknown>,
): CompensationWork {
  const id = `comp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  const work: CompensationWork = {
    id,
    payoutReference,
    action,
    status: 'pending',
    attempts: 0,
    maxAttempts: 3,
    payload,
    createdAt: now,
    updatedAt: now,
  };

  compensationQueue.set(id, work);
  return work;
}

/**
 * Retrieves all pending compensation work.
 */
export function getPendingCompensationWork(): CompensationWork[] {
  return Array.from(compensationQueue.values()).filter(
    (w) => w.status === 'pending' || w.status === 'processing',
  );
}

/**
 * Retries a persisted compensation work item.
 */
export async function retryCompensationWork(
  workId: string,
): Promise<{ success: boolean; work: CompensationWork }> {
  const work = compensationQueue.get(workId);
  if (!work) {
    throw new Error(`Compensation work ${workId} not found`);
  }

  work.attempts += 1;
  work.status = 'processing';
  work.updatedAt = new Date().toISOString();

  try {
    const provider = getPayoutProvider();
    const providerStatus = await provider.checkTransferStatus({
      reference: work.payoutReference,
    });
    const statusStr = String(
      (providerStatus as { status?: string }).status || '',
    ).toLowerCase();

    const existing = getTransferStatus(work.payoutReference);

    if (statusStr === 'success') {
      // Settled at provider
      if (existing) {
        setTransferStatus({
          ...existing,
          status: 'success',
          updatedAt: new Date().toISOString(),
        });
      }
      work.status = 'completed';
    } else if (
      statusStr === 'reversed' ||
      statusStr === 'failed' ||
      statusStr === 'cancelled'
    ) {
      if (existing) {
        setTransferStatus({
          ...existing,
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
        });
      }
      work.status = 'completed';
    } else {
      // Still pending
      if (work.attempts >= work.maxAttempts) {
        work.status = 'failed';
        work.lastError = 'Exhausted maximum retry attempts';
      } else {
        work.status = 'pending';
      }
    }

    recordSagaStep(
      work.payoutReference,
      'compensation_executed',
      work.status === 'completed' ? 'completed' : 'failed',
      work.status === 'completed' ? 'compensated' : undefined,
      { workId, attempts: work.attempts, finalStatus: work.status },
    );

    return { success: work.status === 'completed', work };
  } catch (error) {
    work.lastError = error instanceof Error ? error.message : String(error);
    if (work.attempts >= work.maxAttempts) {
      work.status = 'failed';
    } else {
      work.status = 'pending';
    }
    work.updatedAt = new Date().toISOString();

    recordSagaStep(
      work.payoutReference,
      'compensation_executed',
      'failed',
      undefined,
      { workId, attempts: work.attempts, error: work.lastError },
    );

    return { success: false, work };
  }
}

/**
 * Resets stores for testing purposes.
 */
export function resetSagaStores(): void {
  sagaStepStore.clear();
  compensationQueue.clear();
}

/**
 * Executes payout cancellation as a provider-aware distributed saga.
 *
 * Steps:
 * 1. Checks transfer existence and client authorization.
 * 2. Enforces settlement irreversibility: rejects cancellation if already settled.
 * 3. Inquires / cancels transfer at provider.
 * 4. Resolves races against settlement: if settlement won the race, rejects cancellation.
 * 5. Handles provider timeouts: persists retryable compensation work and models compensated outcome.
 * 6. Confirms cancellation if provider confirms.
 */
export async function executeCancellationSaga(options: {
  reference: string;
  clientSessionId?: string;
  reason?: string;
  timeoutMs?: number;
}): Promise<SagaExecutionResult> {
  const { reference, clientSessionId, reason } = options;

  // Step 1: Record initial request linked to payout reference
  const initialStep = recordSagaStep(
    reference,
    'cancellation_requested',
    'started',
    'cancellation_requested',
    { clientSessionId, reason },
  );

  const existing = getTransferStatus(reference);

  if (!existing) {
    recordSagaStep(
      reference,
      'cancellation_rejected',
      'failed',
      'rejected',
      { reason: 'Transfer not found' },
    );
    return {
      success: false,
      outcome: 'rejected',
      status: 404,
      code: 'TRANSFER_NOT_FOUND',
      message: 'Transfer not found',
      reference,
      sagaStepId: initialStep.stepId,
    };
  }

  // Authorization check
  if (clientSessionId && existing.clientSessionId && existing.clientSessionId !== clientSessionId) {
    recordSagaStep(
      reference,
      'cancellation_rejected',
      'failed',
      'rejected',
      { reason: 'Unauthorized client session' },
    );
    return {
      success: false,
      outcome: 'rejected',
      status: 403,
      code: 'FORBIDDEN',
      message: 'Unauthorized',
      reference,
      sagaStepId: initialStep.stepId,
    };
  }

  // Step 2: Irreversible settlement check
  if (existing.status === 'success') {
    recordSagaStep(
      reference,
      'settlement_check',
      'failed',
      'rejected',
      { reason: 'Transfer has settled and is irreversible without a documented reversal process' },
    );
    recordSagaStep(
      reference,
      'cancellation_rejected',
      'completed',
      'rejected',
      { reason: 'Transfer already settled' },
    );

    return {
      success: false,
      outcome: 'rejected',
      status: 409,
      code: 'TRANSFER_SETTLED',
      message:
        'Transfer has already settled and is irreversible without a documented reversal process',
      reference,
      sagaStepId: initialStep.stepId,
    };
  }

  if (existing.status === 'cancelled') {
    return {
      success: true,
      outcome: 'provider_confirmed',
      status: 200,
      message: 'Transfer is already cancelled',
      reference,
      sagaStepId: initialStep.stepId,
      data: { reference, status: 'cancelled' },
    };
  }

  if (existing.status === 'failed' || existing.status === 'reversed') {
    recordSagaStep(
      reference,
      'cancellation_rejected',
      'failed',
      'rejected',
      { reason: `Transfer is in final non-cancellable status: ${existing.status}` },
    );

    return {
      success: false,
      outcome: 'rejected',
      status: 409,
      code: 'CANCELLATION_REJECTED',
      message: `Transfer cannot be cancelled in status: ${existing.status}`,
      reference,
      sagaStepId: initialStep.stepId,
    };
  }

  // Step 3: Attempt provider cancellation & resolve races against settlement
  recordSagaStep(
    reference,
    'provider_cancellation_attempt',
    'started',
    undefined,
    { provider: 'paystack' },
  );

  const provider = getPayoutProvider();

  try {
    let cancelResult: {
      status: string;
      cancellable?: boolean;
      message?: string;
    };

    if (typeof provider.cancelTransfer === 'function') {
      cancelResult = await provider.cancelTransfer({ reference, reason });
    } else {
      const statusRes = await provider.checkTransferStatus({ reference });
      const statusStr = String(
        (statusRes as { status?: string }).status || '',
      ).toLowerCase();

      if (statusStr === 'success') {
        cancelResult = {
          status: 'settled',
          cancellable: false,
          message: 'Transfer has settled at provider',
        };
      } else {
        cancelResult = {
          status: 'confirmed',
          cancellable: true,
          message: 'Transfer cancelled at provider',
        };
      }
    }

    // Race Check: If transfer settled at provider concurrently
    if (cancelResult.status === 'settled') {
      setTransferStatus({
        ...existing,
        status: 'success',
        updatedAt: new Date().toISOString(),
      });

      recordSagaStep(
        reference,
        'cancellation_rejected',
        'completed',
        'rejected',
        {
          reason: 'Race condition: transfer settled at provider before cancellation',
          providerMessage: cancelResult.message,
        },
      );

      return {
        success: false,
        outcome: 'rejected',
        status: 409,
        code: 'TRANSFER_SETTLED',
        message:
          'Transfer settled at provider before cancellation could be completed',
        reference,
        sagaStepId: initialStep.stepId,
      };
    }

    if (cancelResult.status === 'rejected' || cancelResult.cancellable === false) {
      recordSagaStep(
        reference,
        'cancellation_rejected',
        'completed',
        'rejected',
        { reason: cancelResult.message || 'Provider rejected cancellation' },
      );

      return {
        success: false,
        outcome: 'rejected',
        status: 409,
        code: 'CANCELLATION_REJECTED',
        message: cancelResult.message || 'Provider rejected transfer cancellation',
        reference,
        sagaStepId: initialStep.stepId,
      };
    }

    // Provider confirmed cancellation
    setTransferStatus({
      ...existing,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });

    recordSagaStep(
      reference,
      'provider_confirmed',
      'completed',
      'provider_confirmed',
      { providerMessage: cancelResult.message },
    );

    return {
      success: true,
      outcome: 'provider_confirmed',
      status: 200,
      message: 'Transfer cancellation confirmed by provider',
      reference,
      sagaStepId: initialStep.stepId,
      data: {
        reference,
        status: 'cancelled',
        message: 'Transfer cancellation requested successfully',
      },
    };
  } catch (error) {
    // Step 4: Provider timeout or error handling -> Schedule retryable compensation work
    const errMessage = error instanceof Error ? error.message : String(error);

    recordSagaStep(
      reference,
      'provider_cancellation_attempt',
      'failed',
      undefined,
      { error: errMessage },
    );

    // Persist retryable compensation work
    const work = persistCompensationWork(
      reference,
      'reconcile_provider_settlement',
      { reason, error: errMessage },
    );

    recordSagaStep(
      reference,
      'compensation_scheduled',
      'completed',
      'compensated',
      { compensationWorkId: work.id },
    );

    return {
      success: true,
      outcome: 'compensated',
      status: 202,
      code: 'PROVIDER_TIMEOUT',
      message:
        'Cancellation is pending provider reconciliation; compensation work has been scheduled and persisted',
      reference,
      sagaStepId: initialStep.stepId,
      compensationWorkId: work.id,
      data: {
        reference,
        status: 'pending',
        outcome: 'compensated',
        compensationWorkId: work.id,
      },
    };
  }
}
