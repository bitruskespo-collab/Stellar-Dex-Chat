import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  TransactionProgressBar,
  type TransactionStep,
} from '../TransactionProgressBar';

/**
 * Regression tests for TransactionProgressBar (issue #295 retrofit).
 *
 * Covers:
 *   - Every TransactionStep renders an accessible progressbar.
 *   - Each step has a non-animated status cue (icon + text, not color-only).
 *   - `role="status" aria-live="polite"` on the step description.
 *   - Reduced-motion strips the CSS transition class from the bar fill.
 *   - Retry / Cancel buttons in retryable_error and failed states.
 *   - Boundary: progressPercent clamped to [0, 100].
 */

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: vi.fn(() => false),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

describe('TransactionProgressBar — accessibility', () => {
  it('renders role="progressbar" with aria-valuenow/min/max', () => {
    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={40} />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toBeDefined();
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('step description is a polite live region', () => {
    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={40} />,
    );
    const liveRegion = document.querySelector(
      '[role="status"][aria-live="polite"]',
    );
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute('aria-atomic')).toBe('true');
  });

  it('renders a TransactionStatusCue (non-animated icon + text) for every step', () => {
    for (const step of ALL_STEPS) {
      const { unmount } = render(
        <TransactionProgressBar currentStep={step} progressPercent={50} />,
      );
      const cue = document.querySelector(
        '[data-testid="transaction-status-cue"]',
      );
      expect(cue, `no status cue for step "${step}"`).not.toBeNull();
      unmount();
    }
  });

  it('data-step attribute reflects currentStep', () => {
    render(
      <TransactionProgressBar currentStep="settled" progressPercent={100} />,
    );
    const bar = screen.getByTestId('transaction-progress-bar');
    expect(bar.getAttribute('data-step')).toBe('settled');
  });
});

describe('TransactionProgressBar — status-cue / icon coverage per step', () => {
  it('settled renders data-status="success" cue', () => {
    render(
      <TransactionProgressBar currentStep="settled" progressPercent={100} />,
    );
    const cue = document.querySelector(
      '[data-testid="transaction-status-cue"]',
    );
    expect(cue?.getAttribute('data-status')).toBe('success');
  });

  it('failed renders data-status="failure" cue', () => {
    render(
      <TransactionProgressBar currentStep="failed" progressPercent={80} />,
    );
    const cue = document.querySelector(
      '[data-testid="transaction-status-cue"]',
    );
    expect(cue?.getAttribute('data-status')).toBe('failure');
  });

  it('retryable_error renders data-status="warning" cue', () => {
    render(
      <TransactionProgressBar
        currentStep="retryable_error"
        progressPercent={60}
      />,
    );
    const cue = document.querySelector(
      '[data-testid="transaction-status-cue"]',
    );
    expect(cue?.getAttribute('data-status')).toBe('warning');
  });

  it('read_only_outage renders data-status="warning" cue', () => {
    render(
      <TransactionProgressBar
        currentStep="read_only_outage"
        progressPercent={70}
      />,
    );
    const cue = document.querySelector(
      '[data-testid="transaction-status-cue"]',
    );
    expect(cue?.getAttribute('data-status')).toBe('warning');
  });

  it('in-progress steps render data-status="progress" cue', () => {
    for (const step of [
      'idle',
      'wallet_signing',
      'submitting',
      'confirming_on_chain',
      'provider_dispatch',
    ] as TransactionStep[]) {
      const { unmount } = render(
        <TransactionProgressBar currentStep={step} progressPercent={25} />,
      );
      const cue = document.querySelector(
        '[data-testid="transaction-status-cue"]',
      );
      expect(cue?.getAttribute('data-status'), `step "${step}"`).toBe(
        'progress',
      );
      unmount();
    }
  });
});

describe('TransactionProgressBar — reduced-motion', () => {
  it('bar fill does NOT have transition class when reducedMotion=true', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={50} />,
    );
    // Find the fill element (the coloured inner div of the track)
    const fill = document.querySelector(
      '[data-testid="transaction-progress-bar"] .h-full',
    );
    expect(fill?.className).not.toContain('transition-all');
  });

  it('bar fill HAS transition class when reducedMotion=false', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(false);

    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={50} />,
    );
    const fill = document.querySelector(
      '[data-testid="transaction-progress-bar"] .h-full',
    );
    expect(fill?.className).toContain('transition-all');
  });

  it('status cue sr-only label is preserved under reducedMotion=true', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={50} />,
    );
    const srOnly = document.querySelector('.sr-only');
    expect(srOnly?.textContent?.length).toBeGreaterThan(0);
  });
});

describe('TransactionProgressBar — action buttons', () => {
  it('shows Retry and Cancel buttons in retryable_error state', () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(
      <TransactionProgressBar
        currentStep="retryable_error"
        progressPercent={60}
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDefined();
  });

  it('calls onRetry when Retry button clicked', () => {
    const onRetry = vi.fn();
    render(
      <TransactionProgressBar
        currentStep="retryable_error"
        progressPercent={60}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel button clicked', () => {
    const onCancel = vi.fn();
    render(
      <TransactionProgressBar
        currentStep="failed"
        progressPercent={80}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('no Retry/Cancel buttons in settled state', () => {
    render(
      <TransactionProgressBar
        currentStep="settled"
        progressPercent={100}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });
});

describe('TransactionProgressBar — progress clamping', () => {
  it('clamps negative progressPercent to 0', () => {
    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={-20} />,
    );
    const fill = document.querySelector('.h-full') as HTMLElement;
    expect(fill?.style.width).toBe('0%');
  });

  it('clamps progressPercent > 100 to 100%', () => {
    render(
      <TransactionProgressBar currentStep="submitting" progressPercent={120} />,
    );
    const fill = document.querySelector('.h-full') as HTMLElement;
    expect(fill?.style.width).toBe('100%');
  });

  it('renders custom errorMessage in the live region', () => {
    render(
      <TransactionProgressBar
        currentStep="failed"
        progressPercent={80}
        errorMessage="Contract simulation failed: overspend"
      />,
    );
    const liveRegion = document.querySelector('[role="status"]');
    expect(liveRegion?.textContent).toContain('Contract simulation failed');
  });
});
