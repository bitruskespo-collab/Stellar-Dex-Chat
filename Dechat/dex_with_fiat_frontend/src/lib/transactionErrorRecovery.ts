/**
 * Transaction Error Recovery & Diagnostic Module
 * Addresses Issue #67: Turn contract and wallet failures into actionable guidance
 * while preserving technical details for support and avoiding accidental resubmission.
 */

export interface DiagnosticDetails {
  correlationId: string;
  errorCode?: string | number;
  category: 'contract' | 'wallet' | 'network' | 'validation' | 'unknown';
  isRetryable: boolean;
  safeMessage: string;
  actionGuidance: string;
  rawDetailsSanitized?: string;
  timestamp: number;
}

/** Known Soroban and Wallet error code mappings */
export const CONTRACT_ERROR_MAPPINGS: Record<
  number | string,
  { message: string; action: string; retryable: boolean }
> = {
  1001: {
    message: 'Insufficient balance to complete this transaction.',
    action: 'Fund your wallet with additional XLM or reduce the transfer amount.',
    retryable: false,
  },
  1002: {
    message: 'Caller is unauthorized or denied by security policy.',
    action: 'Verify your connected wallet address and permissions.',
    retryable: false,
  },
  1003: {
    message: 'Contract circuit breaker is currently active.',
    action: 'Wait for the cooling period or contact operator support.',
    retryable: false,
  },
  1004: {
    message: 'The submitted transfer amount is invalid or zero.',
    action: 'Enter a valid amount above the minimum threshold.',
    retryable: false,
  },
  1005: {
    message: 'The selected asset is not in the contract token allowlist.',
    action: 'Select a supported token (e.g. USDC or native XLM).',
    retryable: false,
  },
  1006: {
    message: 'The withdrawal transaction request has expired.',
    action: 'Initiate a new withdrawal transaction.',
    retryable: false,
  },
  1007: {
    message: 'Nonce mismatch or duplicate transaction detected.',
    action: 'Sync your wallet account sequence and retry.',
    retryable: true,
  },
  1008: {
    message: 'Daily account transaction limit reached.',
    action: 'Try again after the daily reset period.',
    retryable: false,
  },
  // Wallet / Network errors
  'USER_DECLINED': {
    message: 'Transaction signature was rejected in Freighter.',
    action: 'Review and approve the transaction in your wallet when ready.',
    retryable: true,
  },
  'NETWORK_TIMEOUT': {
    message: 'Network request to Horizon or Soroban RPC timed out.',
    action: 'Check your internet connection and retry.',
    retryable: true,
  },
  'RATE_LIMITED': {
    message: 'RPC node rate limit encountered.',
    action: 'Wait a few seconds before retrying.',
    retryable: true,
  },
};

/** Redact sensitive strings like secret keys (S...) or private seeds */
export function sanitizeDiagnostics(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/S[A-Z0-9]{55}/g, '[REDACTED_SECRET_KEY]')
    .replace(/ghp_[A-Za-z0-9]+/g, '[REDACTED_PAT]')
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED_TOKEN]');
}

/**
 * Classify a contract or wallet error into actionable guidance.
 */
export function classifyTransactionError(
  error: unknown,
  correlationId: string = ''
): DiagnosticDetails {
  const generatedId = correlationId || `tx-err-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const errString = error instanceof Error ? error.message : String(error || '');
  const sanitized = sanitizeDiagnostics(errString);

  // Check for known error codes
  for (const [code, info] of Object.entries(CONTRACT_ERROR_MAPPINGS)) {
    if (errString.includes(`Error(${code})`) || errString.includes(`code ${code}`) || errString.includes(code)) {
      return {
        correlationId: generatedId,
        errorCode: code,
        category: 'contract',
        isRetryable: info.retryable,
        safeMessage: info.message,
        actionGuidance: info.action,
        rawDetailsSanitized: sanitized,
        timestamp: Date.now(),
      };
    }
  }

  if (errString.toLowerCase().includes('user declined') || errString.toLowerCase().includes('rejected')) {
    const info = CONTRACT_ERROR_MAPPINGS['USER_DECLINED'];
    return {
      correlationId: generatedId,
      errorCode: 'USER_DECLINED',
      category: 'wallet',
      isRetryable: info.retryable,
      safeMessage: info.message,
      actionGuidance: info.action,
      rawDetailsSanitized: sanitized,
      timestamp: Date.now(),
    };
  }

  if (errString.toLowerCase().includes('timeout') || errString.toLowerCase().includes('network')) {
    const info = CONTRACT_ERROR_MAPPINGS['NETWORK_TIMEOUT'];
    return {
      correlationId: generatedId,
      errorCode: 'NETWORK_TIMEOUT',
      category: 'network',
      isRetryable: info.retryable,
      safeMessage: info.message,
      actionGuidance: info.action,
      rawDetailsSanitized: sanitized,
      timestamp: Date.now(),
    };
  }

  return {
    correlationId: generatedId,
    errorCode: 'UNKNOWN_ERROR',
    category: 'unknown',
    isRetryable: false,
    safeMessage: 'An unexpected transaction error occurred.',
    actionGuidance: 'Please contact support with the correlation ID below.',
    rawDetailsSanitized: sanitized,
    timestamp: Date.now(),
  };
}
