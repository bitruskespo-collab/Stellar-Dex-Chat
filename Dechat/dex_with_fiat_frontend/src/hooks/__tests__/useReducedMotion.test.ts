import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from '../useReducedMotion';

/**
 * Tests for the canonical useReducedMotion hook (issue #295).
 *
 * Uses the same window.matchMedia mock strategy as other media-query tests in
 * this codebase: override the global mock on a per-test basis and trigger the
 * change listener to exercise the reactive update path.
 */

function makeMatchMedia(initialMatches: boolean) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  const mql = {
    matches: initialMatches,
    addEventListener: vi.fn(
      (_event: string, cb: (e: MediaQueryListEvent) => void) => {
        listeners.push(cb);
      },
    ),
    removeEventListener: vi.fn(
      (_event: string, cb: (e: MediaQueryListEvent) => void) => {
        const idx = listeners.indexOf(cb);
        if (idx !== -1) listeners.splice(idx, 1);
      },
    ),
    dispatchChange(newMatches: boolean) {
      mql.matches = newMatches;
      listeners.forEach((cb) =>
        cb({ matches: newMatches } as MediaQueryListEvent),
      );
    },
  };
  return mql;
}

describe('useReducedMotion', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it('returns false when prefers-reduced-motion does not match', () => {
    const mql = makeMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => mql),
    });

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it('returns true when prefers-reduced-motion: reduce matches', () => {
    const mql = makeMatchMedia(true);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => mql),
    });

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it('updates reactively when the media query fires a change event', async () => {
    const mql = makeMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => mql),
    });

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    await act(() => {
      mql.dispatchChange(true);
    });

    expect(result.current).toBe(true);
  });

  it('removes the event listener on unmount (no memory leak)', () => {
    const mql = makeMatchMedia(false);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn(() => mql),
    });

    const { unmount } = renderHook(() => useReducedMotion());
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);

    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
