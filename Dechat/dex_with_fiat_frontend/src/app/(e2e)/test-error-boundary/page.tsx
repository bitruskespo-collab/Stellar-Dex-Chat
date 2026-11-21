'use client';

import { useEffect, useRef, useState } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';

/** Child that crashes on demand */
function BombChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Deliberate test crash');
  }
  return (
    <p data-testid="child-content" className="text-sm text-green-700">
      Child rendered successfully.
    </p>
  );
}

/**
 * Critical financial states exercised by visual regression tests.
 *
 * Each state renders deterministic, masked content so screenshots stay stable
 * across runs. Volatile values (addresses, amounts, timestamps, IDs) are
 * replaced with fixed placeholders via `data-visual-mask`.
 */
type FinancialState =
  | 'wallet-disconnected'
  | 'stale-quote'
  | 'pending-payout'
  | 'failed-payout'
  | 'degraded-rpc';

const FINANCIAL_STATES: FinancialState[] = [
  'wallet-disconnected',
  'stale-quote',
  'pending-payout',
  'failed-payout',
  'degraded-rpc',
];

/** Fixed placeholder used for any volatile value in the harness. */
const MASKED = '0x0000…0000';

function FinancialStatePanel({ state }: { state: FinancialState }) {
  const content: Record<FinancialState, { title: string; body: string }> = {
    'wallet-disconnected': {
      title: 'Wallet disconnected',
      body: 'Connect a wallet to view balances and quotes.',
    },
    'stale-quote': {
      title: 'Quote expired',
      body: 'This quote is stale. Refresh to get an updated rate.',
    },
    'pending-payout': {
      title: 'Payout pending',
      body: 'Your payout is being processed.',
    },
    'failed-payout': {
      title: 'Payout failed',
      body: 'The payout could not be completed. Please retry.',
    },
    'degraded-rpc': {
      title: 'Degraded RPC',
      body: 'Network is degraded. Data may be delayed.',
    },
  };

  const { title, body } = content[state];

  return (
    <section
      data-testid={`financial-state-${state}`}
      data-visual-state={state}
      className="rounded border p-4 flex flex-col gap-2"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-sm">{body}</p>
      <dl className="text-xs grid grid-cols-2 gap-1">
        <dt>Wallet</dt>
        <dd data-visual-mask="address">{MASKED}</dd>
        <dt>Amount</dt>
        <dd data-visual-mask="amount">0.00</dd>
        <dt>Updated</dt>
        <dd data-visual-mask="timestamp">--:--:--</dd>
        <dt>Reference</dt>
        <dd data-visual-mask="id">REF-0000</dd>
      </dl>
    </section>
  );
}

/**
 * Test harness page for ErrorBoundary E2E tests.
 *
 * A "Throw Error" button triggers a crash inside ErrorBoundary so tests can
 * verify the fallback UI, retry/reload behaviour, and keyboard shortcuts.
 *
 * A "Reset" button resets the local `shouldThrow` flag so tests can check the
 * `onRetry` path without reloading the page.
 *
 * Keyboard-operable recovery flow:
 * - On failure, focus moves to the recovery (retry) action inside the fallback.
 * - On retry/dismiss, focus is restored to the trigger button that caused the
 *   failure so keyboard users can continue without a pointer.
 * - Status updates are announced through a single live region to avoid
 *   duplicated announcements.
 *
 * The page also renders the critical financial states used by visual
 * regression tests (wallet disconnected, stale quote, pending payout, failed
 * payout, degraded RPC). Volatile values are masked so screenshots are stable
 * across mobile and desktop viewport projects.
 */
export default function TestErrorBoundaryPage() {
  const [shouldThrow, setShouldThrow] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  const handleRetry = () => {
    setShouldThrow(false);
    setRetryCount((c) => c + 1);
  };

  // Move focus predictably: into the fallback recovery action on failure,
  // and back to the trigger on recovery.
  useEffect(() => {
    if (shouldThrow) {
      const retryButton = fallbackRef.current?.querySelector<HTMLElement>(
        '[data-testid="error-retry"], button',
      );
      retryButton?.focus();
    } else if (retryCount > 0) {
      triggerRef.current?.focus();
    }
  }, [shouldThrow, retryCount]);

  return (
    <main className="min-h-screen p-6 flex flex-col gap-4">
      <h1 className="text-lg font-semibold">ErrorBoundary Test Harness</h1>

      <div className="flex gap-3">
        <button
          ref={triggerRef}
          type="button"
          data-testid="trigger-error"
          onClick={() => setShouldThrow(true)}
          className="px-3 py-1 text-sm rounded border bg-red-50 border-red-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
        >
          Throw Error
        </button>
        <button
          type="button"
          data-testid="reset-error"
          onClick={() => setShouldThrow(false)}
          className="px-3 py-1 text-sm rounded border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Reset
        </button>
      </div>

      {/* Single live region for status updates to avoid duplicate announcements. */}
      <p
        role="status"
        aria-live="polite"
        data-testid="status-live-region"
        className="text-sm text-blue-700"
      >
        {shouldThrow
          ? 'Transaction failed. Recovery action available.'
          : retryCount > 0
            ? `Retry triggered ${retryCount} time${retryCount === 1 ? '' : 's'}.`
            : ''}
      </p>

      <div ref={fallbackRef}>
        <ErrorBoundary
          onRetry={handleRetry}
          retryLabel="Try Again"
          title="Something went wrong."
          message="Please refresh the page."
        >
          <BombChild shouldThrow={shouldThrow} />
        </ErrorBoundary>
      </div>

      <div
        data-testid="financial-states"
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {FINANCIAL_STATES.map((state) => (
          <FinancialStatePanel key={state} state={state} />
        ))}
      </div>
    </main>
  );
}
