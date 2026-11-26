'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
} from 'react';
import en from '../locales/en.json';
import {
  formatTransactionNumber,
  resolveTransactionMessage,
  translateTransactionPlural,
  type TransactionLocale,
} from '@/lib/transactionLocale';

type TranslationKeys = typeof en;
type NestedKeyOf<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? `${K}.${NestedKeyOf<T[K]>}`
        : K;
    }[keyof T & string]
  : never;

export type TKey = NestedKeyOf<TranslationKeys>;

/** Supported locale codes. */
export type SupportedLocale = TransactionLocale;

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'fr', 'es', 'ar'];

/** Locales that use a right-to-left script. */
export const RTL_LOCALES: SupportedLocale[] = ['ar'];

/** Returns the CSS writing-direction for a given locale. */
export function getLocaleDir(locale: SupportedLocale): 'ltr' | 'rtl' {
  return RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
}

export interface TranslationContextType {
  t: (key: string, params?: Record<string, string | number | bigint>) => string;
  /** Locale-aware plural translation (`key.one`, `key.other`, CLDR variants). */
  tp: (
    key: string,
    count: number,
    params?: Record<string, string | number | bigint>,
  ) => string;
  /** Locale-aware number formatting for display; never changes canonical values. */
  formatNumber: (
    value: number | bigint | string,
    options?: Intl.NumberFormatOptions,
  ) => string;
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  /** True when the active locale uses right-to-left text direction. */
  isRtl: boolean;
  /** The CSS writing direction for the active locale ('ltr' | 'rtl'). */
  dir: 'ltr' | 'rtl';
}

const TranslationContext = createContext<TranslationContextType | undefined>(
  undefined,
);

/**
 * Detect the best supported locale from the browser's language preferences.
 * Falls back to 'en' when no supported language matches (#999).
 */
function detectBrowserLocale(): SupportedLocale {
  if (typeof window === 'undefined') return 'en';
  const preferred = navigator.languages ?? [navigator.language];
  for (const lang of preferred) {
    // Match on the primary language subtag (e.g. "fr" from "fr-FR").
    const primary = lang.split('-')[0].toLowerCase() as SupportedLocale;
    if (SUPPORTED_LOCALES.includes(primary)) {
      return primary;
    }
  }
  return 'en';
}

export function TranslationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<SupportedLocale>('en');

  // Load locale from storage or browser detection in an effect to avoid hydration mismatch
  useEffect(() => {
    try {
      const stored = localStorage.getItem('locale');
      if (stored && SUPPORTED_LOCALES.includes(stored as SupportedLocale)) {
        setLocaleState(stored as SupportedLocale);
        return;
      }
      const detected = detectBrowserLocale();
      setLocaleState(detected);
    } catch {
      // Storage access failed (e.g., Safari private mode), fall back to 'en'
      setLocaleState('en');
    }
  }, []);

  const handleSetLocale = useCallback((newLocale: SupportedLocale) => {
    setLocaleState(newLocale);
    try {
      localStorage.setItem('locale', newLocale);
    } catch {
      // Storage access failed, but state update still succeeds
    }
  }, []);

  // Update document.documentElement.lang and dir when locale changes.
  // Setting dir at the root element applies writing direction to the whole
  // document, so descendant components inherit it via CSS logical properties.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = getLocaleDir(locale);
    }
  }, [locale]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number | bigint>) =>
      resolveTransactionMessage(locale, key, params),
    [locale],
  );

  const tp = useCallback(
    (
      key: string,
      count: number,
      params?: Record<string, string | number | bigint>,
    ) => translateTransactionPlural(locale, key, count, params),
    [locale],
  );

  const formatNumber = useCallback(
    (value: number | bigint | string, options?: Intl.NumberFormatOptions) =>
      formatTransactionNumber(value, locale, options),
    [locale],
  );

  const isRtl = RTL_LOCALES.includes(locale);
  const dir = getLocaleDir(locale);

  const value = useMemo(
    () => ({
      t,
      tp,
      formatNumber,
      locale,
      setLocale: handleSetLocale,
      isRtl,
      dir,
    }),
    [t, tp, formatNumber, locale, handleSetLocale, isRtl, dir],
  );

  return (
    <TranslationContext.Provider value={value}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(TranslationContext);
  if (!context) {
    throw new Error('useTranslation must be used within a TranslationProvider');
  }
  return context;
}

/**
 * Read-only translation access for components that can also be rendered
 * outside the provider (isolated unit tests, server-rendered fallbacks).
 * It uses the English resources as a safe default and never mutates locale
 * state. Application code should prefer `useTranslation()`.
 */
export function useOptionalTranslation(): TranslationContextType {
  const context = useContext(TranslationContext);
  if (context) return context;

  return {
    t: (key, params) => resolveTransactionMessage('en', key, params),
    tp: (key, count, params) =>
      translateTransactionPlural('en', key, count, params),
    formatNumber: (value, options) =>
      formatTransactionNumber(value, 'en', options),
    locale: 'en',
    setLocale: () => undefined,
    isRtl: false,
    dir: 'ltr',
  };
}
