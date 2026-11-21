import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import WalletConnectionTimeline from '../WalletConnectionTimeline';

/**
 * Reduced-motion regression tests for WalletConnectionTimeline (issue #295).
 *
 * Existing tests for the component live here alongside the new motion tests.
 * The component's active-step dot uses `animate-pulse`; it must be stripped
 * when prefers-reduced-motion: reduce is set, while the dot itself (the
 * non-animated status cue) must remain visible.
 */

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: vi.fn(() => false),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderTimeline(
  overrides: Partial<
    React.ComponentProps<typeof WalletConnectionTimeline>
  > = {},
) {
  return render(
    <WalletConnectionTimeline
      isConnected={false}
      isNetworkMismatch={false}
      isConnecting={true}
      {...overrides}
    />,
  );
}

describe('WalletConnectionTimeline — reduced-motion', () => {
  it('active dot has animate-pulse when reducedMotion=false', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(false);

    renderTimeline();
    const pulseDot = document.querySelector('.animate-pulse');
    expect(pulseDot).not.toBeNull();
  });

  it('active dot does NOT have animate-pulse when reducedMotion=true', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    renderTimeline();
    const pulseDot = document.querySelector('.animate-pulse');
    expect(pulseDot).toBeNull();
  });

  it('the status dot is still present under reducedMotion=true (non-animated cue)', async () => {
    const { useReducedMotion } = await import('@/hooks/useReducedMotion');
    vi.mocked(useReducedMotion).mockReturnValue(true);

    renderTimeline();
    // The dot is the rounded-full span; it should still be in the DOM.
    const dot = document.querySelector('.rounded-full');
    expect(dot).not.toBeNull();
  });
});

describe('WalletConnectionTimeline — mid-transfer disconnect (normal path)', () => {
  it('shows error alert when wallet disconnects mid-transfer', () => {
    renderTimeline({ transferInProgress: true, isConnected: false });
    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('Wallet disconnected mid-transfer');
  });

  it('shows Retry button when network mismatch and onRetry provided', () => {
    const onRetry = vi.fn();
    const { container } = renderTimeline({ isNetworkMismatch: true, onRetry });
    const retryBtn = container.querySelector('button');
    expect(retryBtn).not.toBeNull();
  });
});
