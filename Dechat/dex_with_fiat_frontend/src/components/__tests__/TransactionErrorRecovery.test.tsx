import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';
import { TransactionErrorRecovery } from '../TransactionErrorRecovery';
import { TranslationProvider } from '@/contexts/TranslationContext';
import type { DiagnosticDetails } from '@/lib/transactionErrorRecovery';
import fr from '@/locales/fr.json';

const renderRecovery = (
  diagnostics: DiagnosticDetails,
  handlers: { onRetry?: () => void; onDismiss?: () => void } = {},
) =>
  render(
    <TranslationProvider>
      <TransactionErrorRecovery diagnostics={diagnostics} {...handlers} />
    </TranslationProvider>,
  );

const baseDiagnostics: DiagnosticDetails = {
  correlationId: 'corr-123',
  errorCode: 401,
  category: 'contract',
  isRetryable: false,
  safeMessage: 'Insufficient balance to complete this transaction.',
  actionGuidance: 'Fund your wallet with additional XLM.',
  timestamp: 1_700_000_000_000,
};

describe('TransactionErrorRecovery (#292)', () => {
  it('localizes visible text while preserving machine code metadata', () => {
    localStorage.setItem('locale', 'fr');

    const { container } = renderRecovery(baseDiagnostics);

    const root = screen.getByTestId('transaction-error-recovery');
    expect(root.getAttribute('data-error-code')).toBe('401');
    expect(root.getAttribute('data-error-category')).toBe('contract');
    expect(root.getAttribute('data-retryable')).toBe('false');
    expect(container).not.toHaveTextContent(baseDiagnostics.safeMessage);
    expect(screen.getByText(fr.errors['401'])).toBeDefined();
    expect(
      screen.getByText(fr.transaction.errors.actions.fund_wallet),
    ).toBeDefined();
    expect(screen.getByText(fr.transaction.recovery.title)).toBeDefined();
    expect(screen.getByText('corr-123')).toBeDefined();
    expect(screen.queryByTestId('transaction-error-retry')).toBeNull();
  });

  it('keeps retry available for an authorization failure and localizes the label', () => {
    localStorage.setItem('locale', 'fr');
    const onRetry = vi.fn();

    renderRecovery(
      {
        ...baseDiagnostics,
        errorCode: 'USER_DECLINED',
        category: 'wallet',
        isRetryable: true,
      },
      { onRetry },
    );

    const retry = screen.getByTestId('transaction-error-retry');
    expect(retry.textContent).toBe(fr.transaction.recovery.retry);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByTestId('transaction-error-recovery')
        .getAttribute('data-error-code'),
    ).toBe('USER_DECLINED');
    expect(
      screen.getByText(fr.transaction.errors.recovery.USER_DECLINED.message),
    ).toBeDefined();
  });

  it('uses the localized generic guidance for an unknown diagnostic code', () => {
    localStorage.setItem('locale', 'ar');

    renderRecovery({
      ...baseDiagnostics,
      errorCode: 'UNKNOWN_ERROR',
      category: 'unknown',
      isRetryable: false,
    });

    expect(screen.getByText('فشلت المعاملة')).toBeDefined();
    expect(screen.getByText('حدث خطأ غير متوقع في المعاملة.')).toBeDefined();
    expect(
      screen.getByText('اتصل بالدعم مع معرّف الارتباط المعروض أدناه.'),
    ).toBeDefined();
  });
});
