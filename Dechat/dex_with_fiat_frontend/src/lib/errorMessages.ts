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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** Short, actionable, localized message suitable for a summary region. */
  message: string;
  /** Suggested remediation step, or empty when the message is self-contained. */
  action: string;
  /** Broad category — drives icon, colour, and aria-live politeness. */
  category: ErrorCategory;
  /**
   * DOM id of the first field that caused validation to fail, if any.
   * Components set `aria-describedby={fieldErrorId}` on the relevant input
   * and render the message beside that input.
   */
  fieldId?: string;
  /** Whether the user may retry the same operation without changing inputs. */
  isRetryable: boolean;
  /**
   * Input values that are safe to preserve after the failure, keyed by field
   * name.  Callers re-populate controlled inputs from these values so the
   * user does not have to re-type non-sensitive data.
   */
  safeValues?: Record<string, string>;
}

/** Mapping entry for a known error code. */
interface ErrorEntry {
  message: string;
  action: string;
  category: ErrorCategory;
  isRetryable: boolean;
}

// ---------------------------------------------------------------------------
// Known error code table
// ---------------------------------------------------------------------------

/**
 * Soroban contract error codes → user-safe messages (en).
 * Codes mirror the `errors` namespace in `src/locales/en.json`.
 */
export const CONTRACT_ERROR_MESSAGES: Readonly<Record<number | string, ErrorEntry>> = {
  // ── Initialisation
  101: { message: 'The contract has not been initialized.', action: 'Contact support.', category: 'contract', isRetryable: false },
  102: { message: 'The contract has already been initialized.', action: 'No action required.', category: 'contract', isRetryable: false },
  103: { message: 'An internal invariant was violated.', action: 'Contact support with the correlation ID.', category: 'contract', isRetryable: false },
  // ── Authorization
  201: { message: 'You are not authorized to perform this action.', action: 'Verify the connected wallet address and permissions.', category: 'auth', isRetryable: false },
  202: { message: 'This action is not permitted.', action: 'Verify the connected wallet address and permissions.', category: 'auth', isRetryable: false },
  203: { message: 'No pending admin to accept.', action: 'Contact an operator.', category: 'contract', isRetryable: false },
  204: { message: 'The recipient address is invalid for this operation.', action: 'Enter a valid Stellar public key.', category: 'validation', isRetryable: false, },
  205: { message: 'You are not registered as an operator.', action: 'Contact support to request operator access.', category: 'auth', isRetryable: false },
  // ── Amounts / limits
  301: { message: 'The amount must be greater than zero.', action: 'Enter a positive amount.', category: 'validation', isRetryable: false },
  302: { message: 'The amount exceeds the per-token transfer limit.', action: 'Reduce the amount and try again.', category: 'validation', isRetryable: false },
  303: { message: 'Your daily deposit limit has been reached.', action: 'Try again after the daily reset period.', category: 'contract', isRetryable: false },
  304: { message: 'Your daily fiat-equivalent volume limit has been exceeded.', action: 'Try again after the daily reset period.', category: 'contract', isRetryable: false },
  305: { message: 'The deposit reference is too long.', action: 'Shorten the reference and retry.', category: 'validation', isRetryable: false },
  306: { message: 'A security cooldown is active for your account.', action: 'Wait for the cooldown to expire, then retry.', category: 'contract', isRetryable: true },
  307: { message: 'An anti-sandwich delay is currently active.', action: 'Wait a few seconds, then retry.', category: 'contract', isRetryable: true },
  308: { message: 'This token is not supported by the bridge.', action: 'Select a supported token such as XLM or USDC.', category: 'contract', isRetryable: false },
  309: { message: 'Your address cannot perform this action.', action: 'Contact support if you believe this is an error.', category: 'auth', isRetryable: false },
  310: { message: 'Rescue of this token is not permitted.', action: 'Contact support.', category: 'contract', isRetryable: false },
  // ── Balance
  401: { message: 'Insufficient balance to complete this transaction.', action: 'Fund your wallet with additional XLM or reduce the transfer amount.', category: 'contract', isRetryable: false },
  402: { message: 'No accrued fees are available to withdraw.', action: 'No action required.', category: 'contract', isRetryable: false },
  // ── Withdrawals
  501: { message: 'The withdrawal request does not exist.', action: 'Verify the request ID and retry.', category: 'contract', isRetryable: false },
  502: { message: 'The withdrawal is still within its lock period.', action: 'Wait for the lock period to expire, then retry.', category: 'contract', isRetryable: true },
  // ── Admin actions
  601: { message: 'The admin action ID does not exist.', action: 'Verify the action ID and retry.', category: 'contract', isRetryable: false },
  602: { message: 'The admin action is still within its timelock period.', action: 'Wait for the timelock to expire (minimum 48 h), then retry.', category: 'contract', isRetryable: true },
  603: { message: 'The required inactivity period for emergency recovery has not elapsed.', action: 'Wait for the inactivity period to pass.', category: 'contract', isRetryable: true },
  604: { message: 'No emergency recovery address has been configured.', action: 'Contact an operator to configure recovery.', category: 'contract', isRetryable: false },
  // ── Oracle
  701: { message: 'No price oracle has been configured.', action: 'Contact support.', category: 'contract', isRetryable: false },
  702: { message: 'The price oracle returned an invalid value.', action: 'Retry in a few moments.', category: 'network', isRetryable: true },
  703: { message: 'Price slippage exceeds the allowed threshold.', action: 'Retry the transaction or adjust the amount.', category: 'contract', isRetryable: true },
  // ── Withdrawals / batch
  801: { message: 'Your daily withdrawal quota has been exceeded.', action: 'Try again after the daily reset period.', category: 'contract', isRetryable: false },
  802: { message: 'The escrow migration has already been completed.', action: 'No action required.', category: 'contract', isRetryable: false },
  803: { message: 'One or more batch operations failed.', action: 'Review the individual results and retry failed items.', category: 'contract', isRetryable: true },
  // ── Nonces
  901: { message: 'The transaction nonce is invalid.', action: 'Sync your wallet account sequence and retry.', category: 'contract', isRetryable: true },
  902: { message: 'This transaction nonce has already been used.', action: 'Sync your wallet account sequence and retry.', category: 'contract', isRetryable: false },
  // ── Wallet / network string codes
  USER_DECLINED: { message: 'You declined the transaction in Freighter.', action: 'Review and approve the transaction in your wallet when ready.', category: 'wallet', isRetryable: true },
  NETWORK_TIMEOUT: { message: 'The network request timed out.', action: 'Check your internet connection and retry.', category: 'network', isRetryable: true },
  RATE_LIMITED: { message: 'The RPC node is rate-limiting requests.', action: 'Wait a few seconds and retry.', category: 'network', isRetryable: true },
  WALLET_CONTEXT_CHANGED: { message: 'Your wallet account or network changed during the transaction.', action: 'Confirm the new context and rebuild the transaction.', category: 'wallet', isRetryable: true },
  SESSION_EXPIRED: { message: 'Your wallet session has expired.', action: 'Reconnect Freighter to continue.', category: 'auth', isRetryable: false },
  WALLET_DISCONNECTED: { message: 'Your wallet is not connected.', action: 'Connect Freighter to continue.', category: 'wallet', isRetryable: false },
};

// ---------------------------------------------------------------------------
// HTTP error classification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Map any thrown error from an API call or wallet operation to an
 * `AccessibleError` that is safe to display directly in the UI.
 *
 * @param error   The raw caught value (Error, string, or unknown).
 * @param options Optional hints that improve classification accuracy.
 */
export function classifyError(
  error: unknown,
  options: {
    /** HTTP status code when available. */
    httpStatus?: number;
    /** Field id of the first offending input, for aria-describedby wiring. */
    fieldId?: string;
    /**
     * Input values to preserve across the failure.  Only safe, non-sensitive
     * values (amount, note, recipient display text) should be passed here.
     */
    safeValues?: Record<string, string>;
  } = {},
): AccessibleError {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();
  const { httpStatus, fieldId, safeValues } = options;

  // ── 1. HTTP status codes from API responses
  if (httpStatus !== undefined && HTTP_STATUS_MESSAGES[httpStatus]) {
    const entry = HTTP_STATUS_MESSAGES[httpStatus];
    return { ...entry, fieldId, safeValues };
  }

  // ── 2. Known string error codes (checked before numeric to avoid substr match)
  for (const code of ['USER_DECLINED', 'NETWORK_TIMEOUT', 'RATE_LIMITED', 'WALLET_CONTEXT_CHANGED', 'SESSION_EXPIRED', 'WALLET_DISCONNECTED'] as const) {
    if (raw.includes(code) || lower.includes(code.toLowerCase())) {
      const entry = CONTRACT_ERROR_MESSAGES[code];
      return { ...entry, fieldId, safeValues };
    }
  }

  // ── 3. Numeric Soroban contract error codes  e.g. "Error(301)", "code 301"
  const codeMatch = raw.match(/(?:Error\(|code\s+)(\d{3,4})\)?/);
  if (codeMatch) {
    const numeric = Number(codeMatch[1]);
    if (CONTRACT_ERROR_MESSAGES[numeric]) {
      const entry = CONTRACT_ERROR_MESSAGES[numeric];
      return { ...entry, fieldId, safeValues };
    }
  }

  // ── 4. Numeric code appearing bare in the message  e.g. "… (401) …"
  const bareCode = raw.match(/\b(1\d{2}|2\d{2}|3\d{2}|4\d{2}|5\d{2}|6\d{2}|7\d{2}|8\d{2}|9\d{2})\b/);
  if (bareCode) {
    const numeric = Number(bareCode[1]);
    if (CONTRACT_ERROR_MESSAGES[numeric]) {
      const entry = CONTRACT_ERROR_MESSAGES[numeric];
      return { ...entry, fieldId, safeValues };
    }
  }

  // ── 5. Semantic keyword matching for wallet / network conditions
  if (
    lower.includes('user declined') ||
    lower.includes('rejected') ||
    lower.includes('user rejected')
  ) {
    return { ...CONTRACT_ERROR_MESSAGES.USER_DECLINED, fieldId, safeValues };
  }

  if (lower.includes('session expired') || lower.includes('session has expired')) {
    return { ...CONTRACT_ERROR_MESSAGES.SESSION_EXPIRED, fieldId, safeValues };
  }

  if (lower.includes('not connected') || lower.includes('disconnected') || lower.includes('wallet is not connected')) {
    return { ...CONTRACT_ERROR_MESSAGES.WALLET_DISCONNECTED, fieldId, safeValues };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('load failed')
  ) {
    return { ...CONTRACT_ERROR_MESSAGES.NETWORK_TIMEOUT, fieldId, safeValues };
  }

  if (lower.includes('rate limit') || lower.includes('too many requests')) {
    return { ...CONTRACT_ERROR_MESSAGES.RATE_LIMITED, fieldId, safeValues };
  }

  if (lower.includes('unauthorized') || lower.includes('not authorized')) {
    return { ...HTTP_STATUS_MESSAGES[401], fieldId, safeValues };
  }

  // ── 6. Generic fallback — sanitize the raw message before surfacing it
  const sanitized = sanitizeDiagnostics(raw);
  // Only surface the raw string when nothing was redacted (sanitized === raw),
  // the message is short enough to be human-readable, and it contains no
  // known-sensitive patterns. If sanitization changed anything, use the
  // generic message to avoid leaking partial secrets.
  const nothingRedacted = sanitized === raw;
  const isSafe = nothingRedacted && raw.length > 0 && raw.length < 200;
  return {
    message: isSafe ? sanitized : 'An unexpected error occurred.',
    action: 'Please try again. Contact support if the problem persists.',
    category: 'unknown',
    isRetryable: true,
    fieldId,
    safeValues,
  };
}

// ---------------------------------------------------------------------------
// Field-error association helper
// ---------------------------------------------------------------------------

/**
 * Build the `aria-describedby` value for a form field given the current
 * accessible error state.  Returns the error element id when the error is
 * associated with this field, `undefined` otherwise.
 *
 * @param fieldId       The field's own id attribute.
 * @param activeError   The current AccessibleError (or null/undefined).
 * @param errorElementSuffix  Suffix appended to `fieldId` to form the error
 *   element id.  Defaults to `"-error"`.
 */
export function fieldAriaDescribedBy(
  fieldId: string,
  activeError: AccessibleError | null | undefined,
  errorElementSuffix = '-error',
): string | undefined {
  if (!activeError?.fieldId) return undefined;
  if (activeError.fieldId !== fieldId) return undefined;
  return `${fieldId}${errorElementSuffix}`;
}

// ---------------------------------------------------------------------------
// Summary announcement helper
// ---------------------------------------------------------------------------

/**
 * Build the text for a live-region error summary that announces the first
 * blocking issue without exposing sensitive data.
 *
 * Returns `null` when there is no active error (so callers can gate rendering).
 */
export function buildErrorSummary(error: AccessibleError | null | undefined): string | null {
  if (!error) return null;
  if (!error.action) return error.message;
  return `${error.message} ${error.action}`;
}
