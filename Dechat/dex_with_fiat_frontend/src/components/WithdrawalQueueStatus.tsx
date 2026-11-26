'use client';

import React from 'react';
import {
  useWithdrawalQueueStatus,
  WithdrawalQueueStatusOptions,
} from '@/hooks/useWithdrawalQueueStatus';
import {
  Clock,
  AlertTriangle,
  RefreshCw,
  CheckCircle2,
  Info,
  Loader2,
} from 'lucide-react';
import { useTranslation } from '@/contexts/TranslationContext';

export interface WithdrawalQueueStatusProps extends WithdrawalQueueStatusOptions {
  className?: string;
  onRefresh?: () => void;
}

export function WithdrawalQueueStatus({
  className = '',
  onRefresh,
  ...options
}: WithdrawalQueueStatusProps) {
  const { t, tp, formatNumber } = useTranslation();
  const {
    state,
    depth,
    oldestAgeLedgers,
    estimatedWaitMinutes,
    estimatedPosition,
    specificRequest,
    contractVersion,
    isStale,
    refetch,
  } = useWithdrawalQueueStatus(options);

  // Diagnostic text from the hook is intentionally not rendered: it may
  // contain raw RPC details. Only machine values (state, version) feed the
  // localized templates below.
  const expectedVersion = options.expectedVersion ?? 1;

  const handleRefresh = async () => {
    await refetch();
    onRefresh?.();
  };

  if (state === 'loading') {
    return (
      <div
        data-testid="queue-status-loading"
        data-queue-state="loading"
        role="status"
        aria-live="polite"
        aria-busy="true"
        className={`theme-surface-muted theme-border rounded-xl border p-4 flex items-center gap-3 text-sm text-gray-400 ${className}`}
      >
        <Loader2 className="w-4 h-4 animate-spin text-blue-400 shrink-0" />
        <span>{t('transaction.queue.loading')}</span>
      </div>
    );
  }

  if (state === 'version_mismatch') {
    return (
      <div
        data-testid="queue-status-version-mismatch"
        data-queue-state="version_mismatch"
        role="alert"
        aria-live="assertive"
        className={`bg-amber-950/40 border border-amber-600/50 rounded-xl p-4 text-xs text-amber-200 ${className}`}
      >
        <div className="flex items-center gap-2 font-semibold mb-1 text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
          <span>{t('transaction.queue.version_mismatch_title')}</span>
        </div>
        <p>
          {t('transaction.queue.version_mismatch_detail', {
            expected: expectedVersion,
            found:
              contractVersion === null
                ? t('common.unknown')
                : contractVersion,
          })}
        </p>
      </div>
    );
  }

  if (state === 'rpc_error') {
    return (
      <div
        data-testid="queue-status-rpc-error"
        data-queue-state="rpc_error"
        role="alert"
        aria-live="assertive"
        className={`bg-red-950/40 border border-red-600/50 rounded-xl p-4 text-xs text-red-200 ${className}`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 font-semibold text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
            <span>{t('transaction.queue.unavailable_title')}</span>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            data-testid="queue-status-retry"
            className="inline-flex items-center gap-1 text-[11px] underline hover:text-white"
          >
            <RefreshCw className="w-3 h-3" /> {t('transaction.queue.retry')}
          </button>
        </div>
        <p className="text-gray-300">{t('transaction.queue.rpc_failure')}</p>
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div
        data-testid="queue-status-empty"
        data-queue-state="empty"
        role="status"
        aria-live="polite"
        className={`theme-surface-muted theme-border rounded-xl border p-4 text-xs ${className}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-400 font-medium">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{t('transaction.queue.empty_title')}</span>
          </div>
          <span className="text-[10px] text-gray-500 font-mono">
            {tp('transaction.queue.empty_pending', 0)}
          </span>
        </div>
        <p className="text-gray-400 mt-1 text-[11px]">
          {t('transaction.queue.empty_description')}
        </p>
      </div>
    );
  }

  // Active or Stale state
  return (
    <div
      data-testid="queue-status-active"
      data-queue-state={isStale ? 'stale' : 'active'}
      data-queue-depth={depth}
      role="status"
      aria-live="polite"
      className={`theme-surface-muted theme-border rounded-xl border p-4 space-y-3 ${className}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-xs font-semibold theme-text-primary">
            {t('transaction.queue.title')}
          </span>
          {isStale && (
            <span
              data-testid="queue-status-stale"
              className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded"
            >
              {t('transaction.queue.stale')}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          data-testid="queue-status-refresh"
          title={t('transaction.queue.refresh')}
          aria-label={t('transaction.queue.refresh')}
          className="p-1 text-gray-400 hover:text-gray-200 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="theme-surface rounded-lg p-2.5 border theme-border">
          <span className="text-gray-400 text-[10px] block uppercase tracking-wider mb-0.5">
            {t('transaction.queue.depth_label')}
          </span>
          <span
            data-testid="queue-status-depth"
            className="font-bold text-sm theme-text-primary"
          >
            {tp('transaction.queue.depth', depth ?? 0)}
          </span>
        </div>

        <div className="theme-surface rounded-lg p-2.5 border theme-border">
          <span className="text-gray-400 text-[10px] block uppercase tracking-wider mb-0.5">
            {t('transaction.queue.oldest_label')}
          </span>
          <span
            data-testid="queue-status-oldest-age"
            className="font-bold text-sm theme-text-primary"
          >
            {oldestAgeLedgers !== null && oldestAgeLedgers > 0
              ? tp('transaction.queue.oldest', oldestAgeLedgers)
              : t('transaction.queue.recent')}
            {estimatedWaitMinutes !== null &&
              t('transaction.queue.wait_estimate', {
                minutes: estimatedWaitMinutes,
              })}
          </span>
        </div>
      </div>

      {estimatedPosition !== null && (
        <div className="flex items-center justify-between text-xs px-1">
          <span className="text-gray-400">
            {t('transaction.queue.position_label')}
          </span>
          <span
            data-testid="queue-status-position"
            className="font-semibold text-blue-400"
          >
            #{formatNumber(estimatedPosition + 1)}
          </span>
        </div>
      )}

      {specificRequest && (
        <div className="border-t theme-border pt-2 text-xs text-gray-300">
          <span className="text-gray-400 block text-[10px]">
            {t('transaction.queue.request_label', { id: specificRequest.id })}
          </span>
          <span>
            {t('transaction.queue.queued_at', {
              ledger: specificRequest.queuedAtLedger,
            })}
          </span>
        </div>
      )}

      {/* Differentiate queue estimate from guaranteed settlement time */}
      <div
        data-testid="queue-status-settlement-disclaimer"
        className="flex items-start gap-1.5 bg-blue-950/30 border border-blue-800/40 rounded-lg p-2.5 text-[11px] text-blue-200"
      >
        <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
        <span className="leading-snug">
          {t('transaction.queue.settlement_disclaimer')}
        </span>
      </div>
    </div>
  );
}

export default WithdrawalQueueStatus;
