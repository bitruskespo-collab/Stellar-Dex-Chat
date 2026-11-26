/**
 * Localized, code-first transaction errors — Issue #292.
 *
 * Structured error codes (Soroban contract numbers, HTTP statuses, wallet
 * string codes) are detected from machine diagnostics and kept verbatim in
 * `code`. Human-facing `message`/`action` text is resolved from locale
 * resources. No control-flow decision is made from translated text, so a
 * translation change can never alter error classification or retry behavior.
 *
 * Category and retryability come from the machine-code safety table in
 * `errorMessages.ts`; raw diagnostics and translated text never influence
 * them. Unknown codes resolve to a generic localized message and are never
 * blindly retried.
 */

import { classificationForCode, type ErrorCategory } from './errorMessages';
import {
  resolveTransactionMessage,
  type TransactionLocale,
} from './transactionLocale';
import type { DiagnosticDetails } from './transactionErrorRecovery';

export interface LocalizedTransactionError {
  /** Stable machine-readable code (e.g. `CONTRACT_401`, `HTTP_429`, `USER_DECLINED`). */
  code: string;
  category: ErrorCategory;
  isRetryable: boolean;
  message: string;
  action: string;
  fieldId?: string;
  safeValues?: Record<string, string>;
}

const WALLET_STRING_CODES = [
  'USER_DECLINED',
  'NETWORK_TIMEOUT',
  'RATE_LIMITED',
  'WALLET_CONTEXT_CHANGED',
  'SESSION_EXPIRED',
  'WALLET_DISCONNECTED',
] as const;

const HTTP_STATUSES = [
  400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504,
] as const;

const HTTP_MESSAGE_KEYS: Readonly<Record<number, string>> = {
  400: 'transaction.errors.api.validation',
  401: 'transaction.errors.api.unauthorized',
  403: 'transaction.errors.api.unauthorized',
  404: 'transaction.errors.api.unknown',
  409: 'transaction.errors.api.conflict',
  422: 'transaction.errors.api.validation',
  429: 'transaction.errors.api.rate_limited',
  500: 'transaction.errors.api.server',
  502: 'transaction.errors.api.network',
  503: 'transaction.errors.api.network',
  504: 'transaction.errors.api.network',
};

/** Remediation keys stored as translated text in `transaction.errors.actions`. */
const ACTION_KEYS: Readonly<Record<string, string>> = {
  CONTRACT_10: 'contact_support',
  CONTRACT_102: 'no_action',
  CONTRACT_104: 'no_action',
  CONTRACT_201: 'check_permissions',
  CONTRACT_202: 'check_permissions',
  CONTRACT_204: 'verify_form',
  CONTRACT_205: 'check_permissions',
  CONTRACT_203: 'no_action',
  CONTRACT_206: 'contact_support',
  CONTRACT_207: 'no_action',
  CONTRACT_208: 'contact_support',
  CONTRACT_301: 'reduce_amount',
  CONTRACT_302: 'reduce_amount',
  CONTRACT_303: 'contact_support',
  CONTRACT_304: 'retry_later',
  CONTRACT_305: 'retry_later',
  CONTRACT_306: 'verify_form',
  CONTRACT_307: 'retry_later',
  CONTRACT_308: 'retry_later',
  CONTRACT_309: 'verify_form',
  CONTRACT_310: 'check_permissions',
  CONTRACT_311: 'verify_form',
  CONTRACT_312: 'retry_later',
  CONTRACT_313: 'verify_form',
  CONTRACT_314: 'fund_wallet',
  CONTRACT_316: 'contact_support',
  CONTRACT_317: 'verify_form',
  CONTRACT_318: 'check_permissions',
  CONTRACT_319: 'contact_support',
  CONTRACT_320: 'retry_later',
  CONTRACT_321: 'retry_later',
  CONTRACT_322: 'verify_form',
  CONTRACT_401: 'fund_wallet',
  CONTRACT_402: 'no_action',
  CONTRACT_403: 'check_connection',
  CONTRACT_404: 'retry',
  CONTRACT_405: 'contact_support',
  CONTRACT_501: 'verify_request_id',
  CONTRACT_502: 'wait_for_lock',
  CONTRACT_503: 'retry_later',
  CONTRACT_504: 'retry',
  CONTRACT_505: 'retry_later',
  CONTRACT_601: 'verify_request_id',
  CONTRACT_602: 'wait_for_lock',
  CONTRACT_603: 'wait_for_lock',
  CONTRACT_605: 'retry_later',
  CONTRACT_606: 'verify_request_id',
  CONTRACT_607: 'retry_later',
  CONTRACT_703: 'adjust_slippage',
  CONTRACT_704: 'adjust_slippage',
  CONTRACT_705: 'retry_later',
  CONTRACT_706: 'retry_later',
  CONTRACT_707: 'retry_later',
  CONTRACT_708: 'retry_later',
  CONTRACT_709: 'contact_support',
  CONTRACT_710: 'reduce_amount',
  CONTRACT_711: 'adjust_slippage',
  CONTRACT_712: 'contact_support',
  CONTRACT_713: 'contact_support',
  CONTRACT_803: 'retry',
  CONTRACT_804: 'contact_support',
  CONTRACT_805: 'contact_support',
  CONTRACT_901: 'sync_nonce',
  CONTRACT_902: 'sync_nonce',
  CONTRACT_1001: 'reduce_amount',
  CONTRACT_1101: 'check_permissions',
  CONTRACT_1102: 'check_permissions',
  CONTRACT_1103: 'check_permissions',
  CONTRACT_1104: 'verify_request_id',
  CONTRACT_1105: 'no_action',
  CONTRACT_1106: 'no_action',
  CONTRACT_1107: 'check_permissions',
  CONTRACT_1108: 'check_permissions',
  CONTRACT_1201: 'no_action',
  CONTRACT_1202: 'verify_request_id',
  CONTRACT_1203: 'wait_for_lock',
  CONTRACT_1204: 'no_action',
  CONTRACT_1205: 'verify_request_id',
  HTTP_400: 'verify_form',
  HTTP_401: 'reconnect_wallet',
  HTTP_403: 'check_permissions',
  HTTP_404: 'verify_request_id',
  HTTP_409: 'retry',
  HTTP_422: 'verify_form',
  HTTP_429: 'retry_later',
  HTTP_500: 'generic',
  HTTP_502: 'check_connection',
  HTTP_503: 'check_connection',
  HTTP_504: 'check_connection',
  USER_DECLINED: 'retry',
  NETWORK_TIMEOUT: 'check_connection',
  RATE_LIMITED: 'retry_later',
  WALLET_CONTEXT_CHANGED: 'check_permissions',
  SESSION_EXPIRED: 'reconnect_wallet',
  WALLET_DISCONNECTED: 'reconnect_wallet',
  UNKNOWN: 'generic',
};

export interface LocalizeErrorOptions {
  locale?: TransactionLocale;
  httpStatus?: number;
  fieldId?: string;
  safeValues?: Record<string, string>;
}

/**
 * Extracts a contract code only from an explicit machine representation:
 * a numeric `code` field, Soroban's `Error(Contract, #501)`, a bare `#501`,
 * `Error(501)`, or `code 501`. Arbitrary digit runs (amounts, ledgers,
 * timestamps, "HTTP 504") are deliberately ignored — misclassifying those as
 * contract failures could change user guidance for a financial transaction.
 */
function contractCodeFrom(error: unknown, raw: string): string | null {
  const structured = (error as { code?: unknown } | null)?.code;
  if (typeof structured === 'number' && Number.isInteger(structured)) {
    return `CONTRACT_${structured}`;
  }
  if (typeof structured === 'string' && /^\d{3,4}$/.test(structured.trim())) {
    return `CONTRACT_${Number(structured.trim())}`;
  }

  const tagged = raw.match(
    /(?:Error\(\s*Contract\s*,?\s*#?|Error\(|#|code\s+)(\d{3,4})\b/i,
  );
  return tagged ? `CONTRACT_${Number(tagged[1])}` : null;
}

/** HTTP status expressed in the diagnostic text (never a bare contract code). */
function httpStatusFromText(raw: string): number | null {
  const match = raw.match(
    /\b(?:HTTP|status(?:Code)?)\s*[:=]?\s*(\d{3})\b/i,
  );
  if (!match) return null;
  const status = Number(match[1]);
  return (HTTP_STATUSES as readonly number[]).includes(status) ? status : null;
}

/**
 * Detects a stable code from machine diagnostics. HTTP hints win first, then
 * explicit wallet/contract codes, then conservative semantic keywords. The
 * translated message is never inspected.
 */
export function detectTransactionErrorCode(
  error: unknown,
  options: Pick<LocalizeErrorOptions, 'httpStatus'> = {},
): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();
  const { httpStatus } = options;

  if (
    httpStatus !== undefined &&
    (HTTP_STATUSES as readonly number[]).includes(httpStatus)
  ) {
    return `HTTP_${httpStatus}`;
  }

  for (const code of WALLET_STRING_CODES) {
    if (raw.includes(code) || lower.includes(code.toLowerCase())) return code;
  }

  // HTTP hints in the diagnostic text take precedence over any digits that
  // follow, so "HTTP 504 gateway timeout" cannot become CONTRACT_504.
  const textStatus = httpStatusFromText(raw);
  if (textStatus !== null) return `HTTP_${textStatus}`;

  const contractCode = contractCodeFrom(error, raw);
  if (contractCode) return contractCode;

  if (lower.includes('user declined') || lower.includes('rejected'))
    return 'USER_DECLINED';
  if (
    lower.includes('session expired') ||
    lower.includes('session has expired')
  )
    return 'SESSION_EXPIRED';
  if (lower.includes('not connected') || lower.includes('disconnected'))
    return 'WALLET_DISCONNECTED';
  if (lower.includes('rate limit') || lower.includes('too many requests'))
    return 'RATE_LIMITED';
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('failed to fetch') ||
    lower.includes('network')
  )
    return 'NETWORK_TIMEOUT';
  if (lower.includes('unauthorized') || lower.includes('not authorized'))
    return 'HTTP_401';

  return 'UNKNOWN';
}

/** Bare Soroban codes are treated as contract codes by the resolver. */
function normalizeMachineCode(code: string): string {
  return /^\d{3,4}$/.test(code) ? `CONTRACT_${Number(code)}` : code;
}

/** Localized message for a machine code. Never contains raw diagnostics. */
export function messageForTransactionCode(
  code: string,
  locale: TransactionLocale = 'en',
): string {
  const machineCode = normalizeMachineCode(code);
  if (machineCode.startsWith('CONTRACT_')) {
    const numeric = machineCode.slice('CONTRACT_'.length);
    const key = `errors.${numeric}`;
    const resolved = resolveTransactionMessage(locale, key);
    if (resolved !== key) return resolved;
  } else if (machineCode.startsWith('HTTP_')) {
    const numeric = Number(machineCode.slice('HTTP_'.length));
    if (HTTP_MESSAGE_KEYS[numeric]) {
      return resolveTransactionMessage(locale, HTTP_MESSAGE_KEYS[numeric]);
    }
  } else if ((WALLET_STRING_CODES as readonly string[]).includes(machineCode)) {
    const walletKeys: Record<string, string> = {
      USER_DECLINED: 'transaction.errors.wallet.user_declined',
      NETWORK_TIMEOUT: 'transaction.errors.api.network',
      RATE_LIMITED: 'transaction.errors.api.rate_limited',
      WALLET_CONTEXT_CHANGED: 'transaction.errors.wallet.context_changed',
      SESSION_EXPIRED: 'transaction.errors.wallet.session_expired',
      WALLET_DISCONNECTED: 'transaction.errors.wallet.disconnected',
    };
    return resolveTransactionMessage(locale, walletKeys[machineCode]);
  }

  return resolveTransactionMessage(
    locale,
    'transaction.errors.unknown.message',
  );
}

/** Localized remediation for a machine code. */
export function actionForTransactionCode(
  code: string,
  locale: TransactionLocale = 'en',
): string {
  const machineCode = normalizeMachineCode(code);
  const key = ACTION_KEYS[machineCode] ?? 'generic';
  if (
    machineCode.startsWith('CONTRACT_') &&
    ACTION_KEYS[machineCode] === undefined
  ) {
    // Unlisted contract codes still get a safe, localized next step.
    return resolveTransactionMessage(
      locale,
      'transaction.errors.actions.contact_support',
    );
  }
  return resolveTransactionMessage(locale, `transaction.errors.actions.${key}`);
}

/**
 * Recovery panel messages use the legacy diagnostic code set (1001-1008 and
 * wallet string codes) from `transactionErrorRecovery.ts`. Keeping them in a
 * separate resource namespace avoids colliding with the current Soroban codes
 * (for example, 1001 means "below minimum" on-chain but "insufficient funds"
 * in the recovery module).
 */
export function messageForDiagnosticCode(
  code: string,
  locale: TransactionLocale = 'en',
): string {
  const key = `transaction.errors.recovery.${code}.message`;
  const resolved = resolveTransactionMessage(locale, key);
  if (resolved !== key) return resolved;
  return messageForTransactionCode(code, locale);
}

/** Localized remediation for a diagnostic code. */
export function actionForDiagnosticCode(
  code: string,
  locale: TransactionLocale = 'en',
): string {
  const key = `transaction.errors.recovery.${code}.action`;
  const resolved = resolveTransactionMessage(locale, key);
  if (resolved !== key) {
    return resolveTransactionMessage(
      locale,
      `transaction.errors.actions.${resolved}`,
    );
  }
  return actionForTransactionCode(code, locale);
}

/**
 * Classifies an error into a stable code and resolves all user-facing text in
 * the requested locale. Category and retryability come from the machine-code
 * table only; raw diagnostics and translated text never influence either.
 *
 * Intentional behavior change: codes absent from the safety table are no
 * longer treated as retryable. A blind retry after an unknown financial
 * failure is unsafe, so the conservative default is `isRetryable: false`.
 */
export function classifyLocalizedError(
  error: unknown,
  options: LocalizeErrorOptions = {},
): LocalizedTransactionError {
  const { locale = 'en', httpStatus, fieldId, safeValues } = options;
  const code = detectTransactionErrorCode(error, { httpStatus });
  const safety = classificationForCode(code);

  return {
    code,
    category: safety.category,
    isRetryable: safety.isRetryable,
    message: messageForTransactionCode(code, locale),
    action: actionForTransactionCode(code, locale),
    fieldId,
    safeValues,
  };
}

/**
 * Replaces the English `safeMessage`/`actionGuidance` on a diagnostic object
 * using its existing machine `errorCode`. The code, correlation ID, category,
 * retryability and timestamp are preserved unchanged.
 */
export function localizeDiagnostics(
  diagnostics: DiagnosticDetails,
  locale: TransactionLocale = 'en',
): DiagnosticDetails {
  const rawCode = diagnostics.errorCode;
  const code =
    rawCode === undefined || rawCode === null
      ? 'UNKNOWN_ERROR'
      : String(rawCode);

  return {
    ...diagnostics,
    safeMessage: messageForDiagnosticCode(code, locale),
    actionGuidance: actionForDiagnosticCode(code, locale),
  };
}
