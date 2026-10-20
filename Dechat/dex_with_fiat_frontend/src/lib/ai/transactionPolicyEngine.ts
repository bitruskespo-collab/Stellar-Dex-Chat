/**
 * Explicit Policy Engine for Allowed Transaction Tools
 * Addresses Issue #76: Make transaction permissions independent from prompt wording
 * by evaluating wallet state, network, user intent, limits, and contract policy before exposing tools.
 */

export type PolicyOutcome = 'allow' | 'deny' | 'require_clarification';

export type PolicyDenialReasonCode =
  | 'WALLET_DISCONNECTED'
  | 'NETWORK_MISMATCH'
  | 'EXCEEDS_TRANSFER_LIMIT'
  | 'UNSUPPORTED_INTENT'
  | 'CONTRACT_CIRCUIT_BREAKER'
  | 'ADDRESS_DENYLISTED'
  | 'INSUFFICIENT_CONFIDENCE'
  | 'MISSING_MANDATORY_FIELDS';

export interface PolicyContext {
  walletConnected: boolean;
  walletNetwork: string;
  expectedNetwork: string;
  amount: number;
  maxAmountLimit: number;
  intentType: string;
  circuitBreakerActive: boolean;
  isDenylisted: boolean;
  confidence: number;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasonCode?: PolicyDenialReasonCode;
  safeReasonMessage?: string;
  evaluatedAt: number;
}

/**
 * Evaluates the transaction policy engine against runtime state.
 * Returns safe reason codes without storing raw sensitive prompts.
 */
export function evaluateTransactionPolicy(context: PolicyContext): PolicyDecision {
  const evaluatedAt = Date.now();

  // 1. Wallet connection invariant
  if (!context.walletConnected) {
    return {
      outcome: 'deny',
      reasonCode: 'WALLET_DISCONNECTED',
      safeReasonMessage: 'Freighter wallet is not connected.',
      evaluatedAt,
    };
  }

  // 2. Network alignment invariant
  if (context.walletNetwork.toUpperCase() !== context.expectedNetwork.toUpperCase()) {
    return {
      outcome: 'deny',
      reasonCode: 'NETWORK_MISMATCH',
      safeReasonMessage: `Wallet network (${context.walletNetwork}) does not match required network (${context.expectedNetwork}).`,
      evaluatedAt,
    };
  }

  // 3. Security denylist invariant
  if (context.isDenylisted) {
    return {
      outcome: 'deny',
      reasonCode: 'ADDRESS_DENYLISTED',
      safeReasonMessage: 'Connected account is restricted by protocol security policy.',
      evaluatedAt,
    };
  }

  // 4. Contract circuit breaker invariant
  if (context.circuitBreakerActive) {
    return {
      outcome: 'deny',
      reasonCode: 'CONTRACT_CIRCUIT_BREAKER',
      safeReasonMessage: 'Contract operations are temporarily paused by circuit breaker.',
      evaluatedAt,
    };
  }

  // 5. Transfer limits invariant
  if (context.amount > context.maxAmountLimit) {
    return {
      outcome: 'deny',
      reasonCode: 'EXCEEDS_TRANSFER_LIMIT',
      safeReasonMessage: `Amount ${context.amount} exceeds single transaction limit of ${context.maxAmountLimit}.`,
      evaluatedAt,
    };
  }

  // 6. Confidence check
  if (context.confidence < 0.7) {
    return {
      outcome: 'require_clarification',
      reasonCode: 'INSUFFICIENT_CONFIDENCE',
      safeReasonMessage: 'Transaction intent parameters are ambiguous.',
      evaluatedAt,
    };
  }

  // 7. Allowed intent check
  const allowedIntents = ['deposit', 'withdraw', 'transfer', 'fiat_bridge'];
  if (!allowedIntents.includes(context.intentType.toLowerCase())) {
    return {
      outcome: 'deny',
      reasonCode: 'UNSUPPORTED_INTENT',
      safeReasonMessage: `Unsupported transaction intent: ${context.intentType}.`,
      evaluatedAt,
    };
  }

  return {
    outcome: 'allow',
    evaluatedAt,
  };
}
