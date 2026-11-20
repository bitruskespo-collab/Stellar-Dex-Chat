import { describe, it, expect } from 'vitest';

import { parseLocaleMoney } from './localeMoneyParser';
import {
  financialEdgeCaseFixtures,
  type SeparatorLocaleSpec,
  type SeparatorSample,
} from './localeFixtures';

/**
 * Regression coverage for `parseLocaleMoney` (issue #89), driven by the
 * synthetic locale QA fixtures (issue #296). These are the *financial edge
 * cases*: decimal/grouping separators, cross-locale stroops invariance,
 * non-Latin digit rejection, and the boundary/failure cases the issue calls
 * out. The canonical BigInt stroops must be byte-identical across locales; only
 * the localized *display* string may differ.
 */
describe('parseLocaleMoney — separator matrix', () => {
  for (const spec of financialEdgeCaseFixtures.separatorMatrix as SeparatorLocaleSpec[]) {
    describe(`${spec.locale} (${spec.label})`, () => {
      for (const sample of spec.samples as SeparatorSample[]) {
        it(`${sample.id}: "${sample.input}"`, () => {
          const result = parseLocaleMoney(
            sample.input,
            spec.locale,
            spec.decimals,
          );

          expect(result.isValid).toBe(sample.expectedValid);

          if (sample.expectedValid) {
            expect(result.stroops, 'stroops must be a bigint').toBeTypeOf(
              'bigint',
            );
            if (sample.expectedCanonicalDecimal) {
              expect(result.canonicalDecimal).toBe(
                sample.expectedCanonicalDecimal,
              );
            }
            if (sample.expectedStroops) {
              expect(result.stroops).toBe(BigInt(sample.expectedStroops));
            }
            // Valid parse amounts must always be greater than zero.
            expect(result.stroops).toBeGreaterThan(0n);
            // The localized display string is present but is a separate layer.
            expect(result.displayFormatted).toBeTruthy();
          } else {
            expect(result.stroops).toBeNull();
            expect(result.canonicalDecimal).toBeNull();
            if (sample.expectedError) {
              expect(result.error).toBe(sample.expectedError);
            }
          }
        });
      }
    });
  }
});

describe('parseLocaleMoney — cross-locale stroops invariance', () => {
  for (const group of financialEdgeCaseFixtures.canonicalInvariance) {
    it(`${group.id}: every locale form resolves to ${group.expectedStroops} stroops`, () => {
      const stroopsByLocale: Record<string, bigint> = {};
      for (const [locale, input] of Object.entries(group.localeInputs)) {
        const result = parseLocaleMoney(input, locale, group.decimals);
        expect(result.isValid, `locale ${locale} should be valid`).toBe(true);
        expect(result.stroops).not.toBeNull();
        stroopsByLocale[locale] = result.stroops as bigint;
      }
      // The financial-safety invariant: identical canonical stroops everywhere.
      const unique = new Set(
        Object.values(stroopsByLocale).map((s) => s.toString()),
      );
      expect(unique.size, 'all locales must yield the same stroops').toBe(1);
      expect(stroopsByLocale['en-US']).toBe(BigInt(group.expectedStroops));
    });
  }
});

describe('parseLocaleMoney — non-Latin digits are rejected', () => {
  for (const entry of financialEdgeCaseFixtures.nonLatinDigits) {
    it(`${entry.id} (${entry.locale}) is not accepted`, () => {
      const result = parseLocaleMoney(
        entry.input,
        entry.locale,
        entry.decimals,
      );
      expect(result.isValid, 'non-Latin digits must not be accepted').toBe(
        false,
      );
      expect(result.stroops).toBeNull();
    });

    it(`${entry.id} fixture asciiNormalized is a canonical decimal`, () => {
      expect(entry.asciiNormalized).toMatch(/^\d+(\.\d+)?$/);
    });
  }
});

describe('parseLocaleMoney — financial-safety boundaries', () => {
  it('rejects negative amounts and parenthetical bookkeeping notation', () => {
    expect(parseLocaleMoney('-1.5', 'en-US').isValid).toBe(false);
    expect(parseLocaleMoney('(1.5)', 'en-US').isValid).toBe(false);
  });

  it('rejects zero (parseLocaleMoney requires a positive amount)', () => {
    expect(parseLocaleMoney('0', 'en-US').isValid).toBe(false);
    expect(parseLocaleMoney('0.0', 'de-DE').isValid).toBe(false);
  });

  it('rejects excess precision beyond the token decimals', () => {
    expect(parseLocaleMoney('0.12345678', 'en-US', 7).isValid).toBe(false);
    expect(parseLocaleMoney('0,12345678', 'de-DE', 7).isValid).toBe(false);
  });

  it('preserves exactness beyond Number.MAX_SAFE_INTEGER', () => {
    // 90071992547409.92 XLM at 7 decimals is beyond MAX_SAFE_INTEGER; BigInt
    // must not drift.
    const stroops = parseLocaleMoney('90071992547409.92', 'en-US', 7).stroops;
    expect(stroops).toBe(BigInt('900719925474099200000'));
  });
});
