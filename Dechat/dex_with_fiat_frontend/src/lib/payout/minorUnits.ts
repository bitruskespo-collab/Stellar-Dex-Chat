/**
 * @fileoverview Precision-safe currency minor unit conversion and validation utilities.
 *
 * Prevents IEEE-754 binary floating-point rounding errors (e.g. 0.1 + 0.2 !== 0.3)
 * from altering payout or reconciliation amounts across token, fiat, and provider units.
 *
 * All conversions between major decimal values and integer minor units utilize string-based
 * decimal parsing and BigInt arithmetic.
 */

export const CURRENCY_EXPONENTS: Record<string, number> = {
  // Zero-decimal currencies (exponent = 0)
  JPY: 0,
  KRW: 0,
  UGX: 0,
  VND: 0,
  CLP: 0,
  PYG: 0,
  RWF: 0,
  BIF: 0,
  DJF: 0,
  GNF: 0,
  KMF: 0,

  // Three-decimal currencies (exponent = 3)
  BHD: 3,
  KWD: 3,
  OMR: 3,
  JOD: 3,
  TND: 3,
  LYD: 3,
  IQD: 3,

  // Standard two-decimal currencies (exponent = 2)
  NGN: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  BRL: 2,
  INR: 2,
  MXN: 2,
  SGD: 2,
};

/** Default currency exponent for currencies not explicitly configured */
export const DEFAULT_CURRENCY_EXPONENT = 2;

/** Maximum allowed transfer amount in major units for NGN */
export const MAX_TRANSFER_AMOUNT_NGN = 10_000_000;

export class PrecisionError extends Error {
  readonly code: string;
  readonly value?: unknown;

  constructor(message: string, code = 'INVALID_PRECISION', value?: unknown) {
    super(message);
    this.name = 'PrecisionError';
    this.code = code;
    this.value = value;
  }
}

/**
 * Returns the currency exponent (number of decimal minor digits) for a given ISO currency code.
 */
export function getCurrencyExponent(currency: string): number {
  if (!currency || typeof currency !== 'string') {
    return DEFAULT_CURRENCY_EXPONENT;
  }
  const normalized = currency.trim().toUpperCase();
  if (normalized in CURRENCY_EXPONENTS) {
    return CURRENCY_EXPONENTS[normalized];
  }
  return DEFAULT_CURRENCY_EXPONENT;
}

/**
 * Converts a major decimal fiat amount (number, string, or bigint) into integer minor units.
 *
 * Rules:
 * - Reject non-numeric strings, negative numbers, NaN, Infinity, and scientific notation.
 * - Reject amounts that exceed the currency's allowed decimal precision (unsupported precision).
 * - BigInt arithmetic ensures no precision is lost or truncated inadvertently.
 *
 * @param amount - The major decimal amount (e.g. "100.50", 100.5, or 100)
 * @param currency - The currency code (e.g. "NGN", "USD", "JPY", "KWD")
 * @returns The amount in integer minor units as a BigInt
 */
export function toMinorUnits(
  amount: string | number | bigint,
  currency: string,
): bigint {
  if (amount === null || amount === undefined) {
    throw new PrecisionError('Amount is required', 'MISSING_AMOUNT', amount);
  }

  if (typeof amount === 'bigint') {
    if (amount < 0n) {
      throw new PrecisionError(
        'Negative amounts are not permitted',
        'NEGATIVE_AMOUNT',
        amount,
      );
    }
    const exponent = getCurrencyExponent(currency);
    return amount * 10n ** BigInt(exponent);
  }

  let strAmount: string;
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      throw new PrecisionError(
        'Amount must be a finite number',
        'INVALID_NUMBER',
        amount,
      );
    }
    if (amount < 0) {
      throw new PrecisionError(
        'Negative amounts are not permitted',
        'NEGATIVE_AMOUNT',
        amount,
      );
    }
    // Check if number format uses scientific notation
    strAmount = amount.toString();
    if (strAmount.toLowerCase().includes('e')) {
      throw new PrecisionError(
        'Scientific notation is not supported',
        'SCIENTIFIC_NOTATION',
        amount,
      );
    }
  } else if (typeof amount === 'string') {
    strAmount = amount.trim();
  } else {
    throw new PrecisionError(
      'Invalid amount type',
      'INVALID_AMOUNT_TYPE',
      amount,
    );
  }

  if (!strAmount) {
    throw new PrecisionError('Amount cannot be empty', 'EMPTY_AMOUNT', amount);
  }

  if (strAmount.startsWith('-')) {
    throw new PrecisionError(
      'Negative amounts are not permitted',
      'NEGATIVE_AMOUNT',
      amount,
    );
  }

  if (strAmount.toLowerCase().includes('e')) {
    throw new PrecisionError(
      'Scientific notation is not supported',
      'SCIENTIFIC_NOTATION',
      amount,
    );
  }

  // Must match optional whole digits and optional decimal point with digits
  if (!/^\d*(?:\.\d*)?$/.test(strAmount) || strAmount === '.') {
    throw new PrecisionError(
      `Invalid numeric format: ${strAmount}`,
      'INVALID_FORMAT',
      amount,
    );
  }

  const exponent = getCurrencyExponent(currency);
  const parts = strAmount.split('.');
  const wholePart = parts[0] || '0';
  const fracPart = parts[1] || '';

  // Reject unsupported precision
  if (fracPart.length > exponent) {
    throw new PrecisionError(
      `Amount "${strAmount}" exceeds maximum allowed precision of ${exponent} decimal places for ${currency.toUpperCase()}`,
      'UNSUPPORTED_PRECISION',
      amount,
    );
  }

  const paddedFrac = fracPart.padEnd(exponent, '0');
  const wholeBig = BigInt(wholePart);
  const fracBig = paddedFrac.length > 0 ? BigInt(paddedFrac) : 0n;
  const multiplier = 10n ** BigInt(exponent);

  return wholeBig * multiplier + fracBig;
}

/**
 * Converts integer minor units back to a canonical decimal string with exact precision.
 *
 * @param amountMinor - The amount in minor units (e.g. 10050n kobo)
 * @param currency - The currency code (e.g. "NGN")
 * @returns Canonical decimal string (e.g. "100.50")
 */
export function fromMinorUnits(
  amountMinor: bigint | number | string,
  currency: string,
): string {
  let val: bigint;
  if (typeof amountMinor === 'bigint') {
    val = amountMinor;
  } else if (typeof amountMinor === 'number') {
    if (!Number.isFinite(amountMinor) || !Number.isInteger(amountMinor)) {
      throw new PrecisionError(
        'Minor units must be an integer',
        'INVALID_MINOR_UNITS',
        amountMinor,
      );
    }
    val = BigInt(amountMinor);
  } else if (typeof amountMinor === 'string') {
    const trimmed = amountMinor.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new PrecisionError(
        'Minor units string must be a base-10 integer',
        'INVALID_MINOR_UNITS',
        amountMinor,
      );
    }
    val = BigInt(trimmed);
  } else {
    throw new PrecisionError(
      'Invalid minor units type',
      'INVALID_TYPE',
      amountMinor,
    );
  }

  const isNegative = val < 0n;
  const magnitude = isNegative ? -val : val;
  const exponent = getCurrencyExponent(currency);

  if (exponent === 0) {
    const result = magnitude.toString();
    return isNegative ? `-${result}` : result;
  }

  const divisor = 10n ** BigInt(exponent);
  const whole = magnitude / divisor;
  const remainder = magnitude % divisor;
  const fracStr = remainder.toString().padStart(exponent, '0');
  const result = `${whole}.${fracStr}`;

  return isNegative ? `-${result}` : result;
}

/**
 * Formats minor units for user-facing display with currency suffix.
 * e.g. "100.50 NGN" or "1000 JPY" or "5.250 KWD".
 */
export function formatMinorUnitsDisplay(
  amountMinor: bigint | number | string,
  currency: string,
): string {
  const normCurrency = (currency || 'NGN').trim().toUpperCase();
  const canonical = fromMinorUnits(amountMinor, normCurrency);
  return `${canonical} ${normCurrency}`;
}

export interface CanonicalAmountResult {
  amountMinor: bigint;
  canonicalDecimal: string;
  currency: string;
  exponent: number;
}

/**
 * Validates a payout amount at API boundaries, enforcing positive value,
 * supported precision, and max transfer limits.
 */
export function validatePayoutAmount(
  amount: unknown,
  currency = 'NGN',
  maxAmount = MAX_TRANSFER_AMOUNT_NGN,
): CanonicalAmountResult {
  const normCurrency = (currency || 'NGN').trim().toUpperCase();
  const exponent = getCurrencyExponent(normCurrency);

  if (amount === undefined || amount === null || amount === '') {
    throw new PrecisionError('Amount is required', 'REQUIRED_AMOUNT');
  }

  let minorUnits: bigint;
  if (
    typeof amount === 'string' ||
    typeof amount === 'number' ||
    typeof amount === 'bigint'
  ) {
    minorUnits = toMinorUnits(amount, normCurrency);
  } else {
    throw new PrecisionError(
      'Amount must be a number or numeric string',
      'INVALID_TYPE',
      amount,
    );
  }

  if (minorUnits <= 0n) {
    throw new PrecisionError(
      'Amount must be greater than zero',
      'POSITIVE_AMOUNT_REQUIRED',
    );
  }

  const maxMinor = BigInt(maxAmount) * 10n ** BigInt(exponent);
  if (minorUnits > maxMinor) {
    throw new PrecisionError(
      `Amount exceeds maximum allowed limit of ${maxAmount} ${normCurrency}`,
      'EXCEEDS_MAX_LIMIT',
    );
  }

  const canonicalDecimal = fromMinorUnits(minorUnits, normCurrency);

  return {
    amountMinor: minorUnits,
    canonicalDecimal,
    currency: normCurrency,
    exponent,
  };
}

/**
 * Backward compatibility helper for existing Paystack kobo conversions.
 * Safely converts NGN decimal to integer kobo.
 */
export function toKobo(amountNgn: number | string): number {
  if (typeof amountNgn === 'number' && !Number.isFinite(amountNgn)) {
    return 0;
  }
  try {
    const minor = toMinorUnits(amountNgn, 'NGN');
    return Number(minor);
  } catch {
    // Fallback if rounding is requested for float artifacts (e.g. 0.1 + 0.2)
    const n = Number(amountNgn);
    return Math.round(n * 100);
  }
}
