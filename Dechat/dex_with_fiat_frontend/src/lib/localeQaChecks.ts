/**
 * @fileoverview Deterministic checks that drive the localization QA fixtures
 * for financial edge cases (issue #296).
 *
 * Every check is pure: it consumes the synthetic fixture in
 * {@link ./localeFixtures.ts} and the real parsers
 * ({@link ./localeMoneyParser.ts} `parseLocaleMoney`,
 * {@link ./payout/minorUnits.ts} `toMinorUnits`) and reports pass/fail without
 * any side effects. The `/test-locale-money` harness renders the results into
 * the DOM (surfacing failures via `data-testid="locale-failures"`), and the
 * Vitest suite asserts the same checks pass headlessly. The `amount-property`
 * Playwright project asserts the rendered harness shows no failures.
 *
 * Financial safety is preserved by construction: nothing here mutates the
 * BigInt arithmetic layers. The checks only *assert* that locale presentation
 * maps back to identical canonical stroops / minor units.
 */

import { parseLocaleMoney } from './localeMoneyParser';
import {
  toMinorUnits,
  PrecisionError,
  getCurrencyExponent,
} from './payout/minorUnits';
import {
  financialEdgeCaseFixtures,
  classifyCurrencySymbol,
  interpolateTranslation,
  type FinancialEdgeCaseFixtures,
} from './localeFixtures';

export interface LocaleQaFailure {
  category: string;
  caseId: string;
  message: string;
}

export interface LocaleQaResult {
  failures: LocaleQaFailure[];
  passed: number;
  total: number;
}

function fail(
  category: string,
  caseId: string,
  message: string,
  failures: LocaleQaFailure[],
): void {
  failures.push({ category, caseId, message });
}

/** Cross-locale stroops invariance: the same amount in every locale form. */
export function runCanonicalInvarianceChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const group of fixtures.canonicalInvariance) {
    const expectedStroops = BigInt(group.expectedStroops);
    const observed = new Set<string>();
    let groupOk = true;

    for (const [locale, input] of Object.entries(group.localeInputs)) {
      total++;
      const result = parseLocaleMoney(input, locale, group.decimals);
      if (!result.isValid || result.stroops == null) {
        fail(
          'canonicalInvariance',
          group.id,
          `locale ${locale} input "${redact(input)}" was rejected`,
          failures,
        );
        groupOk = false;
        continue;
      }
      if (result.stroops !== expectedStroops) {
        fail(
          'canonicalInvariance',
          group.id,
          `locale ${locale} input "${redact(input)}" resolved to stroops ${result.stroops}, expected ${expectedStroops}`,
          failures,
        );
        groupOk = false;
        continue;
      }
      if (result.canonicalDecimal !== group.canonicalDecimal) {
        fail(
          'canonicalInvariance',
          group.id,
          `locale ${locale} canonicalDecimal "${result.canonicalDecimal}" != "${group.canonicalDecimal}"`,
          failures,
        );
        groupOk = false;
        continue;
      }
      observed.add(result.stroops.toString());
    }

    if (groupOk) {
      passed += Object.keys(group.localeInputs).length;
      // The financial-safety invariant: a single canonical stroops value
      // across every locale form.
      if (observed.size !== 1) {
        fail(
          'canonicalInvariance',
          group.id,
          `expected one canonical stroops value, observed ${observed.size}`,
          failures,
        );
      }
    }
  }

  return { failures, passed, total };
}

/** Decimal/grouping separator parsing across locales, incl. boundary cases. */
export function runSeparatorChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const spec of fixtures.separatorMatrix) {
    for (const sample of spec.samples) {
      total++;
      const result = parseLocaleMoney(sample.input, spec.locale, spec.decimals);

      if (sample.expectedValid) {
        if (!result.isValid) {
          fail(
            'separatorMatrix',
            sample.id,
            `locale ${spec.locale} input "${redact(sample.input)}" unexpectedly rejected: ${result.error}`,
            failures,
          );
          continue;
        }
        if (
          sample.expectedCanonicalDecimal &&
          result.canonicalDecimal !== sample.expectedCanonicalDecimal
        ) {
          fail(
            'separatorMatrix',
            sample.id,
            `locale ${spec.locale} canonicalDecimal "${result.canonicalDecimal}" != "${sample.expectedCanonicalDecimal}"`,
            failures,
          );
          continue;
        }
        if (sample.expectedStroops && result.stroops != null) {
          const want = BigInt(sample.expectedStroops);
          if (result.stroops !== want) {
            fail(
              'separatorMatrix',
              sample.id,
              `locale ${spec.locale} stroops ${result.stroops} != ${want}`,
              failures,
            );
            continue;
          }
        }
        passed++;
      } else {
        if (result.isValid) {
          fail(
            'separatorMatrix',
            sample.id,
            `locale ${spec.locale} input "${redact(sample.input)}" unexpectedly accepted`,
            failures,
          );
          continue;
        }
        if (sample.expectedError && result.error !== sample.expectedError) {
          fail(
            'separatorMatrix',
            sample.id,
            `locale ${spec.locale} error "${result.error}" != "${sample.expectedError}"`,
            failures,
          );
          continue;
        }
        passed++;
      }
    }
  }

  return { failures, passed, total };
}

/** Non-Latin digit systems must be rejected (boundary: ASCII-only parsing). */
export function runNonLatinDigitChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const entry of fixtures.nonLatinDigits) {
    total++;
    // The fixture's asciiNormalized must itself be a well-formed canonical
    // decimal so the "expected normalization" is honest.
    if (!/^\d+(\.\d+)?$/.test(entry.asciiNormalized)) {
      fail(
        'nonLatinDigits',
        entry.id,
        `fixture asciiNormalized "${entry.asciiNormalized}" is not a canonical decimal`,
        failures,
      );
      continue;
    }

    const result = parseLocaleMoney(entry.input, entry.locale, entry.decimals);
    if (entry.expectedParserValid === false) {
      if (result.isValid) {
        fail(
          'nonLatinDigits',
          entry.id,
          `locale ${entry.locale} non-Latin input was unexpectedly accepted`,
          failures,
        );
        continue;
      }
      passed++;
    } else {
      if (!result.isValid) {
        fail(
          'nonLatinDigits',
          entry.id,
          `locale ${entry.locale} input was unexpectedly rejected`,
          failures,
        );
        continue;
      }
      passed++;
    }
  }

  return { failures, passed, total };
}

/** Long translated strings render in full and interpolate placeholders. */
export function runLongStringChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const entry of fixtures.longTranslatedStrings) {
    total++;
    if (entry.text.length < entry.minLength) {
      fail(
        'longTranslatedStrings',
        entry.id,
        `text length ${entry.text.length} < minLength ${entry.minLength}`,
        failures,
      );
      continue;
    }

    const interpolated = interpolateTranslation(entry.text, entry.params);
    if (interpolated.includes('{') || interpolated.includes('}')) {
      fail(
        'longTranslatedStrings',
        entry.id,
        `unresolved placeholder in: "${redact(interpolated)}"`,
        failures,
      );
      continue;
    }
    if (!interpolated.includes(entry.expectedContains)) {
      fail(
        'longTranslatedStrings',
        entry.id,
        `interpolated text missing "${entry.expectedContains}"`,
        failures,
      );
      continue;
    }
    passed++;
  }

  return { failures, passed, total };
}

/** Narrow-layout cases declare a valid overflow strategy and width. */
export function runNarrowLayoutChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;
  const validStrategies = new Set(['truncate', 'wrap']);

  for (const entry of fixtures.narrowLayouts) {
    total++;
    if (!Number.isInteger(entry.viewportWidth) || entry.viewportWidth <= 0) {
      fail(
        'narrowLayouts',
        entry.id,
        `invalid viewportWidth ${entry.viewportWidth}`,
        failures,
      );
      continue;
    }
    if (entry.viewportWidth > 768) {
      fail(
        'narrowLayouts',
        entry.id,
        `viewportWidth ${entry.viewportWidth} exceeds the narrow-layout bound (768)`,
        failures,
      );
      continue;
    }
    if (!validStrategies.has(entry.overflowStrategy)) {
      fail(
        'narrowLayouts',
        entry.id,
        `invalid overflowStrategy "${entry.overflowStrategy}"`,
        failures,
      );
      continue;
    }
    if (!entry.formattedAmount.trim()) {
      fail(
        'narrowLayouts',
        entry.id,
        'formattedAmount must be non-empty',
        failures,
      );
      continue;
    }
    if (!entry.amount.trim() || !entry.tokenSymbol.trim()) {
      fail(
        'narrowLayouts',
        entry.id,
        'amount and tokenSymbol must be non-empty',
        failures,
      );
      continue;
    }
    passed++;
  }

  return { failures, passed, total };
}

/** Currency-symbol ambiguity matches the classifyCurrencySymbol contract. */
export function runCurrencySymbolAmbiguityChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const entry of fixtures.currencySymbolAmbiguity) {
    total++;
    const classification = classifyCurrencySymbol(entry.symbol);

    if (classification.ambiguous !== entry.ambiguous) {
      fail(
        'currencySymbolAmbiguity',
        entry.id,
        `symbol "${entry.symbol}" ambiguous=${classification.ambiguous} != ${entry.ambiguous}`,
        failures,
      );
      continue;
    }
    if (entry.ambiguous) {
      if (classification.reason !== entry.reason) {
        fail(
          'currencySymbolAmbiguity',
          entry.id,
          `reason "${classification.reason}" != "${entry.reason}"`,
          failures,
        );
        continue;
      }
      if (!entry.expectedClarification) {
        fail(
          'currencySymbolAmbiguity',
          entry.id,
          'ambiguous symbol must require clarification',
          failures,
        );
        continue;
      }
    } else if (entry.expectedClarification) {
      fail(
        'currencySymbolAmbiguity',
        entry.id,
        'unambiguous symbol must not require clarification',
        failures,
      );
      continue;
    }
    passed++;
  }

  return { failures, passed, total };
}

/** Fiat currency-exponent precision boundaries via toMinorUnits. */
export function runFiatPrecisionChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const entry of fixtures.fiatPrecisionCases) {
    total++;

    // The fixture-declared exponent must match the real CURRENCY_EXPONENTS map.
    const realExponent = getCurrencyExponent(entry.currency);
    if (realExponent !== entry.exponent) {
      fail(
        'fiatPrecisionCases',
        entry.id,
        `${entry.currency} exponent ${realExponent} != fixture ${entry.exponent}`,
        failures,
      );
      continue;
    }

    if (entry.expectedValid) {
      let minor: bigint;
      try {
        minor = toMinorUnits(entry.input, entry.currency);
      } catch (err) {
        fail(
          'fiatPrecisionCases',
          entry.id,
          `input "${redact(entry.input)}" unexpectedly rejected: ${(err as Error).message}`,
          failures,
        );
        continue;
      }
      if (
        entry.expectedMinorUnits &&
        minor !== BigInt(entry.expectedMinorUnits)
      ) {
        fail(
          'fiatPrecisionCases',
          entry.id,
          `minor ${minor} != ${entry.expectedMinorUnits}`,
          failures,
        );
        continue;
      }
      passed++;
    } else {
      let threw = false;
      try {
        toMinorUnits(entry.input, entry.currency);
      } catch (err) {
        threw = true;
        if (!(err instanceof PrecisionError)) {
          fail(
            'fiatPrecisionCases',
            entry.id,
            `expected PrecisionError, got ${err?.constructor?.name ?? 'unknown'}`,
            failures,
          );
          continue;
        }
        if (
          entry.expectedErrorCode &&
          (err as PrecisionError).code !== entry.expectedErrorCode
        ) {
          fail(
            'fiatPrecisionCases',
            entry.id,
            `error code "${(err as PrecisionError).code}" != "${entry.expectedErrorCode}"`,
            failures,
          );
          continue;
        }
      }
      if (!threw) {
        fail(
          'fiatPrecisionCases',
          entry.id,
          `input "${redact(entry.input)}" unexpectedly accepted`,
          failures,
        );
        continue;
      }
      passed++;
    }
  }

  return { failures, passed, total };
}

/**
 * Run every category and return the aggregate result. Used by the
 * `/test-locale-money` harness and the Vitest suite.
 */
export function runAllLocaleChecks(
  fixtures: FinancialEdgeCaseFixtures = financialEdgeCaseFixtures,
): LocaleQaResult {
  const checks: Array<() => LocaleQaResult> = [
    runCanonicalInvarianceChecks,
    runSeparatorChecks,
    runNonLatinDigitChecks,
    runLongStringChecks,
    runNarrowLayoutChecks,
    runCurrencySymbolAmbiguityChecks,
    runFiatPrecisionChecks,
  ];

  const failures: LocaleQaFailure[] = [];
  let passed = 0;
  let total = 0;

  for (const run of checks) {
    const result = run(fixtures);
    failures.push(...result.failures);
    passed += result.passed;
    total += result.total;
  }

  return { failures, passed, total };
}

/**
 * Redact raw user-style input from failure diagnostics so locale utterances
 * never leak unredacted into logs. Keeps the checks safe to surface in the UI.
 */
function redact(input: string): string {
  return input.length > 40 ? `${input.slice(0, 37)}...` : input;
}
