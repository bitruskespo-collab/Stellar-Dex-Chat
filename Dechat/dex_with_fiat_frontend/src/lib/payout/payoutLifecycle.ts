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

/**
 * Deterministic, credential-free payout fixtures for cross-browser smoke
 * coverage. References are synthetic and must never be replaced with real
 * provider identifiers or user data.
 */
export const PAYOUT_SMOKE_FIXTURES = {
  success: {
    reference: 'smoke-payout-success-0001',
    providerReference: 'smoke-provider-success-0001',
    amount: '25.00',
    currency: 'USD',
    path: ['initiated', 'pending', 'success'] as const,
  },
  failed: {
    reference: 'smoke-payout-failed-0001',
    providerReference: 'smoke-provider-failed-0001',
    amount: '25.00',
    currency: 'USD',
    path: ['initiated', 'pending', 'failed'] as const,
  },
  cancelled: {
    reference: 'smoke-payout-cancelled-0001',
    providerReference: 'smoke-provider-cancelled-0001',
    amount: '25.00',
    currency: 'USD',
    path: ['initiated', 'pending', 'cancelled'] as const,
  },
} as const;

export type PayoutSmokeScenario = keyof typeof PAYOUT_SMOKE_FIXTURES;

export interface PayoutLifecycleResult {
  reference: string;
  status: PayoutStatus;
  history: PayoutTransitionRecord[];
}

/**
 * Replays a payout status path against the transition rules, producing a
 * deterministic transition history. Throws InvalidPayoutTransitionError when
 * any step violates the lifecycle contract.
 */
export function replayPayoutLifecycle(
  reference: string,
  path: readonly PayoutStatus[],
  options: {
    actor?: PayoutActor | string;
    providerReference?: string;
    timestamp?: string;
  } = {},
): PayoutLifecycleResult {
  const actor = options.actor ?? 'system';
  const timestamp = options.timestamp ?? '1970-01-01T00:00:00.000Z';
  let current: PayoutStatus | 'none' = 'none';
  const history: PayoutTransitionRecord[] = [];

  for (const target of path) {
    validatePayoutTransition(current, target, reference);
    if (current !== target) {
      history.push({
        fromStatus: current,
        toStatus: target,
        actor,
        providerReference: options.providerReference,
        timestamp,
      });
    }
    current = target;
  }

  return { reference, status: current as PayoutStatus, history };
}

/**
 * Builds the deterministic lifecycle result for a named smoke scenario.
 */
export function buildPayoutSmokeScenario(
  scenario: PayoutSmokeScenario,
): PayoutLifecycleResult {
  const fixture = PAYOUT_SMOKE_FIXTURES[scenario];
  return replayPayoutLifecycle(fixture.reference, fixture.path, {
    actor: 'webhook',
    providerReference: fixture.providerReference,
  });
}
