/**
 * @fileoverview Typed access to the synthetic localization QA fixtures for
 * financial edge cases (issue #296) plus the currency-symbol ambiguity
 * contract those fixtures assert against.
 *
 * The fixtures live in `fixtures/locales/financial_edge_cases.json` and are
 * consumed by {@link ./localeQaChecks.ts}, the `/test-locale-money` harness,
 * and the `amount-property` Playwright project. They are synthetic: no
 * credentials or real user data are included.
 *
 * Financial safety: these fixtures only exercise the *display / parsing
 * boundary*. Canonical arithmetic (stroops for tokens, minor units for fiat)
 * is computed with BigInt in {@link ./exactAmount.ts} /
 * {@link ./payout/minorUnits.ts} and is intentionally left unchanged by this
 * work. The cross-locale invariant asserted here is that the same logical
 * amount written in each locale's accepted separator form resolves to
 * byte-identical stroops.
 */

import fixtureData from '../../fixtures/locales/financial_edge_cases.json';

// ── Fixture types ───────────────────────────────────────────────────────────

export interface SeparatorSample {
  id: string;
  input: string;
  expectedValid: boolean;
  expectedCanonicalDecimal?: string;
  expectedStroops?: string;
  expectedError?: string;
  note?: string;
}

export interface SeparatorLocaleSpec {
  id: string;
  locale: string;
  label: string;
  decimalSeparator: '.' | ',';
  groupingSeparator: ',' | '.' | ' ' | "'" | '\u00a0';
  decimals: number;
  samples: SeparatorSample[];
}

export interface NonLatinDigitCase {
  id: string;
  locale: string;
  digitSystem: string;
  input: string;
  asciiNormalized: string;
  decimals: number;
  expectedParserValid: boolean;
  reason: string;
  note?: string;
}

export interface LongTranslatedStringCase {
  id: string;
  translationLocale: string;
  key: string;
  text: string;
  minLength: number;
  params: Record<string, string>;
  expectedContains: string;
  note?: string;
}

export interface NarrowLayoutCase {
  id: string;
  viewportWidth: number;
  component: string;
  amount: string;
  tokenSymbol: string;
  formattedAmount: string;
  overflowStrategy: 'truncate' | 'wrap';
  note?: string;
}

export interface CurrencySymbolCase {
  id: string;
  symbol: string;
  ambiguous: boolean;
  reason?: string;
  candidateCurrencies?: string[];
  resolvedCurrency?: string;
  expectedClarification: boolean;
  note?: string;
}

export interface FiatPrecisionCase {
  id: string;
  currency: string;
  exponent: number;
  input: string;
  expectedValid: boolean;
  expectedMinorUnits?: string;
  expectedErrorCode?: string;
  note?: string;
}

export interface CanonicalInvarianceCase {
  id: string;
  description?: string;
  canonicalDecimal: string;
  decimals: number;
  expectedStroops: string;
  localeInputs: Record<string, string>;
}

export interface FinancialEdgeCaseFixtures {
  version: number;
  description: string;
  canonicalInvariance: CanonicalInvarianceCase[];
  separatorMatrix: SeparatorLocaleSpec[];
  nonLatinDigits: NonLatinDigitCase[];
  longTranslatedStrings: LongTranslatedStringCase[];
  narrowLayouts: NarrowLayoutCase[];
  currencySymbolAmbiguity: CurrencySymbolCase[];
  fiatPrecisionCases: FiatPrecisionCase[];
}

/** The versioned fixture data, typed for consumers. */
export const financialEdgeCaseFixtures =
  fixtureData as unknown as FinancialEdgeCaseFixtures;

// ── Currency-symbol ambiguity contract ─────────────────────────────────────

/**
 * Currency symbols shared by more than one ISO 4217 currency. These must be
 * withheld for clarification rather than silently resolved to a guess.
 *
 * This mirrors {@link ../../scripts/benchmark.ts}'s `AMBIGUOUS_SYMBOLS` so the
 * fixture contract and the offline intent evaluator agree. The set is kept in
 * sync deliberately; changes here should be reflected in the benchmark.
 */
export const AMBIGUOUS_CURRENCY_SYMBOLS: ReadonlySet<string> = new Set([
  '$',
  '¥',
  'kr',
]);

export interface CurrencySymbolClassification {
  symbol: string;
  ambiguous: boolean;
  reason: string | null;
}

/**
 * Classify a currency symbol as ambiguous or resolvable. Pure and
 * deterministic; the fixture's `currencySymbolAmbiguity` entries assert
 * against this contract.
 */
export function classifyCurrencySymbol(
  symbol: string,
): CurrencySymbolClassification {
  const normalized = (symbol ?? '').trim();
  if (AMBIGUOUS_CURRENCY_SYMBOLS.has(normalized)) {
    return {
      symbol: normalized,
      ambiguous: true,
      reason: 'ambiguous-currency-symbol',
    };
  }
  return { symbol: normalized, ambiguous: false, reason: null };
}

/**
 * Interpolate `{param}` placeholders in a translation string, matching the
 * convention used by {@link ../contexts/TranslationContext.tsx} `t()`.
 */
export function interpolateTranslation(
  text: string,
  params: Record<string, string | number>,
): string {
  return Object.entries(params).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
    text,
  );
}

/**
 * BCP-47 locale code → supported UI translation locale code (en/fr/es). The
 * amount/intent layer uses BCP-47 codes; the UI translation layer uses short
 * codes. This maps between them so fixtures can reference both namespaces.
 */
export function toUiLocale(bcp47: string): 'en' | 'fr' | 'es' {
  const primary = bcp47.split('-')[0]?.toLowerCase();
  if (primary === 'fr') return 'fr';
  if (primary === 'es') return 'es';
  return 'en';
}
