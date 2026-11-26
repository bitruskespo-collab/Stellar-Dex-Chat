import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationProvider, useTranslation } from './TranslationContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <TranslationProvider>{children}</TranslationProvider>;
}

describe('TranslationContext', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('defaults to English when nothing is saved and the browser locale is unsupported', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.locale).toBe('en');
    expect(result.current.t('common.retry')).toBe('Retry');
  });

  it('restores a previously saved locale from localStorage', () => {
    localStorage.setItem('locale', 'fr');

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.locale).toBe('fr');
  });

  it('ignores an unsupported saved locale and falls back to detection/default', () => {
    localStorage.setItem('locale', 'de');

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.locale).toBe('en');
  });

  it('setLocale updates state and persists the new locale', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLocale('es');
    });

    expect(result.current.locale).toBe('es');
    expect(localStorage.getItem('locale')).toBe('es');

    act(() => {
      result.current.setLocale('en');
    });

    expect(result.current.locale).toBe('en');
    expect(localStorage.getItem('locale')).toBe('en');
  });

  it('t() resolves nested keys for the active locale', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLocale('fr');
    });

    expect(result.current.t('common.retry')).not.toBe('common.retry');
  });

  it('t() falls back to English when a key is missing from a non-English locale', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLocale('fr');
    });

    // A key that is very unlikely to exist in any locale file.
    expect(result.current.t('this.key.does.not.exist')).toBe(
      'this.key.does.not.exist',
    );
  });

  it('t() interpolates params into the resolved string', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    const output = result.current.t('common.network_mismatch_warning', {
      expectedNetwork: 'Testnet',
    });

    // The template contains "{expectedNetwork}" twice; both must resolve.
    expect(output.match(/Testnet/g)).toHaveLength(2);
    expect(output).not.toBe(
      result.current.t('common.network_mismatch_warning'),
    );
  });

  it('t() formats numeric params with the active locale', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(
      result.current.t('transaction.queue.wait_estimate', { minutes: 1234 }),
    ).toBe(' (~1,234m)');

    act(() => {
      result.current.setLocale('fr');
    });

    expect(
      result.current
        .t('transaction.queue.wait_estimate', { minutes: 1234 })
        .replace(/[\u00a0\u202f]/g, ' '),
    ).toBe(' (~1 234 min)');
  });

  it('tp() applies CLDR plural categories for the active locale', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.tp('transaction.queue.depth', 1)).toBe('1 request');
    expect(result.current.tp('transaction.queue.depth', 1234)).toBe(
      '1,234 requests',
    );

    act(() => {
      result.current.setLocale('ar');
    });

    expect(result.current.tp('transaction.queue.depth', 0)).toBe('لا طلبات');
    expect(result.current.tp('transaction.queue.depth', 2)).toBe('طلبان');
    expect(result.current.tp('transaction.queue.depth', 11)).toBe('11 طلبًا');
  });

  it('formatNumber() uses locale separators and keeps ASCII digits', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.formatNumber(1234.5)).toBe('1,234.5');

    act(() => {
      result.current.setLocale('fr');
    });
    expect(
      result.current.formatNumber(1234.5).replace(/[\u00a0\u202f]/g, ' '),
    ).toBe('1 234,5');

    act(() => {
      result.current.setLocale('ar');
    });
    expect(result.current.formatNumber(1234.5)).toBe('1,234.5');
  });

  it('throws a clear error when consumed outside the provider', () => {
    expect(() => renderHook(() => useTranslation())).toThrow(
      'useTranslation must be used within a TranslationProvider',
    );
  });

  it('handles blocked localStorage gracefully during initialization', () => {
    const originalGetItem = localStorage.getItem;
    localStorage.getItem = vi.fn(() => {
      throw new Error('Storage blocked');
    });

    const { result } = renderHook(() => useTranslation(), { wrapper });

    expect(result.current.locale).toBe('en');

    localStorage.getItem = originalGetItem;
  });

  it('handles blocked localStorage gracefully during setLocale', () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = vi.fn(() => {
      throw new Error('Storage blocked');
    });

    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLocale('fr');
    });

    expect(result.current.locale).toBe('fr');

    localStorage.setItem = originalSetItem;
  });

  it('updates document.documentElement.lang when locale changes', () => {
    const { result } = renderHook(() => useTranslation(), { wrapper });

    act(() => {
      result.current.setLocale('fr');
    });

    expect(document.documentElement.lang).toBe('fr');

    act(() => {
      result.current.setLocale('es');
    });

    expect(document.documentElement.lang).toBe('es');
  });
});
