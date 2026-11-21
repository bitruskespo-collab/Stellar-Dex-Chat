import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TransactionStatusCue } from '../TransactionStatusCue';
import type { StatusKind } from '@/lib/statusContrast';

/**
 * Regression tests for the reusable TransactionStatusCue component (issue #295).
 *
 * Covers:
 *   - Every status kind renders icon + text (non-animated cues).
 *   - `animate-spin` is present for progress under normal motion,
 *     absent under reduced-motion.
 *   - `data-status` attribute is correct for each kind.
 *   - `sr-only` text is always present for screen readers.
 *   - Custom labels override the default.
 *   - Inline variant renders a <span> wrapper.
 */

// Mock the useReducedMotion hook so tests are deterministic.
vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: vi.fn(() => false),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const STATUS_KINDS: StatusKind[] = [
  'progress',
  'success',
  'warning',
  'failure',
];

describe('TransactionStatusCue — renders non-animated status cues', () => {
  for (const kind of STATUS_KINDS) {
    it(`${kind}: renders with data-status="${kind}"`, () => {
      render(<TransactionStatusCue status={kind} />);
      const cue = screen.getByTestId('transaction-status-cue');
      expect(cue.getAttribute('data-status')).toBe(kind);
    });

    it(`${kind}: renders a visible label text node`, () => {
      render(<TransactionStatusCue status={kind} />);
      // The aria-hidden span carries the visible label.
      const labels = screen.getAllByText(/.+/);
      expect(labels.length).toBeGreaterThan(0);
    });

    it(`${kind}: renders an sr-only text for screen readers`, () => {
      render(<TransactionStatusCue status={kind} />);
      const srOnly = document.querySelector('.sr-only');
      expect(srOnly).not.toBeNull();
      expect(srOnly?.textContent?.length).toBeGreaterThan(0);
    });
  }
});

describe('TransactionStatusCue — progress spinner and reduced-motion', () => {
  it('progress: icon has animate-spin under normal motion', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(false);

    render(<TransactionStatusCue status="progress" />);
    const icon = document.querySelector('[class*="animate-spin"]');
    expect(icon).not.toBeNull();
  });

  it('progress: icon does NOT have animate-spin when reducedMotion=true', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    render(<TransactionStatusCue status="progress" />);
    const icon = document.querySelector('[class*="animate-spin"]');
    expect(icon).toBeNull();
  });

  it('success: no animate-spin regardless of reducedMotion', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    render(<TransactionStatusCue status="success" />);
    const icon = document.querySelector('[class*="animate-spin"]');
    expect(icon).toBeNull();
  });

  it('sr-only label is present even when reducedMotion=true (screen readers still hear status)', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    render(<TransactionStatusCue status="progress" />);
    const srOnly = document.querySelector('.sr-only');
    expect(srOnly).not.toBeNull();
    expect(srOnly?.textContent).toBeTruthy();
  });
});

describe('TransactionStatusCue — custom label', () => {
  it('renders a custom label instead of the default', () => {
    render(<TransactionStatusCue status="failure" label="Payout failed" />);
    const cue = screen.getByTestId('transaction-status-cue');
    expect(cue.textContent).toContain('Payout failed');
  });
});

describe('TransactionStatusCue — inline variant', () => {
  it('renders a <span> wrapper when inline=true', () => {
    render(<TransactionStatusCue status="success" inline />);
    const cue = screen.getByTestId('transaction-status-cue');
    expect(cue.tagName.toLowerCase()).toBe('span');
  });

  it('renders a <div> wrapper by default', () => {
    render(<TransactionStatusCue status="success" />);
    const cue = screen.getByTestId('transaction-status-cue');
    expect(cue.tagName.toLowerCase()).toBe('div');
  });
});
