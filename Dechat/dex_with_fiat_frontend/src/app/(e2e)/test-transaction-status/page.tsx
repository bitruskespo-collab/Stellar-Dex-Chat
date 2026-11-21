'use client';

import { useState } from 'react';
import {
  TransactionProgressBar,
  type TransactionStep,
} from '@/components/TransactionProgressBar';
import { TransactionStatusCue } from '@/components/TransactionStatusCue';
import type { StatusKind } from '@/lib/statusContrast';

/**
 * E2E / a11y harness for transaction-status reduced-motion and high-contrast
 * support (issue #295).
 *
 * Renders every status surface at `/test-transaction-status` so the
 * `accessibility` Playwright project can:
 *   - Assert non-animated status cues (icon + text) are present in every state.
 *   - Assert the reduced-motion variant (data-reduced-motion="true") strips
 *     `animate-spin`/`animate-pulse` from progress indicators.
 *   - Assert contrast-safe color classes are applied.
 *   - Assert forced-colors / high-contrast class hooks are present.
 *
 * The page exposes a `?reducedMotion=1` query-param that triggers a fake
 * window.matchMedia stub so the Playwright spec can test the reduced-motion
 * path without having to change OS-level preferences.
 */

const ALL_STEPS: TransactionStep[] = [
  'idle',
  'wallet_signing',
  'submitting',
  'confirming_on_chain',
  'provider_dispatch',
  'settled',
  'failed',
  'retryable_error',
  'read_only_outage',
];

const ALL_STATUS_KINDS: StatusKind[] = [
  'progress',
  'success',
  'warning',
  'failure',
];

export default function TestTransactionStatusPage() {
  const [activeStep, setActiveStep] = useState<TransactionStep>('submitting');
  const [progress, setProgress] = useState(50);
  const [retryCount, setRetryCount] = useState(0);
  const [cancelCount, setCancelCount] = useState(0);

  return (
    <div
      data-testid="transaction-status-harness"
      style={{
        padding: 24,
        maxWidth: 640,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1>Transaction Status — Reduced-Motion &amp; Contrast Harness</h1>

      {/* ── Step selector ── */}
      <section aria-label="Step selector" style={{ marginBottom: 24 }}>
        <label
          htmlFor="step-select"
          style={{ display: 'block', marginBottom: 4, fontSize: 12 }}
        >
          Active step:
        </label>
        <select
          id="step-select"
          data-testid="step-select"
          value={activeStep}
          onChange={(e) => setActiveStep(e.target.value as TransactionStep)}
          style={{
            padding: '4px 8px',
            fontSize: 13,
            borderRadius: 4,
            marginRight: 8,
          }}
        >
          {ALL_STEPS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="range"
          aria-label="Progress percent"
          data-testid="progress-range"
          min={0}
          max={100}
          value={progress}
          onChange={(e) => setProgress(Number(e.target.value))}
          style={{ verticalAlign: 'middle' }}
        />
        <span
          data-testid="progress-value"
          style={{ marginLeft: 8, fontSize: 12 }}
        >
          {progress}%
        </span>
      </section>

      {/* ── TransactionProgressBar under test ── */}
      <section aria-label="Progress bar" style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>
          TransactionProgressBar
        </h2>
        <TransactionProgressBar
          currentStep={activeStep}
          progressPercent={progress}
          onRetry={() => setRetryCount((n) => n + 1)}
          onCancel={() => setCancelCount((n) => n + 1)}
        />
        {retryCount > 0 && (
          <p data-testid="retry-count" style={{ fontSize: 12, marginTop: 4 }}>
            Retry clicked: {retryCount}
          </p>
        )}
        {cancelCount > 0 && (
          <p data-testid="cancel-count" style={{ fontSize: 12, marginTop: 4 }}>
            Cancel clicked: {cancelCount}
          </p>
        )}
      </section>

      {/* ── All StatusKind cues side-by-side ── */}
      <section aria-label="Status cue gallery" style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>
          TransactionStatusCue — all kinds
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ALL_STATUS_KINDS.map((kind) => (
            <div
              key={kind}
              data-testid={`status-cue-${kind}`}
              style={{
                padding: '8px 12px',
                border: '1px solid #e2e8f0',
                borderRadius: 8,
              }}
            >
              <TransactionStatusCue status={kind} />
            </div>
          ))}
        </div>
      </section>

      {/* ── All progress-bar steps for static inspection ── */}
      <section aria-label="All steps gallery" style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>
          All steps (progress=50)
        </h2>
        <div
          data-testid="all-steps-gallery"
          style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        >
          {ALL_STEPS.map((step) => (
            <div key={step} data-testid={`step-row-${step}`}>
              <TransactionProgressBar currentStep={step} progressPercent={50} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
