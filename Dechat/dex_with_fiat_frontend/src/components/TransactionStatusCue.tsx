'use client';

import React from 'react';
import { CheckCircle, AlertTriangle, XCircle, Loader2 } from 'lucide-react';
import { type StatusKind } from '@/lib/statusContrast';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * Reusable icon + label status cue for transaction-status UI (issue #295).
 *
 * Conveys status through **three independent channels** so every user group
 * can read it regardless of modality:
 *   1. Icon (shape/symbol — not color-dependent)
 *   2. Text label (accessible to screen readers via `aria-label` on the icon)
 *   3. Color (uses CSS-var tokens from `globals.css` for light/dark/high-contrast)
 *
 * When `prefers-reduced-motion: reduce` is active the spinner animation is
 * removed from the in-progress cue; the icon and label still identify the
 * status unambiguously.
 *
 * In forced-colors mode the component adds a `data-status` attribute and a
 * semantic CSS class so the `@media (forced-colors: active)` block in
 * `globals.css` can apply `forced-color-adjust: none` and `ButtonText`/
 * `Highlight` borders.
 */

export type { StatusKind };

export interface TransactionStatusCueProps {
  /** The status to display. */
  status: StatusKind;
  /**
   * Override the default label for screen-reader copy. Leave unset to use the
   * built-in canonical label from STATUS_TOKENS.
   */
  label?: string;
  /** Additional Tailwind / CSS classes applied to the outer wrapper. */
  className?: string;
  /**
   * When `true` the component renders an inline span rather than a flex div.
   * Useful inside a paragraph or button label.
   */
  inline?: boolean;
}

const ICON_MAP: Record<StatusKind, React.ElementType> = {
  progress: Loader2,
  success: CheckCircle,
  warning: AlertTriangle,
  failure: XCircle,
};

/** Human-readable labels (duplicated from statusContrast.ts for tree-shaking). */
const DEFAULT_LABELS: Record<StatusKind, string> = {
  progress: 'In progress',
  success: 'Completed',
  warning: 'Warning',
  failure: 'Failed',
};

/**
 * Tailwind utility classes for each status in light and dark mode, using the
 * CSS-var tokens. These classes compose with `theme-soft-*` backgrounds.
 *
 * We use the adjusted contrast-safe foreground values documented in
 * statusContrast.ts rather than the raw `--color-success` etc. tokens, because
 * the green/amber token values fail AA at their raw levels on white.
 */
const STATUS_COLOR_CLASSES: Record<StatusKind, string> = {
  // text-blue-600 / dark:text-blue-400  (--color-primary family)
  progress: 'text-blue-600 dark:text-blue-400',
  // text-green-700 / dark:text-green-400  (contrast-safe, see statusContrast.ts)
  success: 'text-green-700 dark:text-green-400',
  // text-amber-800 / dark:text-yellow-300  (contrast-safe amber-800 ≥ 7:1 on white)
  warning: 'text-amber-800 dark:text-yellow-300',
  // text-red-800 / dark:text-red-400  (contrast-safe red-800 ≥ 7:1 on white)
  failure: 'text-red-800 dark:text-red-400',
};

export function TransactionStatusCue({
  status,
  label,
  className = '',
  inline = false,
}: TransactionStatusCueProps) {
  const reducedMotion = useReducedMotion();
  const Icon = ICON_MAP[status];
  const resolvedLabel = label ?? DEFAULT_LABELS[status];
  const colorClass = STATUS_COLOR_CLASSES[status];

  // The spin animation only applies to the in-progress spinner; it is stripped
  // when prefers-reduced-motion: reduce is set. The icon and label remain.
  const spinClass =
    status === 'progress' && !reducedMotion ? ' animate-spin' : '';

  const content = (
    <>
      <Icon
        className={`inline-block h-4 w-4 flex-shrink-0${spinClass}`}
        aria-hidden="true"
      />
      <span
        // sr-only text is always present regardless of reducedMotion so that
        // screen readers announce the status even when animation is suppressed.
        className="sr-only"
      >
        {resolvedLabel}
      </span>
      <span aria-hidden="true" className="text-xs font-medium leading-none">
        {resolvedLabel}
      </span>
    </>
  );

  if (inline) {
    return (
      <span
        data-testid="transaction-status-cue"
        data-status={status}
        className={`inline-flex items-center gap-1.5 ${colorClass} ${className}`}
      >
        {content}
      </span>
    );
  }

  return (
    <div
      data-testid="transaction-status-cue"
      data-status={status}
      className={`flex items-center gap-1.5 ${colorClass} ${className}`}
    >
      {content}
    </div>
  );
}
