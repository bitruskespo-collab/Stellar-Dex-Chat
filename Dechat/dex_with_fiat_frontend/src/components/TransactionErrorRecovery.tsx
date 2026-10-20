'use client';

import React, { useState } from 'react';
import { DiagnosticDetails } from '../lib/transactionErrorRecovery';

interface TransactionErrorRecoveryProps {
  diagnostics: DiagnosticDetails;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export const TransactionErrorRecovery: React.FC<TransactionErrorRecoveryProps> = ({
  diagnostics,
  onRetry,
  onDismiss,
}) => {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyCorrelationId = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics.correlationId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="p-4 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-red-900 dark:text-red-200 my-3"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h3 className="font-semibold text-base mb-1">Transaction Failed</h3>
          <p className="text-sm text-red-800 dark:text-red-300 mb-2">
            {diagnostics.safeMessage}
          </p>
          <div className="text-sm font-medium bg-red-100/70 dark:bg-red-900/40 p-2.5 rounded text-red-950 dark:text-red-100 mb-3">
            <span className="font-bold">Next Action: </span>
            {diagnostics.actionGuidance}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
            <span>Correlation ID:</span>
            <code className="bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded font-mono">
              {diagnostics.correlationId}
            </code>
            <button
              type="button"
              onClick={copyCorrelationId}
              aria-label="Copy correlation ID"
              className="text-xs underline hover:no-underline font-medium text-primary"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {diagnostics.isRetryable && onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-xs transition-colors focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                Retry Transaction
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="px-3 py-1.5 bg-gray-200 dark:bg-zinc-800 hover:bg-gray-300 text-gray-800 dark:text-zinc-200 rounded font-medium text-xs transition-colors"
              >
                Dismiss
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowDiagnostics((prev) => !prev)}
              aria-expanded={showDiagnostics}
              className="px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:underline"
            >
              {showDiagnostics ? 'Hide diagnostics' : 'Show diagnostics'}
            </button>
          </div>

          {showDiagnostics && (
            <div className="mt-3 p-3 bg-zinc-900 text-zinc-100 rounded text-xs font-mono overflow-x-auto">
              <p>Error Code: {diagnostics.errorCode || 'N/A'}</p>
              <p>Category: {diagnostics.category}</p>
              <p>Timestamp: {new Date(diagnostics.timestamp).toISOString()}</p>
              {diagnostics.rawDetailsSanitized && (
                <div className="mt-2 border-t border-zinc-700 pt-2">
                  <p className="font-semibold text-zinc-400">Sanitized Trace:</p>
                  <pre className="whitespace-pre-wrap">{diagnostics.rawDetailsSanitized}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
