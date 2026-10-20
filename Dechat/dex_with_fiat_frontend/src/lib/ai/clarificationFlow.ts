/**
 * Confidence-Gated Clarification Flow
 * Addresses Issue #75: Prevent the assistant from opening a deposit or payout flow
 * when required details are uncertain or contradictory.
 */

export interface ClarificationConfig {
  minConfidenceThreshold: number;
  requiredFields: string[];
}

export const DEFAULT_CLARIFICATION_CONFIG: ClarificationConfig = {
  minConfidenceThreshold: 0.8,
  requiredFields: ['amount', 'asset', 'destination'],
};

export interface VerifiedIntentState {
  amount?: string;
  asset?: string;
  destination?: string;
  network?: string;
}

export interface ClarificationStep {
  needsClarification: boolean;
  targetField?: string;
  promptQuestion?: string;
  verifiedState: VerifiedIntentState;
  reinterpretationRequiresConfirmation: boolean;
}

/**
 * Evaluates whether an intent proposal needs targeted clarification
 * and generates exactly one targeted question at a time while retaining
 * prior verified fields.
 */
export function evaluateClarificationNeed(
  currentInput: { amount?: string; asset?: string; destination?: string; confidence: number },
  priorState: VerifiedIntentState = {},
  config: ClarificationConfig = DEFAULT_CLARIFICATION_CONFIG
): ClarificationStep {
  // Retain verified values
  const updatedState: VerifiedIntentState = {
    amount: priorState.amount || currentInput.amount,
    asset: priorState.asset || currentInput.asset,
    destination: priorState.destination || currentInput.destination,
    network: priorState.network || 'TESTNET',
  };

  // Detect reinterpretation (changing an already verified field)
  let reinterpretation = false;
  if (priorState.amount && currentInput.amount && priorState.amount !== currentInput.amount) {
    reinterpretation = true;
  }
  if (priorState.asset && currentInput.asset && priorState.asset !== currentInput.asset) {
    reinterpretation = true;
  }

  // 1. Check confidence threshold
  if (currentInput.confidence < config.minConfidenceThreshold) {
    if (!updatedState.asset) {
      return {
        needsClarification: true,
        targetField: 'asset',
        promptQuestion: 'Which asset would you like to use (e.g., XLM or USDC)?',
        verifiedState: updatedState,
        reinterpretationRequiresConfirmation: reinterpretation,
      };
    }
    if (!updatedState.amount) {
      return {
        needsClarification: true,
        targetField: 'amount',
        promptQuestion: `How much ${updatedState.asset} would you like to send?`,
        verifiedState: updatedState,
        reinterpretationRequiresConfirmation: reinterpretation,
      };
    }
    if (!updatedState.destination) {
      return {
        needsClarification: true,
        targetField: 'destination',
        promptQuestion: 'What is the recipient Stellar address or bank account?',
        verifiedState: updatedState,
        reinterpretationRequiresConfirmation: reinterpretation,
      };
    }
  }

  // 2. Check missing required fields
  for (const field of config.requiredFields) {
    if (!updatedState[field as keyof VerifiedIntentState]) {
      return {
        needsClarification: true,
        targetField: field,
        promptQuestion: `Please specify the transaction ${field}.`,
        verifiedState: updatedState,
        reinterpretationRequiresConfirmation: reinterpretation,
      };
    }
  }

  return {
    needsClarification: false,
    verifiedState: updatedState,
    reinterpretationRequiresConfirmation: reinterpretation,
  };
}
