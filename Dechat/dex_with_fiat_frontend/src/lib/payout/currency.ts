/**
 * Centralized currency minor-unit (precision) metadata for payout validation.
 *
 * All payout amount validation MUST go through this module so that quote,
 * request, provider payload, and response amounts are checked consistently
 * using integer arithmetic against the currency's minor units.
 *
 * Currencies with unknown precision are rejected explicitly — we never
 * default or guess a precision for financial amounts.
 */

/**
 * Supported currencies mapped to their number of minor units (decimal places).
 * Extend this map when a provider adds support for a new currency.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  BTC: 8,
  ETH: 18,
  USDC: 6,
  USDT: 6,
});

export class UnknownCurrencyError extends Error {
  readonly currency: string;

  constructor(currency: string) {
    super(`Unsupported currency precision for "${currency}"`);
    this.name = 'UnknownCurrencyError';
    this.currency = currency;
  }
}

export class AmountPrecisionError extends Error {
  readonly currency: string;
  readonly amount: string;
  readonly minorUnits: number;

  constructor(currency: string, amount: string, minorUnits: number) {
    super(
      `Amount "${amount}" exceeds ${minorUnits} minor unit(s) for currency "${currency}"`,
    );
    this.name = 'AmountPrecisionError';
    this.currency = currency;
    this.amount = amount;
    this.minorUnits = minorUnits;
  }
}

/**
 * Normalize a currency code for lookup (trim + uppercase).
 */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/**
 * Resolve the number of minor units for a currency.
 * Throws {@link UnknownCurrencyError} for currencies with unknown precision.
 */
export function getMinorUnits(currency: string): number {
  const normalized = normalizeCurrency(currency);
  const minorUnits = CURRENCY_MINOR_UNITS[normalized];
  if (minorUnits === undefined) {
    throw new UnknownCurrencyError(currency);
  }
  return minorUnits;
}

/**
 * Returns true when the currency has known precision metadata.
 */
export function isSupportedCurrency(currency: string): boolean {
  return CURRENCY_MINOR_UNITS[normalizeCurrency(currency)] !== undefined;
}

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Convert a decimal amount string into integer minor units using string
 * arithmetic (no floating point). Throws on malformed input or when the
 * amount carries more precision than the currency supports.
 */
export function toMinorUnits(amount: string | number, currency: string): bigint {
  const minorUnits = getMinorUnits(currency);
  const raw = typeof amount === 'number' ? amount.toString() : amount.trim();

  if (!AMOUNT_PATTERN.test(raw)) {
    throw new AmountPrecisionError(currency, raw, minorUnits);
  }

  const [whole, fraction = ''] = raw.split('.');
  if (fraction.length > minorUnits) {
    // Reject trailing zeros beyond precision only if they carry value.
    const significant = fraction.slice(minorUnits).replace(/0+$/, '');
    if (significant.length > 0) {
      throw new AmountPrecisionError(currency, raw, minorUnits);
    }
  }

  const paddedFraction = fraction.slice(0, minorUnits).padEnd(minorUnits, '0');
  return BigInt(`${whole}${paddedFraction}`);
}

/**
 * Validate that an amount string is representable in the currency's minor
 * units. Returns the amount unchanged on success; throws otherwise.
 */
export function assertAmountPrecision(amount: string | number, currency: string): string {
  toMinorUnits(amount, currency);
  return typeof amount === 'number' ? amount.toString() : amount;
}

/**
 * Validate a payout amount against a currency, rejecting unknown currencies
 * and amounts that exceed the currency's precision.
 */
export function validatePayoutAmount(amount: string | number, currency: string): void {
  assertAmountPrecision(amount, currency);
}

/**
 * Validate a provider payload amount/currency pair. Provider payloads are
 * untrusted, so both the currency and the amount are checked.
 */
export function validateProviderAmount(
  payload: { amount: string | number; currency: string },
): void {
  validatePayoutAmount(payload.amount, payload.currency);
}
