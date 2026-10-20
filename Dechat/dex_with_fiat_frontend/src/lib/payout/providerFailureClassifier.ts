/**
 * Provider Failure Classifier
 * Addresses Issue #103: Translate provider errors into stable domain outcomes
 * while retaining safe operator diagnostics without leaking secrets.
 */

export type FailureCategory =
  | 'VALIDATION_ERROR'
  | 'AUTH_CONFIGURATION'
  | 'RATE_THROTTLED'
  | 'TRANSIENT_OUTAGE'
  | 'TERMINAL_REJECTION'
  | 'AMBIGUOUS_OUTCOME';

export interface ClassifiedOutcome {
  category: FailureCategory;
  isRetryable: boolean;
  recommendedAction: 'retry_with_backoff' | 'reconcile_offline' | 'prompt_user_correction' | 'escalate_operator';
  safeClientMessage: string;
  sanitizedDiagnosticCode: string;
  timestamp: number;
}

const KNOWN_PROVIDER_CODES: Record<string, { category: FailureCategory; retryable: boolean; action: ClassifiedOutcome['recommendedAction']; message: string }> = {
  'invalid_bank_account': {
    category: 'VALIDATION_ERROR',
    retryable: false,
    action: 'prompt_user_correction',
    message: 'The recipient bank account number could not be resolved.',
  },
  'account_name_mismatch': {
    category: 'TERMINAL_REJECTION',
    retryable: false,
    action: 'prompt_user_correction',
    message: 'The recipient account name does not match bank verification.',
  },
  'insufficient_provider_balance': {
    category: 'TRANSIENT_OUTAGE',
    retryable: true,
    action: 'retry_with_backoff',
    message: 'Payout gateway is temporarily rebalancing liquidity.',
  },
  'rate_limit_exceeded': {
    category: 'RATE_THROTTLED',
    retryable: true,
    action: 'retry_with_backoff',
    message: 'Too many requests. Please wait before retrying.',
  },
  'upstream_gateway_timeout': {
    category: 'AMBIGUOUS_OUTCOME',
    retryable: false, // Must reconcile first, do NOT auto-resubmit
    action: 'reconcile_offline',
    message: 'Provider timed out while processing payout. Reconciling status.',
  },
};

/**
 * Classifies an incoming provider error payload into a safe domain outcome.
 */
export function classifyProviderFailure(rawErrorCode: string, provider: string = 'generic'): ClassifiedOutcome {
  const normalized = (rawErrorCode || '').toLowerCase().trim();
  const known = KNOWN_PROVIDER_CODES[normalized];

  if (known) {
    return {
      category: known.category,
      isRetryable: known.retryable,
      recommendedAction: known.action,
      safeClientMessage: known.message,
      sanitizedDiagnosticCode: `${provider.toUpperCase()}_${normalized.toUpperCase()}`,
      timestamp: Date.now(),
    };
  }

  // Handle unknown/malformed codes safely
  return {
    category: 'AMBIGUOUS_OUTCOME',
    isRetryable: false,
    recommendedAction: 'reconcile_offline',
    safeClientMessage: 'An unrecognized provider response was received. Support has been flagged.',
    sanitizedDiagnosticCode: `${provider.toUpperCase()}_UNKNOWN_ERROR`,
    timestamp: Date.now(),
  };
}
