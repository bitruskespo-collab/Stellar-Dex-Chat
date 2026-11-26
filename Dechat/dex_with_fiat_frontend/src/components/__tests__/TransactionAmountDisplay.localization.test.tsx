import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TransactionAmountDisplay } from '../TransactionAmountDisplay';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { formatTransactionNumber } from '@/lib/transactionLocale';
import fr from '@/locales/fr.json';

vi.mock('@/hooks/useCurrencyConversion', () => ({
  useCurrencyConversion: vi.fn(() => ({
    displayText: '100 XLM ≈ $12.40 USD',
    fiatAmount: 12.4,
    fiatCurrency: 'USD',
    isLoading: false,
    hasError: false,
  })),
}));

vi.mock('@/contexts/UserPreferencesContext', () => ({
  useUserPreferences: () => ({ fiatCurrency: 'usd' }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.PropsWithChildren) => (
      <div {...props}>{children}</div>
    ),
    span: ({ children, ...props }: React.PropsWithChildren) => (
      <span {...props}>{children}</span>
    ),
  },
}));

function renderInLocale(locale: 'fr', ui: React.ReactElement) {
  localStorage.setItem('locale', locale);
  return render(<TranslationProvider>{ui}</TranslationProvider>);
}

describe('TransactionAmountDisplay locale rules (#292)', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('formats stored fiat with locale separators and a translated label', () => {
    renderInLocale(
      'fr',
      <TransactionAmountDisplay
        amount={100}
        asset="XLM"
        fiatAmount={1234.5}
        fiatCurrency="USD"
      />,
    );

    const formattedAmount = formatTransactionNumber(1234.5, 'fr', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(formattedAmount).toMatch(/^1[\u00a0\u202f ]234,50$/);
    const expected = fr.transaction.amount.stored_fiat
      .replace('{amount}', formattedAmount)
      .replace('{currency}', 'USD');
    expect(
      screen.getByText((_, element) => element?.textContent === expected),
    ).toBeDefined();
  });

  it('uses a localized validation message instead of raw schema text', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderInLocale(
      'fr',
      <TransactionAmountDisplay amount={0} asset="XLM" />,
    );

    expect(screen.getByText(fr.transaction.amount.invalid)).toBeDefined();
    consoleSpy.mockRestore();
  });
});
