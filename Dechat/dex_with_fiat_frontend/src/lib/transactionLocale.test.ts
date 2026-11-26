import { describe, expect, it } from 'vitest';
import {
  formatTransactionNumber,
  getIntlLocale,
  pluralCategory,
  resolveTransactionMessage,
  translateTransactionPlural,
  type TransactionLocale,
} from './transactionLocale';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';

const normalizeSpaces = (value: string) =>
  value.replace(/[\u00a0\u202f]/g, ' ');

function leafPaths(node: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafPaths(value as Record<string, unknown>, path);
    }
    return [path];
  });
}

describe('transaction locale resources', () => {
  it('ships every English transaction key in all supported locales', () => {
    const resources: Record<TransactionLocale, Record<string, unknown>> = {
      en: en as Record<string, unknown>,
      fr: fr as Record<string, unknown>,
      es: es as Record<string, unknown>,
      ar: ar as Record<string, unknown>,
    };
    const englishKeys = leafPaths(
      (en as Record<string, unknown>).transaction as Record<string, unknown>,
    );

    expect(englishKeys.length).toBeGreaterThan(0);
    for (const locale of ['fr', 'es', 'ar'] as const) {
      // Compare raw leaf keys: the message resolver falls back to English, so
      // using it here would hide a missing translation.
      const localizedKeys = new Set(
        leafPaths(
          resources[locale].transaction as Record<string, unknown>,
        ),
      );
      for (const key of englishKeys) {
        expect(localizedKeys.has(key)).toBe(true);
      }
    }
  });

  it('keeps diagnostic action values as stable machine IDs, not prose', () => {
    const enTransaction = en as Record<string, unknown>;
    const enErrors = enTransaction.transaction as Record<string, unknown>;
    const actions = (
      (enErrors.errors as Record<string, unknown>).actions as Record<
        string,
        unknown
      >
    );
    const actionIds = new Set(Object.keys(actions));
    expect(actionIds.size).toBeGreaterThan(0);

    for (const resource of [en, fr, es, ar]) {
      const transaction = (resource as Record<string, unknown>)
        .transaction as Record<string, unknown>;
      const diagnostics = (
        (transaction.errors as Record<string, unknown>).recovery as Record<
          string,
          unknown
        >
      );
      for (const entry of Object.values(diagnostics)) {
        const action = (entry as Record<string, unknown>).action;
        expect(typeof action).toBe('string');
        expect(actionIds.has(action as string)).toBe(true);
      }
    }
  });

  it('translates the newest canonical contract codes in every locale', () => {
    // Mirrors the 1200-series additions in `stellar-contracts/src/lib.rs`.
    const newestCodes = ['1201', '1202', '1203', '1204', '1205'];
    for (const resource of [en, fr, es, ar]) {
      const errors = (resource as Record<string, unknown>).errors as Record<
        string,
        unknown
      >;
      for (const code of newestCodes) {
        expect(typeof errors[code]).toBe('string');
        expect(errors[code]).not.toBe('');
      }
    }
  });

  it('ships every numeric contract code in all supported locales', () => {
    const numericCodes = (resource: Record<string, unknown>): string[] =>
      Object.keys((resource.errors as Record<string, unknown>) ?? {}).filter(
        (key) => /^\d+$/.test(key),
      );

    const englishCodes = numericCodes(en as Record<string, unknown>);
    expect(englishCodes.length).toBeGreaterThan(0);
    for (const resource of [fr, es, ar] as const) {
      expect(numericCodes(resource as Record<string, unknown>).sort()).toEqual(
        [...englishCodes].sort(),
      );
    }
  });

  it('never includes credentials in transaction resources', () => {
    for (const resource of [en, fr, es, ar]) {
      const serialized = JSON.stringify(resource);
      expect(serialized).not.toMatch(/ghp_[A-Za-z0-9]+/);
      expect(serialized).not.toMatch(/S[A-Z0-9]{55}/);
    }
  });
});

describe('formatTransactionNumber', () => {
  it('formats group/decimal separators per locale', () => {
    expect(formatTransactionNumber(1234.5, 'en')).toBe('1,234.5');
    expect(normalizeSpaces(formatTransactionNumber(1234.5, 'fr'))).toBe(
      '1 234,5',
    );
    // Spanish groups from 10,000 upwards, so four-digit values are ungrouped.
    expect(normalizeSpaces(formatTransactionNumber(1234.5, 'es'))).toBe(
      '1234,5',
    );
  });

  it('keeps Arabic display numeric digits ASCII for parser compatibility', () => {
    const formatted = formatTransactionNumber(1234.5, 'ar');
    expect(formatted).toBe('1,234.5');
    expect(formatted).toMatch(/^[0-9,.]+$/);
  });

  it('formats bigint values without converting through a float', () => {
    const large = 9_007_199_254_740_993n;
    expect(formatTransactionNumber(large, 'en')).toBe('9,007,199,254,740,993');
  });

  it('rejects non-finite and non-canonical values instead of showing garbage', () => {
    expect(formatTransactionNumber(Number.NaN, 'en')).toBe('');
    expect(formatTransactionNumber(Number.POSITIVE_INFINITY, 'en')).toBe('');
    expect(formatTransactionNumber('1,234.5', 'en')).toBe('');
  });

  it('maps shipped locales to stable Intl tags', () => {
    expect(getIntlLocale('en')).toBe('en-US');
    expect(getIntlLocale('fr')).toBe('fr-FR');
    expect(getIntlLocale('es')).toBe('es-ES');
    expect(getIntlLocale('ar')).toBe('ar-EG');
  });
});

describe('pluralCategory and translateTransactionPlural', () => {
  it('uses CLDR categories, including all Arabic forms', () => {
    expect(pluralCategory(1, 'en')).toBe('one');
    expect(pluralCategory(2, 'en')).toBe('other');
    const arabic = [0, 1, 2, 3, 11, 100].map((n) => pluralCategory(n, 'ar'));
    expect(arabic).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
  });

  it('renders English one/other forms with locale-formatted counts', () => {
    expect(translateTransactionPlural('en', 'transaction.queue.depth', 1)).toBe(
      '1 request',
    );
    expect(
      translateTransactionPlural('en', 'transaction.queue.depth', 1234),
    ).toBe('1,234 requests');
  });

  it('renders Arabic plural categories with ASCII count digits', () => {
    expect(translateTransactionPlural('ar', 'transaction.queue.depth', 0)).toBe(
      'لا طلبات',
    );
    expect(translateTransactionPlural('ar', 'transaction.queue.depth', 2)).toBe(
      'طلبان',
    );
    expect(
      translateTransactionPlural('ar', 'transaction.queue.depth', 11),
    ).toBe('11 طلبًا');
  });

  it('falls back to the other category when a locale lacks the exact form', () => {
    expect(translateTransactionPlural('en', 'transaction.queue.depth', 0)).toBe(
      '0 requests',
    );
  });
});

describe('resolveTransactionMessage', () => {
  it('replaces every repeated placeholder', () => {
    const output = resolveTransactionMessage(
      'en',
      'common.network_mismatch_warning',
      {
        expectedNetwork: 'Testnet',
      },
    );
    expect(output.match(/Testnet/g)).toHaveLength(2);
  });

  it('formats numeric params using the active locale', () => {
    expect(
      resolveTransactionMessage('en', 'transaction.queue.wait_estimate', {
        minutes: 1234,
      }),
    ).toBe(' (~1,234m)');
    expect(
      normalizeSpaces(
        resolveTransactionMessage('fr', 'transaction.queue.wait_estimate', {
          minutes: 1234,
        }),
      ),
    ).toBe(' (~1 234 min)');
  });

  it('leaves unknown placeholders visible and returns the key when missing', () => {
    expect(resolveTransactionMessage('en', 'transaction.queue.depth')).toBe(
      'transaction.queue.depth',
    );
    expect(resolveTransactionMessage('en', 'does.not.exist')).toBe(
      'does.not.exist',
    );
  });
});
