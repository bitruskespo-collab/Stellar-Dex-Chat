'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useCurrencyConversion } from '@/hooks/useCurrencyConversion';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  transactionAmountSchema,
  type TransactionAmountProps,
} from '@/lib/transactionSchema';
import { motion } from 'framer-motion';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import { useOptionalTranslation } from '@/contexts/TranslationContext';
import SkeletonTransactionAmount from '@/components/ui/skeleton/SkeletonTransactionAmount';

/**
 * Component to display transaction amounts with live currency conversion.
 * Shows format: "100 XLM ≈ $12.40 USD"
 * Falls back to just amount if price is unavailable.
 *
 * Auto-scroll behaviour (issue #522): whenever the displayed amount changes,
 * the component scrolls itself into view so the user always sees the latest
 * value without manual scrolling.
 *
 * Optimistic UI (issue #839): while a new conversion is loading, show an
 * estimated fiat value using the last known exchange rate until the fetch settles.
 */
export function TransactionAmountDisplay(props: TransactionAmountProps) {
  const result = transactionAmountSchema.safeParse(props);
  const { fiatCurrency } = useUserPreferences();
  const reducedMotion = useReducedMotion();
  const { t, formatNumber } = useOptionalTranslation();

  // Derive values for hooks unconditionally — hooks must not be called after
  // a conditional return (Rules of Hooks). Fall back to neutral values when
  // the parse fails so useCurrencyConversion still receives valid arguments.
  const parsed = result.success ? result.data : null;
  const numericAmount = parsed
    ? typeof parsed.amount === 'string'
      ? parseFloat(parsed.amount)
      : parsed.amount
    : 0;
  const normalizedAsset = parsed?.asset || 'XLM';

  const { displayText, isLoading, hasError, fiatAmount } =
    useCurrencyConversion(numericAmount, normalizedAsset);

  const lastRateRef = useRef<number | null>(null);
  const lastConfirmedTextRef = useRef<string>('');

  useEffect(() => {
    if (!isLoading && !hasError && displayText) {
      lastConfirmedTextRef.current = displayText;
      if (fiatAmount != null && numericAmount > 0) {
        lastRateRef.current = fiatAmount / numericAmount;
      }
    }
  }, [displayText, isLoading, hasError, fiatAmount, numericAmount]);

  const currencySymbol = useMemo(() => {
    const symbolMap: Record<string, string> = {
      usd: '$',
      eur: '€',
      gbp: '£',
      ngn: '₦',
      cad: 'CA$',
      aud: 'A$',
      jpy: '¥',
    };
    return symbolMap[fiatCurrency.toLowerCase()] || '';
  }, [fiatCurrency]);

  const optimisticDisplayText = useMemo(() => {
    if (
      !isLoading ||
      !parsed ||
      lastRateRef.current == null ||
      numericAmount <= 0
    ) {
      return null;
    }
    const estimatedFiat = numericAmount * lastRateRef.current;
    // Display-only estimate: locale separators are applied here, never to the
    // canonical amount that is sent back to the contract or payout API.
    const formattedFiat = formatNumber(estimatedFiat, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const formattedAmount =
      normalizedAsset === 'XLM' && numericAmount < 0.001
        ? numericAmount.toFixed(7)
        : String(numericAmount);
    return `${formattedAmount} ${normalizedAsset} ≈ ${currencySymbol}${formattedFiat} ${fiatCurrency.toUpperCase()}`;
  }, [
    isLoading,
    parsed,
    numericAmount,
    normalizedAsset,
    currencySymbol,
    fiatCurrency,
    formatNumber,
  ]);

  const formattedHookText = useMemo(() => {
    if (!displayText || normalizedAsset !== 'XLM' || numericAmount >= 0.001) {
      return displayText;
    }
    const fixedAmount = numericAmount.toFixed(7);
    return displayText.replace(
      new RegExp(`^${numericAmount}(?=\\s)`),
      fixedAmount,
    );
  }, [displayText, normalizedAsset, numericAmount]);

  const renderedText = optimisticDisplayText ?? formattedHookText;
  const isOptimistic = optimisticDisplayText != null;

  // Auto-scroll: keep the latest amount visible whenever displayText updates.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    containerRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
  }, [renderedText, reducedMotion]);

  if (!result.success) {
    // A single localized, non-sensitive message avoids leaking schema internals
    // and keeps validation text out of component code.
    const errorMessage = t('transaction.amount.invalid');
    console.error(
      'TransactionAmountDisplay: Invalid props',
      result.error.format(),
    );
    return (
      <motion.span
        className="theme-soft-danger inline-flex items-center rounded-md border px-2 py-1 text-xs italic"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0.01 : 0.2 }}
      >
        {errorMessage}
      </motion.span>
    );
  }

  const { fiatAmount: storedFiatAmount, fiatCurrency: storedFiatCurrency } =
    result.data;

  // Show skeleton when loading with no fallback text
  if (isLoading && !renderedText) {
    return <SkeletonTransactionAmount />;
  }

  return (
    <motion.div
      ref={containerRef}
      className="flex flex-col gap-1"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0.01 : 0.3, ease: 'easeOut' }}
      data-testid="transaction-amount-display"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-optimistic={isOptimistic ? 'true' : 'false'}
    >
      <motion.span
        className={`font-medium theme-text-primary amount-ltr ${isOptimistic ? 'opacity-80' : ''}`}
        key={renderedText}
        initial={
          reducedMotion ? { opacity: 0.7 } : { scale: 0.95, opacity: 0.7 }
        }
        animate={reducedMotion ? { opacity: 1 } : { scale: 1, opacity: 1 }}
        transition={{ duration: reducedMotion ? 0.01 : 0.2, ease: 'easeOut' }}
        aria-busy={isOptimistic}
      >
        {renderedText}
      </motion.span>
      {storedFiatAmount && storedFiatCurrency && (
        <motion.span
          className="text-xs theme-text-muted amount-ltr"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{
            duration: reducedMotion ? 0.01 : 0.2,
            delay: reducedMotion ? 0 : 0.1,
          }}
        >
          {t('transaction.amount.stored_fiat', {
            amount: formatNumber(storedFiatAmount, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
            currency: storedFiatCurrency,
          })}
        </motion.span>
      )}
    </motion.div>
  );
}
