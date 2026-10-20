'use client';

import React from 'react';

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

export const TransactionProgressBar: React.FC<TransactionProgressBarProps> = ({
  currentStep,
  progressPercent,
  title,
  errorMessage,
  onRetry,
  onCancel,
}) => {
  const isFailed = currentStep === 'failed';
  const isRetryable = currentStep === 'retryable_error';
  const isSettled = currentStep === 'settled';
  const isOutage = currentStep === 'read_only_outage';

  const barColor = isSettled
    ? 'bg-green-600'
    : isFailed
    ? 'bg-red-600'
    : isRetryable
    ? 'bg-yellow-500'
    : isOutage
    ? 'bg-amber-600'
    : 'bg-blue-600';

  return (
    <div
      role="progressbar"
      aria-valuenow={progressPercent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={title || STEP_LABELS[currentStep]}
      className="w-full p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide">
          {title || 'Transaction Progress'}
        </span>
        <span className="text-xs font-mono font-medium text-gray-500">
          {progressPercent}%
        </span>
      </div>

      {/* Progress Track */}
      <div className="w-full h-2.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden mb-3">
        <div
          className={`h-full transition-all duration-300 ease-out ${barColor}`}
          style={{ width: `${Math.min(100, Math.max(0, progressPercent))}%` }}
        />
      </div>

      {/* Step Description */}
      <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
        {errorMessage || STEP_LABELS[currentStep]}
      </p>

      {/* Action buttons if in retryable or failed state */}
      {(isRetryable || isFailed) && (
        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 dark:border-gray-800">
          {isRetryable && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1 bg-yellow-500 hover:bg-yellow-600 text-white rounded text-xs font-medium"
            >
              Retry Step
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1 bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 text-gray-700 dark:text-gray-300 rounded text-xs font-medium"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
};
