import { describe, it, expect } from 'vitest';

import {
  financialEdgeCaseFixtures,
  classifyCurrencySymbol,
  interpolateTranslation,
  toUiLocale,
} from './localeFixtures';
import {
  runAllLocaleChecks,
  runCanonicalInvarianceChecks,
  runSeparatorChecks,
  runNonLatinDigitChecks,
  runLongStringChecks,
  runNarrowLayoutChecks,
  runCurrencySymbolAmbiguityChecks,
  runFiatPrecisionChecks,
} from './localeQaChecks';

/**
 * Fixture integrity and aggregate regression coverage for the localization
 * QA fixtures (issue #296). This is the headless automated check that the
 * `/test-locale-money` harness renders in the browser; the harness and this
 * suite share {@link ./localeQaChecks.ts} so they assert the exact same
 * invariants. Financial safety: canonical stroops / minor units stay identical
 * across locales; only display strings may differ.
 */
describe('financial locale fixtures — integrity', () => {
  it('has a versioned envelope with a non-empty description', () => {
    expect(financialEdgeCaseFixtures.version).toBe(1);
    expect(financialEdgeCaseFixtures.description.length).toBeGreaterThan(0);
  });

  it('contains a case for every issue category', () => {
    expect(financialEdgeCaseFixtures.separatorMatrix.length).toBeGreaterThan(0);
    expect(financialEdgeCaseFixtures.nonLatinDigits.length).toBeGreaterThan(0);
    expect(
      financialEdgeCaseFixtures.longTranslatedStrings.length,
    ).toBeGreaterThan(0);
    expect(financialEdgeCaseFixtures.narrowLayouts.length).toBeGreaterThan(0);
    expect(
      financialEdgeCaseFixtures.currencySymbolAmbiguity.length,
    ).toBeGreaterThan(0);
    expect(financialEdgeCaseFixtures.fiatPrecisionCases.length).toBeGreaterThan(
      0,
    );
    expect(
      financialEdgeCaseFixtures.canonicalInvariance.length,
    ).toBeGreaterThan(0);
  });

  it('covers every locale used by the intent layer', () => {
    const locales = new Set(
      financialEdgeCaseFixtures.separatorMatrix.map((s) => s.locale),
    );
    expect(locales).toContain('en-US');
    expect(locales).toContain('de-DE');
    expect(locales).toContain('fr-FR');
    expect(locales).toContain('es-ES');
    expect(locales).toContain('ja-JP');
  });

  it('contains no credentials, secrets, or real user data', () => {
    const serialized = JSON.stringify(financialEdgeCaseFixtures);
    // High-signal secret *value* formats must never appear in fixtures.
    // (Case-sensitive: real Stellar secret keys are uppercase base32.)
    expect(serialized, 'no Stellar secret key').not.toMatch(/S[A-Z2-7]{55}/);
    expect(serialized, 'no Ethereum private key').not.toMatch(
      /0x[a-fA-F0-9]{64}/,
    );
    expect(serialized, 'no PEM private key block').not.toMatch(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    );
    // No credential-bearing *fields* (the prose asserting "no secrets" is fine).
    const keys = collectKeys(financialEdgeCaseFixtures);
    const credentialField =
      /^(password|secret|secretkey|privatekey|private_key|apikey|api_key|mnemonic|seedphrase|seed|accesstoken|access_token|authorization)$/i;
    expect(
      keys.some((k) => credentialField.test(k)),
      `credential field present in: ${keys.join(', ')}`,
    ).toBe(false);
  });
});

describe('financial locale fixtures — automated checks pass', () => {
  it('runAllLocaleChecks reports zero failures', () => {
    const result = runAllLocaleChecks();
    expect(
      result.total,
      'every fixture case must be exercised',
    ).toBeGreaterThan(0);
    expect(result.failures, renderFailures(result.failures)).toEqual([]);
    expect(result.passed).toBe(result.total);
  });

  it.each([
    ['canonicalInvariance', runCanonicalInvarianceChecks],
    ['separatorMatrix', runSeparatorChecks],
    ['nonLatinDigits', runNonLatinDigitChecks],
    ['longTranslatedStrings', runLongStringChecks],
    ['narrowLayouts', runNarrowLayoutChecks],
    ['currencySymbolAmbiguity', runCurrencySymbolAmbiguityChecks],
    ['fiatPrecisionCases', runFiatPrecisionChecks],
  ])('%s reports zero failures', (_name, run) => {
    const result = run();
    expect(result.total).toBeGreaterThan(0);
    expect(result.failures, renderFailures(result.failures)).toEqual([]);
    expect(result.passed).toBe(result.total);
  });
});

describe('currency-symbol ambiguity contract', () => {
  it('flags shared symbols as ambiguous', () => {
    expect(classifyCurrencySymbol('$')).toEqual({
      symbol: '$',
      ambiguous: true,
      reason: 'ambiguous-currency-symbol',
    });
    expect(classifyCurrencySymbol('¥').ambiguous).toBe(true);
    expect(classifyCurrencySymbol('kr').ambiguous).toBe(true);
  });

  it('leaves unambiguous symbols to the caller', () => {
    expect(classifyCurrencySymbol('€').ambiguous).toBe(false);
    expect(classifyCurrencySymbol('₦').ambiguous).toBe(false);
    expect(classifyCurrencySymbol('USDC').ambiguous).toBe(false);
  });
});

describe('long translated string interpolation', () => {
  it('resolves repeated placeholders', () => {
    const entry = financialEdgeCaseFixtures.longTranslatedStrings[0];
    const out = interpolateTranslation(entry.text, entry.params);
    expect(out).not.toContain('{expectedNetwork}');
    expect(out).toContain(entry.expectedContains);
  });

  it('resolves multiple distinct placeholders', () => {
    const entry = financialEdgeCaseFixtures.longTranslatedStrings.find(
      (e) => e.id === 'en-retry-countdown',
    );
    expect(entry).toBeDefined();
    const out = interpolateTranslation(entry!.text, entry!.params);
    expect(out).toBe('Retrying automatically in 5s (attempt 2 of 5)');
  });
});

describe('BCP-47 → UI locale mapping', () => {
  it('maps amount-layer locales to supported UI locales', () => {
    expect(toUiLocale('en-US')).toBe('en');
    expect(toUiLocale('fr-FR')).toBe('fr');
    expect(toUiLocale('es-ES')).toBe('es');
    expect(toUiLocale('de-DE')).toBe('en');
    expect(toUiLocale('ja-JP')).toBe('en');
  });
});

function renderFailures(
  failures: { category: string; caseId: string; message: string }[],
): string {
  if (failures.length === 0) return '';
  return (
    '\n' +
    failures
      .map((f) => `  [${f.category}] ${f.caseId}: ${f.message}`)
      .join('\n')
  );
}

/** Recursively collect every object key in a nested JSON-like value. */
function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}
