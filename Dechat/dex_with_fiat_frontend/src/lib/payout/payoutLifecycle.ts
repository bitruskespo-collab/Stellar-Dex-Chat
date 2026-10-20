export type PayoutStatus =
  | 'initiated'
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export type PayoutActor =
  | 'user'
  | 'admin'
  | 'webhook'
  | 'polling'
  | 'system';

export interface PayoutTransitionRecord {
  fromStatus: PayoutStatus | 'none';
  toStatus: PayoutStatus;
  actor: PayoutActor | string;
  providerReference?: string;
  timestamp: string;
  reason?: string;
}

/**
 * Allowed transitions for payout lifecycle:
 * - initiation -> pending
 * - pending -> success (settlement) | failed | cancelled
 * - success -> reversed (documented reversal handling)
 * - failed, reversed, cancelled -> immutable terminal states
 */
export const ALLOWED_PAYOUT_TRANSITIONS: Record<
  PayoutStatus | 'none',
  readonly PayoutStatus[]
> = {
  none: ['initiated', 'pending'],
  initiated: ['pending', 'failed', 'cancelled'],
  pending: ['success', 'failed', 'cancelled'],
  success: ['reversed'],
  failed: [],
  reversed: [],
  cancelled: [],
};

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'failed',
  'reversed',
  'cancelled',
];

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return TERMINAL_PAYOUT_STATUSES.includes(status);
}

export class InvalidPayoutTransitionError extends Error {
  constructor(
    public readonly reference: string,
    public readonly currentStatus: PayoutStatus | 'none',
    public readonly targetStatus: PayoutStatus,
    message?: string,
  ) {
    super(
      message ??
        `Invalid payout transition for reference "${reference}": cannot transition from "${currentStatus}" to "${targetStatus}".`,
    );
    this.name = 'InvalidPayoutTransitionError';
  }
}

export function canTransitionPayoutStatus(
  currentStatus: PayoutStatus | 'none',
  targetStatus: PayoutStatus,
): boolean {
  if (currentStatus === targetStatus) {
    return true; // Idempotent no-op
  }
  const allowed = ALLOWED_PAYOUT_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(targetStatus) : false;
}

export function validatePayoutTransition(
  currentStatus: PayoutStatus | 'none',
  targetStatus: PayoutStatus,
  reference: string,
): void {
  if (!canTransitionPayoutStatus(currentStatus, targetStatus)) {
    throw new InvalidPayoutTransitionError(
      reference,
      currentStatus,
      targetStatus,
    );
  }
}
