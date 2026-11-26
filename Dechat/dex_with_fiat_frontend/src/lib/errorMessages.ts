/**
 * Accessible Error Messages — Issue #294
 *
 * Maps typed API and wallet errors to actionable, localized messages.
 * - Keeps sensitive technical details out of user-facing strings.
 * - Returns the first blocking field name so callers can programmatically
 *   associate the message with the offending input via aria-describedby.
 * - Safe values (amounts, notes) are preserved and returned so forms can
 *   re-hydrate their fields after a failure.
 */

import { sanitizeDiagnostics } from './transactionErrorRecovery';

/** Discriminated error categories understood by the UI layer. */
export type ErrorCategory =
  | 'validation'
  | 'contract'
  | 'wallet'
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'unknown';

/** A structured, user-safe error ready for display. */
export interface AccessibleError {
  message: string;
  action: string;
  category: ErrorCategory;
  /**
   * Stable machine code (e.g. `CONTRACT_401`, `HTTP_429`, `USER_DECLINED`).
   * Optional because callers may already have an `AccessibleError` from a
   * non-coded source. UI text must be resolved from this code, never from the
   * message strings below, so translations cannot change safety decisions.
   */
  code?: string;
  fieldId?: string;
  isRetryable: boolean;
  safeValues?: Record<string, string>;
}

interface ErrorEntry {
  message: string;
  action: string;
  category: ErrorCategory;
  isRetryable: boolean;
}

export const CONTRACT_ERROR_MESSAGES: Readonly<
  Record<number | string, ErrorEntry>
> = {
  101: { message: 'The contract has not been initialized.', action: 'Contact support.', category: 'contract', isRetryable: false },
  102: { message: 'The contract has already been initialized.', action: 'No action required.', category: 'contract', isRetryable: false },
  103: { message: 'An internal invariant was violated.', action: 'Contact support with the correlation ID.', category: 'contract', isRetryable: false },
  201: { message: 'You are not authorized to perform this action.', action: 'Verify the connected wallet address and permissions.', category: 'auth', isRetryable: false },
  202: { message: 'This action is not permitted.', action: 'Verify the connected wallet address and permissions.', category: 'auth', isRetryable: false },
  203: { message: 'No pending admin to accept.', action: 'Contact an operator.', category: 'contract', isRetryable: false },
  204: { message: 'The recipient address is invalid for this operation.', action: 'Enter a valid Stellar public key.', category: 'validation', isRetryable: false },
  205: { message: 'You are not registered as an operator.', action: 'Contact support to request operator access.', category: 'auth', isRetryable: false },
  301: { message: 'The amount must be greater than zero.', action: 'Enter a positive amount.', category: 'validation', isRetryable: false },
  302: { message: 'The amount exceeds the per-token transfer limit.', action: 'Reduce the amount and try again.', category: 'validation', isRetryable: false },
  303: { message: 'The configured limit cap has been reached.', action: 'Contact support.', category: 'contract', isRetryable: false },
  304: { message: 'Your daily deposit limit has been reached.', action: 'Try again after the daily reset period.', category: 'contract', isRetryable: false },
  305: { message: 'Your daily fiat-equivalent volume limit has been exceeded.', action: 'Try again after the daily reset period.', category: 'contract', isRetryable: false },
  306: { message: 'The deposit reference is too long.', action: 'Shorten the reference and retry.', category: 'validation', isRetryable: false },
  307: { message: 'A security cooldown is active for your account.', action: 'Wait for the cooldown to expire, then retry.', category: 'contract', isRetryable: true },
  308: { message: 'An anti-sandwich delay is currently active.', action: 'Wait a few seconds, then retry.', category: 'contract', isRetryable: true },
  309: { message: 'This token is not supported by the bridge.', action: 'Select a supported token such as XLM or USDC.', category: 'validation', isRetryable: false },
  310: { message: 'Your address is not allowed to perform this action.', action: 'Verify the connected wallet and permissions.', category: 'auth', isRetryable: false },
  311: { message: 'Rescue of this token is not permitted.', action: 'Contact support.', category: 'contract', isRetryable: false },
  401: { message: 'Insufficient balance to complete this transaction.', action: 'Fund your wallet with additional XLM or reduce the transfer amount.', category: 'contract', isRetryable: false },
  402: { message: 'No accrued fees are available to withdraw.', action: 'No action required.', category: 'contract', isRetryable: false },
  501: { message: 'The withdrawal request does not exist.', action: 'Verify the request ID and retry.', category: 'contract', isRetryable: false },
  502: { message: 'The withdrawal is still within its lock period.', action: 'Wait for the lock period to expire, then retry.', category: 'contract', isRetryable: true },
  601: { message: 'The admin action ID does not exist.', action: 'Verify the action ID and retry.', category: 'contract', isRetryable: false },
  602: { message: 'The admin action is still within its timelock period.', action: 'Wait for the timelock to expire (minimum 48 h), then retry.', category: 'contract', isRetryable: true },
  603: { message: 'The required inactivity period for emergency recovery has not elapsed.', action: 'Wait for the inactivity period to pass.', category: 'contract', isRetryable: true },
  604: { message: 'No emergency recovery address has been configured.', action: 'Contact an operator to configure recovery.', category: 'contract', isRetryable: false },
  701: { message: 'No price oracle has been configured.', action: 'Contact support.', category: 'contract', isRetryable: false },
  702: { message: 'The price oracle returned an invalid value.', action: 'Retry in a few moments.', category: 'network', isRetryable: true },
  703: { message: 'Price slippage exceeds the allowed threshold.', action: 'Retry the transaction or adjust the amount.', category: 'contract', isRetryable: true },
  801: { message: 'Your daily withdrawal quota has been exceeded.', action: 'Try again after the daily reset period.', category: 'contract', isRetryable: false },
  802: { message: 'The escrow migration has already been completed.', action: 'No action required.', category: 'contract', isRetryable: false },
  803: { message: 'One or more batch operations failed.', action: 'Review the individual results and retry failed items.', category: 'contract', isRetryable: true },
  901: { message: 'The transaction nonce is invalid.', action: 'Sync your wallet account sequence and retry.', category: 'contract', isRetryable: true },
  902: { message: 'This transaction nonce has already been used.', action: 'Sync your wallet account sequence and retry.', category: 'contract', isRetryable: false },
  USER_DECLINED: { message: 'You declined the transaction in Freighter.', action: 'Review and approve the transaction in your wallet when ready.', category: 'wallet', isRetryable: true },
  NETWORK_TIMEOUT: { message: 'The network request timed out.', action: 'Check your internet connection and retry.', category: 'network', isRetryable: true },
  RATE_LIMITED: { message: 'The RPC node is rate-limiting requests.', action: 'Wait a few seconds and retry.', category: 'network', isRetryable: true },
  WALLET_CONTEXT_CHANGED: { message: 'Your wallet account or network changed during the transaction.', action: 'Confirm the new context and rebuild the transaction.', category: 'wallet', isRetryable: true },
  SESSION_EXPIRED: { message: 'Your wallet session has expired.', action: 'Reconnect Freighter to continue.', category: 'auth', isRetryable: false },
  WALLET_DISCONNECTED: { message: 'Your wallet is not connected.', action: 'Connect Freighter to continue.', category: 'wallet', isRetryable: false },
};

const HTTP_STATUS_MESSAGES: Readonly<Record<number, ErrorEntry>> = {
  400: { message: 'The request was invalid.', action: 'Review the form values and try again.', category: 'validation', isRetryable: false },
  401: { message: 'You are not authorized to perform this action.', action: 'Reconnect your wallet and try again.', category: 'auth', isRetryable: false },
  403: { message: 'Access denied.', action: 'Verify your wallet address has the required permissions.', category: 'auth', isRetryable: false },
  404: { message: 'The requested resource was not found.', action: 'Verify the details and try again.', category: 'unknown', isRetryable: false },
  409: { message: 'This request conflicts with another operation.', action: 'Wait for the other operation to complete, then retry.', category: 'contract', isRetryable: true },
  422: { message: 'The submitted data could not be processed.', action: 'Check the form values and try again.', category: 'validation', isRetryable: false },
  429: { message: 'Too many requests. The service is rate-limiting your account.', action: 'Wait a moment and retry.', category: 'rate_limit', isRetryable: true },
  500: { message: 'The server encountered an unexpected error.', action: 'Try again in a moment. Contact support if the problem persists.', category: 'unknown', isRetryable: true },
  502: { message: 'The gateway returned an error.', action: 'Try again in a moment.', category: 'network', isRetryable: true },
  503: { message: 'The service is temporarily unavailable.', action: 'Try again in a moment.', category: 'network', isRetryable: true },
  504: { message: 'The gateway timed out waiting for a response.', action: 'Check your connection and try again.', category: 'network', isRetryable: true },
};

/**
 * Safety metadata for a machine code. This is intentionally independent of
 * translated text and of raw diagnostics: an unrecognized code is never
 * treated as retryable, and unlisted contract codes keep the conservative
 * contract category instead of inheriting keyword guesses.
 */
export function classificationForCode(code: string): Pick<
  AccessibleError,
  'category' | 'isRetryable'
> {
  if (code.startsWith('HTTP_')) {
    const status = Number(code.slice('HTTP_'.length));
    return HTTP_STATUS_MESSAGES[status] ?? {
      category: 'unknown',
      isRetryable: false,
    };
  }
  if (code.startsWith('CONTRACT_')) {
    const numeric = Number(code.slice('CONTRACT_'.length));
    return CONTRACT_ERROR_MESSAGES[numeric] ?? {
      category: 'contract',
      isRetryable: false,
    };
  }
  return CONTRACT_ERROR_MESSAGES[code] ?? {
    category: 'unknown',
    isRetryable: false,
  };
}

interface ErrorClassificationOptions {
  httpStatus?: number;
  fieldId?: string;
  safeValues?: Record<string, string>;
}

function withCode(
  entry: ErrorEntry,
  code: string,
  options: ErrorClassificationOptions,
): AccessibleError {
  return {
    ...entry,
    code,
    fieldId: options.fieldId,
    safeValues: options.safeValues,
  };
}

export function classifyError(
  error: unknown,
  options: ErrorClassificationOptions = {},
): AccessibleError {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();
  const { httpStatus } = options;

  if (httpStatus !== undefined && HTTP_STATUS_MESSAGES[httpStatus]) {
    return withCode(
      HTTP_STATUS_MESSAGES[httpStatus],
      `HTTP_${httpStatus}`,
      options,
    );
  }

  // An explicit HTTP status in diagnostics must never be reinterpreted as a
  // Soroban code (e.g. "HTTP 504" is a gateway timeout, not contract 504).
  const textStatus = raw.match(
    /\b(?:HTTP|status(?:Code)?)\s*[:=]?\s*(\d{3})\b/i,
  );
  if (textStatus) {
    const status = Number(textStatus[1]);
    if (HTTP_STATUS_MESSAGES[status]) {
      return withCode(HTTP_STATUS_MESSAGES[status], `HTTP_${status}`, options);
    }
  }

  const stringCodes = ['USER_DECLINED', 'NETWORK_TIMEOUT', 'RATE_LIMITED', 'WALLET_CONTEXT_CHANGED', 'SESSION_EXPIRED', 'WALLET_DISCONNECTED'] as const;
  for (const code of stringCodes) {
    if (raw.includes(code) || lower.includes(code.toLowerCase())) {
      return withCode(CONTRACT_ERROR_MESSAGES[code], code, options);
    }
  }

  const codeMatch = raw.match(/(?:Error\(|code\s+)(\d{3,4})\)?/);
  if (codeMatch) {
    const numeric = Number(codeMatch[1]);
    if (CONTRACT_ERROR_MESSAGES[numeric]) {
      return withCode(
        CONTRACT_ERROR_MESSAGES[numeric],
        `CONTRACT_${numeric}`,
        options,
      );
    }
  }

  const bareCode = raw.match(/\b(1\d{2}|2\d{2}|3\d{2}|4\d{2}|5\d{2}|6\d{2}|7\d{2}|8\d{2}|9\d{2})\b/);
  if (bareCode) {
    const numeric = Number(bareCode[1]);
    if (CONTRACT_ERROR_MESSAGES[numeric]) {
      return withCode(
        CONTRACT_ERROR_MESSAGES[numeric],
        `CONTRACT_${numeric}`,
        options,
      );
    }
  }

  if (lower.includes('user declined') || lower.includes('rejected') || lower.includes('user rejected')) {
    return withCode(CONTRACT_ERROR_MESSAGES['USER_DECLINED'], 'USER_DECLINED', options);
  }
  if (lower.includes('session expired') || lower.includes('session has expired')) {
    return withCode(CONTRACT_ERROR_MESSAGES['SESSION_EXPIRED'], 'SESSION_EXPIRED', options);
  }
  if (lower.includes('not connected') || lower.includes('disconnected') || lower.includes('wallet is not connected')) {
    return withCode(CONTRACT_ERROR_MESSAGES['WALLET_DISCONNECTED'], 'WALLET_DISCONNECTED', options);
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('failed to fetch') || lower.includes('network') || lower.includes('load failed')) {
    return withCode(CONTRACT_ERROR_MESSAGES['NETWORK_TIMEOUT'], 'NETWORK_TIMEOUT', options);
  }
  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return withCode(CONTRACT_ERROR_MESSAGES['RATE_LIMITED'], 'RATE_LIMITED', options);
  }
  if (lower.includes('unauthorized') || lower.includes('not authorized')) {
    return withCode(HTTP_STATUS_MESSAGES[401], 'HTTP_401', options);
  }

  const sanitized = sanitizeDiagnostics(raw);
  const nothingRedacted = sanitized === raw;
  const isSafe = nothingRedacted && raw.length > 0 && raw.length < 200;
  return {
    message: isSafe ? sanitized : 'An unexpected error occurred.',
    action: 'Please try again. Contact support if the problem persists.',
    category: 'unknown',
    code: 'UNKNOWN',
    isRetryable: true,
    fieldId: options.fieldId,
    safeValues: options.safeValues,
  };
}

export function fieldAriaDescribedBy(
  fieldId: string,
  activeError: AccessibleError | null | undefined,
  errorElementSuffix = '-error',
): string | undefined {
  if (!activeError?.fieldId) return undefined;
  if (activeError.fieldId !== fieldId) return undefined;
  return `${fieldId}${errorElementSuffix}`;
}

export function buildErrorSummary(
  error: AccessibleError | null | undefined,
): string | null {
  if (!error) return null;
  if (!error.action) return error.message;
  return `${error.message} ${error.action}`;
}
