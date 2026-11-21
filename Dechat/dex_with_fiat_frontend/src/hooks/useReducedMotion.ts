import { useMediaQuery } from './useMediaQuery';

/**
 * Canonical hook for the user's reduced-motion preference (issue #295).
 *
 * Returns `true` when the OS/browser reports `prefers-reduced-motion: reduce`,
 * falling back to `false` during SSR (see {@link useMediaQuery}). Use this to
 * gate CSS-class animations (e.g. `animate-spin`/`animate-pulse`) and
 * `scroll-behavior: smooth` in transaction-status UI so motion is withheld for
 * vestibular-sensitive users while non-animated status cues (icon + text)
 * remain.
 *
 * For framer-motion animations, prefer framer-motion's own `useReducedMotion`
 * (this hook and that one observe the same media query and agree).
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
