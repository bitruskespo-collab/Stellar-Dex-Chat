/**
 * Locale-Aware Money Entry & Canonical Decimal Parser
 * Addresses Issue #89: Accept locale-specific amount input while preserving
 * exact integer arithmetic (stroops / minor units) for Stellar assets without floating point errors.
 */

export interface LocaleMoneyParseResult {
  isValid: boolean;
  canonicalDecimal: string | null; // e.g. "12.3456789"
  stroops: bigint | null;           // e.g. 123456789n (7 decimals for Stellar)
  displayFormatted: string | null;  // e.g. "12.35" or "12,35"
  error?: string;
}

const STELLAR_DECIMALS = 7;
const STROOPS_PER_XLM = BigInt(10_000_000);

/**
 * Parses user input according to locale conventions.
 * Supported locales: 'en-US' (dot decimal, comma grouping), 'de-DE' / 'fr-FR' (comma decimal, dot/space grouping).
 */
export function parseLocaleMoney(
  rawInput: string,
  locale: string = 'en-US',
  decimals: number = STELLAR_DECIMALS
): LocaleMoneyParseResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return { isValid: false, canonicalDecimal: null, stroops: null, displayFormatted: null, error: 'Amount is required.' };
  }

  const trimmed = rawInput.trim();

  // Reject negative values
  if (trimmed.startsWith('-') || trimmed.includes('(')) {
    return { isValid: false, canonicalDecimal: null, stroops: null, displayFormatted: null, error: 'Negative amounts are not allowed.' };
  }

  // Determine separator expectations
  const isCommaDecimal = locale.startsWith('de') || locale.startsWith('fr') || locale.startsWith('es');
  
  let sanitized = trimmed;
  if (isCommaDecimal) {
    // 1.234,56 -> 1234.56
    if (sanitized.includes('.') && sanitized.includes(',')) {
      sanitized = sanitized.replace(/\./g, '').replace(',', '.');
    } else if (sanitized.includes(',')) {
      sanitized = sanitized.replace(',', '.');
    }
  } else {
    // 1,234.56 -> 1234.56
    if (sanitized.includes(',') && sanitized.includes('.')) {
      sanitized = sanitized.replace(/,/g, '');
    } else if (sanitized.includes(',')) {
      // Check if comma was used as decimal point in en-US
      const parts = sanitized.split(',');
      if (parts.length === 2 && parts[1].length <= decimals) {
        sanitized = sanitized.replace(',', '.');
      } else {
        sanitized = sanitized.replace(/,/g, '');
      }
    }
  }

  // Validate canonical numeric string format (e.g. 123 or 123.456)
  if (!/^\d+(\.\d+)?$/.test(sanitized)) {
    return { isValid: false, canonicalDecimal: null, stroops: null, displayFormatted: null, error: 'Invalid numeric format.' };
  }

  const [wholeStr, fracStr = ''] = sanitized.split('.');

  // Reject excess precision beyond token capabilities
  if (fracStr.length > decimals) {
    return {
      isValid: false,
      canonicalDecimal: null,
      stroops: null,
      displayFormatted: null,
      error: `Maximum decimal precision is ${decimals} places.`,
    };
  }

  // Convert to exact bigint minor units (stroops) without floating point math
  const paddedFrac = fracStr.padEnd(decimals, '0');
  const stroops = BigInt(wholeStr) * (BigInt(10) ** BigInt(decimals)) + BigInt(paddedFrac);

  if (stroops <= BigInt(0)) {
    return { isValid: false, canonicalDecimal: null, stroops: null, displayFormatted: null, error: 'Amount must be greater than zero.' };
  }

  const canonicalDecimal = fracStr.length > 0 ? `${wholeStr}.${fracStr}` : wholeStr;

  // Format localized display string
  const numValue = Number(canonicalDecimal);
  const displayFormatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.min(decimals, 4),
  }).format(numValue);

  return {
    isValid: true,
    canonicalDecimal,
    stroops,
    displayFormatted,
  };
}
