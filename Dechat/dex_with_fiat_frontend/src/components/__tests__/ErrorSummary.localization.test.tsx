import React from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ErrorSummary from '../ErrorSummary';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { classifyError } from '@/lib/errorMessages';
import en from '@/locales/en.json';
import fr from '@/locales/fr.json';
import ar from '@/locales/ar.json';

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

function renderSummary(
  locale: 'en' | 'fr' | 'ar',
  error: Parameters<typeof ErrorSummary>[0]['error'],
  onDismiss?: () => void,
) {
  localStorage.setItem('locale', locale);
  return render(
    <TranslationProvider>
      <ErrorSummary id="localized-error" error={error} onDismiss={onDismiss} />
    </TranslationProvider>,
  );
}

describe('ErrorSummary transaction localization (#292)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders message and action from a machine code, not the legacy English text', () => {
    const error = {
      ...classifyError(new Error('Soroban: Error(301)')),
      message: 'RAW DIAGNOSTIC MUST NOT BE SHOWN',
      action: 'Legacy English action',
    };

    renderSummary('fr', error);

    expect(screen.getByText(fr.errors['301'])).toBeDefined();
    expect(screen.getByText(fr.transaction.errors.actions.reduce_amount)).toBeDefined();
    expect(screen.queryByText(error.message)).toBeNull();
    expect(screen.getByTestId('error-summary')).toHaveAttribute(
      'data-error-code',
      'CONTRACT_301',
    );
  });

  it('uses the Arabic dismissal label while keeping the code untouched', () => {
    const onDismiss = vi.fn();
    renderSummary('ar', classifyError(new Error('USER_DECLINED')), onDismiss);

    expect(
      screen.getByRole('button', {
        name: ar.transaction.errors.dismiss_error,
      }),
    ).toBeDefined();
    expect(screen.getByTestId('error-summary')).toHaveAttribute(
      'data-error-code',
      'USER_DECLINED',
    );
    expect(screen.getByText(ar.transaction.errors.wallet.user_declined)).toBeDefined();
  });

  it('keeps explicitly supplied text when there is no machine code', () => {
    renderSummary('en', {
      message: 'Payout failed. No funds were sent.',
      action: 'Retry the payout.',
      category: 'contract',
      isRetryable: true,
    });

    expect(screen.getByText('Payout failed. No funds were sent.')).toBeDefined();
    expect(screen.getByText('Retry the payout.')).toBeDefined();
    expect(en.transaction.errors.unknown.message).not.toBe(
      'Payout failed. No funds were sent.',
    );
  });
});
