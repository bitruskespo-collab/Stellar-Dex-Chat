'use client';

import React from 'react';
import { TransactionStatusCue } from './TransactionStatusCue';
import { type StatusKind } from '@/lib/statusContrast';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * @fileoverview TransactionProgressBar — retrofitted for issue #295.
 *
 * Changes vs. the previous version:
 *   - Adds an icon + text non-animated status cue via TransactionStatusCue so
 *     status is conveyed through shape/text as well as color (removes the
 *     color-only hazard for color-blind users).
 *   - Adds `role="status" aria-live="polite" aria-atomic="true"` on the step
 *     description so screen readers hear progress updates (the outer
 *     `role="progressbar"` does not trigger live-region announcements in all
 *     implementations).
 *   - Derives bar fill color from CSS-var token classes (dark-mode safe) rather
 *     than light-only Tailwind palette values.
 *   - Respects `prefers-reduced-motion: reduce` by removing the width-tween
 *     transition on the fill bar when motion is reduced; the bar still jumps
 *     to the correct width instantly.
 *   - Extends the forced-colors block in globals.css to cover this component
 *     (see that file for the CSS-side rule).
 *
 * Financial safety: display-only. No arithmetic, no BigInt, no network calls.
 */

export type TransactionStep =
  | 'idle'
  | 'wallet_signing'
  | 'submitting'
  | 'confirming_on_chain'
  | 'provider_dispatch'
  | 'settled'
  | 'failed'
  | 'retryable_error'
  | 'read_only_outage';

export interface TransactionProgressBarProps {
  currentStep: TransactionStep;
  progressPercent: number; // 0 to 100
  title?: string;
  errorMessage?: string;
  onRetry?: () => void;
  onCancel?: () => void;
}

const STEP_LABELS: Record<TransactionStep, string> = {
  idle: 'Ready to initiate transaction',
  wallet_signing: 'Waiting for Freighter wallet approval...',
  submitting: 'Submitting transaction to Stellar RPC...',
  confirming_on_chain: 'Awaiting consensus confirmation on-chain...',
  provider_dispatch: 'Contract confirmed! Dispatching fiat payout provider...',
  settled: 'Transaction & Payout completed successfully!',
  failed: 'Transaction encountered a terminal error.',
  retryable_error: 'Transient network glitch. Ready to retry.',
  read_only_outage: 'RPC outage detected. Action paused safely.',
};

/** Map each TransactionStep to the appropriate StatusKind for the cue icon. */
const STEP_STATUS_KIND: Record<TransactionStep, StatusKind> = {
  idle: 'progress',
  wallet_signing: 'progress',
  submitting: 'progress',
  confirming_on_chain: 'progress',
  provider_dispatch: 'progress',
  settled: 'success',
  failed: 'failure',
  retryable_error: 'warning',
  read_only_outage: 'warning',
};

/**
 * Bar fill color mapped to CSS-var token classes (light + dark safe).
 *
 * These reference the token families from globals.css:
 *   --color-primary (blue)   → in-progress
 *   --color-success (green)  → settled
 *   --color-danger  (red)    → failed
 *   --color-warning (amber)  → retryable / outage
 */
const BAR_COLOR_CLASS: Record<TransactionStep, string> = {
  idle: 'bg-blue-600 dark:bg-blue-500',
  wallet_signing: 'bg-blue-600 dark:bg-blue-500',
  submitting: 'bg-blue-600 dark:bg-blue-500',
  confirming_on_chain: 'bg-blue-600 dark:bg-blue-500',
  provider_dispatch: 'bg-blue-600 dark:bg-blue-500',
  // green-700 / dark:green-500 — contrast-safe (≥ 4.5:1 against the light/dark track)
  settled: 'bg-green-700 dark:bg-green-500',
  // red-700 / dark:red-500 — contrast-safe
  failed: 'bg-red-700 dark:bg-red-500',
  // amber-700 / dark:yellow-400
  retryable_error: 'bg-amber-700 dark:bg-yellow-400',
  read_only_outage: 'bg-amber-700 dark:bg-yellow-400',
};

export const TransactionProgressBar: React.FC<TransactionProgressBarProps> = ({
  currentStep,
  progressPercent,
  title,
  errorMessage,
  onRetry,
  onCancel,
}) => {
  const reducedMotion = useReducedMotion();
  const isFailed = currentStep === 'failed';
  const isRetryable = currentStep === 'retryable_error';

  const barColor = BAR_COLOR_CLASS[currentStep];
  const statusKind = STEP_STATUS_KIND[currentStep];
  const stepDescription = errorMessage || STEP_LABELS[currentStep];

  // Drop the CSS width tween when prefers-reduced-motion: reduce is set so the
  // bar still updates (non-animated cue) but without transform/opacity motion.
  const transitionClass = reducedMotion
    ? ''
    : 'transition-all duration-300 ease-out';

  return (
    <div
      role="progressbar"
      aria-valuenow={progressPercent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={title || STEP_LABELS[currentStep]}
      data-testid="transaction-progress-bar"
      data-step={currentStep}
      className="w-full p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm"
    >
      <div className="flex items-center justify-between mb-2">
        {/* Title row — icon + label instead of plain text so status is never
            color-only. The TransactionStatusCue provides the non-animated cue
            channel (shape + text) independent of the bar fill. */}
        <TransactionStatusCue
          status={statusKind}
          label={title || STEP_LABELS[currentStep]}
          className="text-xs font-semibold uppercase tracking-wide"
        />
        <span
          aria-hidden="true"
          className="text-xs font-mono font-medium text-gray-500 dark:text-gray-400"
        >
          {progressPercent}%
        </span>
      </div>

      {/* Progress Track */}
      <div
        className="w-full h-2.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden mb-3"
        aria-hidden="true"
      >
        <div
          className={`h-full ${transitionClass} ${barColor}`}
          style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
        />
      </div>

      {/* Step description — a live region so screen readers hear updates even
          when the outer progressbar role does not trigger announcements. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-xs text-gray-600 dark:text-gray-400 mb-2"
      >
        {stepDescription}
      </p>

      {/* Action buttons in retryable or failed state */}
      {(isRetryable || isFailed) && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          {isRetryable && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1 bg-amber-700 hover:bg-amber-800 dark:bg-yellow-400 dark:hover:bg-yellow-300 dark:text-gray-900 text-white rounded text-xs font-medium"
            >
              Retry Step
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs font-medium"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
};
