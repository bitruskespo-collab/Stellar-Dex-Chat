/**
 * Locale-aware formatting and message resolution for transaction-critical UI.
 * Issue #292 — Localize transaction-critical content with plural and number
 * rules.
 *
 * Presentation only: this module never changes canonical amounts. Minor units
 * (stroops / fiat minor units) stay BigInt in `exactAmount.ts` /
 * `payout/minorUnits.ts`; the helpers below only format values for display and
 * resolve translated templates from `src/locales`.
 *
 * Machine-readable codes (contract error numbers, HTTP statuses, wallet
 * string codes) remain keys in the resource files and in structured error
 * objects. They are never derived from — or compared against — translated
 * text.
 */

import ar from '../locales/ar.json';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';

/** Locales shipped with the application. */
export type TransactionLocale = 'en' | 'fr' | 'es' | 'ar';

/** BCP 47 tags used by Intl for each shipped locale. */
const INTL_LOCALES: Readonly<Record<TransactionLocale, string>> = {
  en: 'en-US',
  fr: 'fr-FR',
  es: 'es-ES',
  ar: 'ar-EG',
};

const RESOURCES: Readonly<Record<TransactionLocale, Record<string, unknown>>> =
  {
    en: en as Record<string, unknown>,
    fr: fr as Record<string, unknown>,
    es: es as Record<string, unknown>,
    ar: ar as Record<string, unknown>,
  };

export const DEFAULT_TRANSACTION_LOCALE: TransactionLocale = 'en';

/** Returns the Intl language tag for a shipped locale. */
export function getIntlLocale(
  locale: TransactionLocale = DEFAULT_TRANSACTION_LOCALE,
): string {
  return INTL_LOCALES[locale] ?? INTL_LOCALES.en;
}

/**
 * Formats a number for display using locale grouping/decimal separators.
 *
 * `numberingSystem: 'latn'` is deliberate: amount inputs are parsed as ASCII
 * digits only (see `localeMoneyParser.ts`), so displaying Arabic-Indic digits
 * would make the displayed value and the accepted input diverge. Canonical
 * arithmetic is untouched — bigint input is formatted directly, without a
 * float conversion.
 */
export function formatTransactionNumber(
  value: number | bigint | string,
  locale: TransactionLocale = DEFAULT_TRANSACTION_LOCALE,
  options: Intl.NumberFormatOptions = {},
): string {
  let displayValue: number | bigint;

  if (typeof value === 'bigint') {
    displayValue = value;
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    displayValue = value;
  } else {
    const canonical = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(canonical)) return '';
    // Integral values keep full precision; decimals are display-only values.
    displayValue = canonical.includes('.')
      ? Number(canonical)
      : BigInt(canonical);
  }

  return new Intl.NumberFormat(getIntlLocale(locale), {
    numberingSystem: 'latn',
    ...options,
  }).format(displayValue);
}

function lookup(locale: TransactionLocale, key: string): string | undefined {
  let node: unknown = RESOURCES[locale] ?? RESOURCES.en;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Resolves a locale resource template and interpolates named placeholders.
 * Numeric values are formatted with the active locale's number rules; string
 * values (including machine codes) are inserted verbatim. Missing keys fall
 * back to English and finally to the key itself, which keeps regressions
 * visible without leaking raw diagnostics into the UI.
 */
export function resolveTransactionMessage(
  locale: TransactionLocale = DEFAULT_TRANSACTION_LOCALE,
  key: string,
  params: Record<string, string | number | bigint> = {},
): string {
  const template = lookup(locale, key) ?? lookup('en', key);
  if (template === undefined) return key;

  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return placeholder;
    const value = params[name];
    return typeof value === 'string'
      ? value
      : formatTransactionNumber(value, locale);
  });
}

/** CLDR plural category for a count in the active locale. */
export function pluralCategory(
  count: number,
  locale: TransactionLocale = DEFAULT_TRANSACTION_LOCALE,
): Intl.LDMLPluralRule {
  if (!Number.isFinite(count)) return 'other';
  try {
    return new Intl.PluralRules(getIntlLocale(locale)).select(Math.abs(count));
  } catch {
    return 'other';
  }
}

/**
 * Resolves a plural resource (`key.one`, `key.other`, and — for Arabic —
 * `key.zero`, `key.two`, `key.few`, `key.many`). `{count}` is always rendered
 * with locale-aware number formatting unless the caller overrides it.
 */
export function translateTransactionPlural(
  locale: TransactionLocale,
  key: string,
  count: number,
  params: Record<string, string | number | bigint> = {},
): string {
  const category = pluralCategory(count, locale);
  const values = { count, ...params };

  // Locale resources use `key_one` / `key_other`; dotted variants are also
  // accepted so contributors can nest plural forms when a namespace benefits.
  const variant = (suffix: string): string | undefined => {
    const dotted = `${key}.${suffix}`;
    const dottedValue = resolveTransactionMessage(locale, dotted, values);
    if (dottedValue !== dotted) return dottedValue;

    const underscored = `${key}_${suffix}`;
    const underscoredValue = resolveTransactionMessage(
      locale,
      underscored,
      values,
    );
    return underscoredValue === underscored ? undefined : underscoredValue;
  };

  return (
    variant(category) ??
    variant('other') ??
    resolveTransactionMessage(locale, key, values)
  );
}
