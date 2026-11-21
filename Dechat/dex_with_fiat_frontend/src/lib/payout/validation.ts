// Payout validation helpers.
//
// All monetary amounts are validated with integer arithmetic against the
// currency's minor-unit precision. Currencies with unknown precision are
// rejected explicitly rather than defaulting or guessing.

export interface CurrencyMetadata {
  /** ISO 4217 (or provider) currency code, upper-case. */
  code: string;
  /** Number of decimal digits in the currency's minor unit. */
  minorUnits: number;
}

/**
 * Centralized supported-currency minor-unit metadata.
 *
 * This is the single source of truth for payout amount precision. Any
 * currency not present here is treated as unsupported and rejected.
 */
export const SUPPORTED_CURRENCIES: Readonly<Record<string, CurrencyMetadata>> =
  Object.freeze({
    USD: { code: 'USD', minorUnits: 2 },
    EUR: { code: 'EUR', minorUnits: 2 },
    GBP: { code: 'GBP', minorUnits: 2 },
    JPY: { code: 'JPY', minorUnits: 0 },
    KRW: { code: 'KRW', minorUnits: 0 },
    BTC: { code: 'BTC', minorUnits: 8 },
    ETH: { code: 'ETH', minorUnits: 18 },
    USDC: { code: 'USDC', minorUnits: 6 },
    USDT: { code: 'USDT', minorUnits: 6 },
  });

export type ValidationResult =
  | { ok: true; amountMinor: bigint }
  | { ok: false; error: string };

/**
 * Look up currency metadata. Returns `null` when the currency is unknown so
 * callers can reject it explicitly instead of guessing a precision.
 */
export function getCurrencyMetadata(
  currency: string | null | undefined,
): CurrencyMetadata | null {
  if (!currency) return null;
  const key = currency.trim().toUpperCase();
  return SUPPORTED_CURRENCIES[key] ?? null;
}

/**
 * Parse a decimal amount string into integer minor units using the currency's
 * precision. Rejects unknown currencies, malformed input, and amounts with
 * more fractional digits than the currency supports.
 */
export function parseAmountToMinor(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): ValidationResult {
  const meta = getCurrencyMetadata(currency);
  if (!meta) {
    return {
      ok: false,
      error: `Unsupported currency precision for currency: ${currency ?? '(missing)'}`,
    };
  }

  if (amount === null || amount === undefined || amount === '') {
    return { ok: false, error: 'Amount is required' };
  }

  const raw = typeof amount === 'number' ? String(amount) : amount.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) {
    return { ok: false, error: `Invalid amount: ${raw}` };
  }

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > meta.minorUnits) {
    return {
      ok: false,
      error: `Amount ${raw} exceeds ${meta.minorUnits} decimal place(s) for ${meta.code}`,
    };
  }

  const paddedFraction = fraction.padEnd(meta.minorUnits, '0');
  const minor = BigInt(`${whole}${paddedFraction}`);
  const signed = sign === '-' ? -minor : minor;

  if (signed <= 0n) {
    return { ok: false, error: 'Amount must be greater than zero' };
  }

  return { ok: true, amountMinor: signed };
}

/**
 * Validate a quote amount against the currency's minor units.
 */
export function validateQuoteAmount(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): ValidationResult {
  return parseAmountToMinor(amount, currency);
}

/**
 * Validate a payout request amount against the currency's minor units.
 */
export function validateRequestAmount(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): ValidationResult {
  return parseAmountToMinor(amount, currency);
}

/**
 * Validate an amount embedded in a provider payload against the currency's
 * minor units. Provider payloads may carry the amount as a string or number.
 */
export function validateProviderPayloadAmount(
  payload: { amount?: string | number | null; currency?: string | null } | null | undefined,
): ValidationResult {
  if (!payload) {
    return { ok: false, error: 'Provider payload is required' };
  }
  return parseAmountToMinor(payload.amount, payload.currency);
}

/**
 * Validate an amount returned in a provider response against the currency's
 * minor units.
 */
export function validateResponseAmount(
  response: { amount?: string | number | null; currency?: string | null } | null | undefined,
): ValidationResult {
  if (!response) {
    return { ok: false, error: 'Provider response is required' };
  }
  return parseAmountToMinor(response.amount, response.currency);
}

/**
 * Assert that two amounts (e.g. quote vs. request, or request vs. provider
 * response) match exactly in minor units for the given currency.
 */
export function amountsMatch(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  currency: string | null | undefined,
): ValidationResult {
  const left = parseAmountToMinor(a, currency);
  if (!left.ok) return left;
  const right = parseAmountToMinor(b, currency);
  if (!right.ok) return right;
  if (left.amountMinor !== right.amountMinor) {
    return {
      ok: false,
      error: `Amount mismatch: ${left.amountMinor} != ${right.amountMinor}`,
    };
  }
  return { ok: true, amountMinor: left.amountMinor };
}
