import { describe, expect, it } from 'vitest';
import {
  fromMinorUnits,
  formatMinorUnitsDisplay,
  getCurrencyExponent,
  toKobo,
  toMinorUnits,
  validatePayoutAmount,
  PrecisionError,
  MAX_TRANSFER_AMOUNT_NGN,
} from './minorUnits';

describe('minorUnits conversion & validation', () => {
  describe('getCurrencyExponent', () => {
    it('returns 0 for zero-decimal currencies', () => {
      expect(getCurrencyExponent('JPY')).toBe(0);
      expect(getCurrencyExponent('krw')).toBe(0);
      expect(getCurrencyExponent('VND')).toBe(0);
      expect(getCurrencyExponent('UGX')).toBe(0);
    });

    it('returns 3 for three-decimal currencies', () => {
      expect(getCurrencyExponent('KWD')).toBe(3);
      expect(getCurrencyExponent('bhd')).toBe(3);
      expect(getCurrencyExponent('OMR')).toBe(3);
      expect(getCurrencyExponent('JOD')).toBe(3);
    });

    it('returns 2 for standard fiat currencies and unknown currencies', () => {
      expect(getCurrencyExponent('NGN')).toBe(2);
      expect(getCurrencyExponent('USD')).toBe(2);
      expect(getCurrencyExponent('EUR')).toBe(2);
      expect(getCurrencyExponent('XYZ')).toBe(2);
    });
  });

  describe('toMinorUnits', () => {
    it('converts standard 2-decimal currencies accurately', () => {
      expect(toMinorUnits('100.50', 'NGN')).toBe(10050n);
      expect(toMinorUnits('0.05', 'USD')).toBe(5n);
      expect(toMinorUnits('1', 'EUR')).toBe(100n);
      expect(toMinorUnits(250.75, 'NGN')).toBe(25075n);
    });

    it('converts zero-decimal currencies without fractions', () => {
      expect(toMinorUnits('500', 'JPY')).toBe(500n);
      expect(toMinorUnits(12000, 'KRW')).toBe(12000n);
    });

    it('rejects fractional inputs for zero-decimal currencies', () => {
      expect(() => toMinorUnits('500.5', 'JPY')).toThrow(PrecisionError);
      expect(() => toMinorUnits(12.34, 'KRW')).toThrow(PrecisionError);
    });

    it('converts three-decimal currencies accurately', () => {
      expect(toMinorUnits('1.250', 'KWD')).toBe(1250n);
      expect(toMinorUnits('0.005', 'BHD')).toBe(5n);
      expect(toMinorUnits(10.125, 'OMR')).toBe(10125n);
    });

    it('rejects unsupported precision beyond currency exponent', () => {
      // NGN has exponent 2: 3 decimal places must be rejected
      expect(() => toMinorUnits('10.505', 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits('0.001', 'USD')).toThrow(PrecisionError);
      // KWD has exponent 3: 4 decimal places must be rejected
      expect(() => toMinorUnits('1.2345', 'KWD')).toThrow(PrecisionError);
    });

    it('rejects negative, empty, and invalid formats', () => {
      expect(() => toMinorUnits('-10', 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits('', 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits('abc', 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits('12.34.56', 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits('1e5', 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits(NaN, 'NGN')).toThrow(PrecisionError);
      expect(() => toMinorUnits(Infinity, 'NGN')).toThrow(PrecisionError);
    });

    it('handles BigInt inputs directly scaled', () => {
      expect(toMinorUnits(100n, 'NGN')).toBe(10000n);
      expect(toMinorUnits(50n, 'JPY')).toBe(50n);
      expect(toMinorUnits(5n, 'KWD')).toBe(5000n);
    });
  });

  describe('fromMinorUnits', () => {
    it('formats minor units to canonical decimal string for 2-decimal currencies', () => {
      expect(fromMinorUnits(10050n, 'NGN')).toBe('100.50');
      expect(fromMinorUnits(5n, 'USD')).toBe('0.05');
      expect(fromMinorUnits(0n, 'EUR')).toBe('0.00');
    });

    it('formats minor units for zero-decimal currencies without decimal point', () => {
      expect(fromMinorUnits(500n, 'JPY')).toBe('500');
      expect(fromMinorUnits(0n, 'KRW')).toBe('0');
    });

    it('formats minor units for 3-decimal currencies', () => {
      expect(fromMinorUnits(1250n, 'KWD')).toBe('1.250');
      expect(fromMinorUnits(5n, 'BHD')).toBe('0.005');
    });

    it('handles number and string inputs', () => {
      expect(fromMinorUnits(10050, 'NGN')).toBe('100.50');
      expect(fromMinorUnits('10050', 'NGN')).toBe('100.50');
      expect(() => fromMinorUnits('100.5', 'NGN')).toThrow(PrecisionError);
    });
  });

  describe('round trip consistency', () => {
    it('round trips across 2-decimal, 0-decimal, and 3-decimal currencies', () => {
      const cases: [string, string][] = [
        ['100.50', 'NGN'],
        ['0.01', 'USD'],
        ['9999999.99', 'EUR'],
        ['1000', 'JPY'],
        ['5', 'KRW'],
        ['12.345', 'KWD'],
        ['0.001', 'BHD'],
      ];

      for (const [amountStr, currency] of cases) {
        const minor = toMinorUnits(amountStr, currency);
        const backToDecimal = fromMinorUnits(minor, currency);
        expect(backToDecimal).toBe(amountStr);
      }
    });
  });

  describe('formatMinorUnitsDisplay', () => {
    it('formats display with canonical amount and uppercase currency code', () => {
      expect(formatMinorUnitsDisplay(10050n, 'NGN')).toBe('100.50 NGN');
      expect(formatMinorUnitsDisplay(500n, 'JPY')).toBe('500 JPY');
      expect(formatMinorUnitsDisplay(1250n, 'KWD')).toBe('1.250 KWD');
    });
  });

  describe('validatePayoutAmount', () => {
    it('validates canonical submitted amount and derives matching displayed amount', () => {
      const result = validatePayoutAmount('2500.75', 'NGN');
      expect(result.amountMinor).toBe(250075n);
      expect(result.canonicalDecimal).toBe('2500.75');
      expect(result.currency).toBe('NGN');
      expect(result.exponent).toBe(2);

      // Verify displayed value derives from the same canonical amount
      const display = formatMinorUnitsDisplay(
        result.amountMinor,
        result.currency,
      );
      expect(display).toBe('2500.75 NGN');
    });

    it('rejects zero and negative amounts', () => {
      expect(() => validatePayoutAmount('0', 'NGN')).toThrow(PrecisionError);
      expect(() => validatePayoutAmount('-50', 'NGN')).toThrow(PrecisionError);
    });

    it('rejects amounts exceeding MAX_TRANSFER_AMOUNT_NGN', () => {
      expect(() =>
        validatePayoutAmount(MAX_TRANSFER_AMOUNT_NGN + 1, 'NGN'),
      ).toThrow(PrecisionError);
    });

    it('accepts maximum valid amount', () => {
      const result = validatePayoutAmount(MAX_TRANSFER_AMOUNT_NGN, 'NGN');
      expect(result.amountMinor).toBe(BigInt(MAX_TRANSFER_AMOUNT_NGN) * 100n);
    });
  });

  describe('toKobo backward compatibility', () => {
    it('converts standard numbers to kobo', () => {
      expect(toKobo(100.5)).toBe(10050);
      expect(toKobo(1234.56)).toBe(123456);
    });

    it('rounds floating-point representation artifacts', () => {
      expect(toKobo(0.1 + 0.2)).toBe(30);
    });

    it('maintains maximum accepted transfer amount', () => {
      expect(toKobo(10_000_000)).toBe(1_000_000_000);
    });
  });
});
