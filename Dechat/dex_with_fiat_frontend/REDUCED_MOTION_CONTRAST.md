# Reduced-Motion & High-Contrast Support for Transaction Status UI (issue #295)

Respects `prefers-reduced-motion: reduce`, maintains non-animated status cues,
and validates WCAG 2.1 AA contrast across light, dark, and forced-colors (high-
contrast) modes in progress, warning, and failure states.

The change is scoped to the **display layer**. Financial arithmetic (BigInt
stroops, minor-unit conversion) is unchanged.

---

## What was added

| Path | Role |
| :--- | :--- |
| `src/hooks/useReducedMotion.ts` | Canonical hook wrapping `useMediaQuery('(prefers-reduced-motion: reduce)')`. Gate all CSS-class animations and scroll behaviour here. |
| `src/lib/statusContrast.ts` | WCAG 2.1 AA contrast token set for progress/success/warning/failure × light/dark/forced-colors, plus `computeContrastRatio`, `meetsAA`. |
| `src/components/TransactionStatusCue.tsx` | Reusable icon + text non-animated status cue. Strips `animate-spin` on `progress` when reduced-motion is set; sr-only text is always present. |
| `src/components/TransactionProgressBar.tsx` | Retrofitted: adds `TransactionStatusCue`, `role="status" aria-live="polite"` on the step description, dark-mode bar colors, and reduced-motion transition gating. |
| `src/components/WalletConnectionTimeline.tsx` | Gates the active-step `animate-pulse` dot behind `useReducedMotion`. |
| `src/components/TransactionAmountDisplay.tsx` | Imports and uses `useReducedMotion` from framer-motion; strips translate/scale from framer-motion transitions and switches `scrollIntoView` to `instant` when reduced-motion is set. |
| `src/app/globals.css` | Adds `@media (prefers-reduced-motion: reduce)` guard neutralising all custom `@keyframes`/`.animate-*` classes and Tailwind `animate-*` utilities. Extends `@media (forced-colors: active)` to cover status cue surfaces, progress bar fill, and status icons. |
| `src/lib/statusContrast.test.ts` | WCAG contrast validation — 23 tests, all headless. |
| `src/components/__tests__/TransactionStatusCue.test.tsx` | Cue component regression — icon, text, reduced-motion spin gating, sr-only label, inline variant. |
| `src/components/__tests__/TransactionProgressBar.test.tsx` | Progress bar regression — a11y attributes, live region, cue per step, reduced-motion, action buttons, clamping. |
| `src/hooks/__tests__/useReducedMotion.test.ts` | Hook unit tests — false/true/reactive update/cleanup. |
| `src/components/__tests__/WalletConnectionTimeline.test.tsx` | Reduced-motion regression for the active-step pulse dot. |
| `src/app/(e2e)/test-transaction-status/page.tsx` | Harness page exposing all steps + status kinds for the Playwright a11y spec. |
| `tests/a11y/transaction-status.spec.ts` | Full-browser a11y checks (Playwright `accessibility` project). |

---

## Three-channel status cues

Every status surface must convey state through **three independent channels**
so it is unambiguous for every user group:

| Channel | How it's delivered |
| :--- | :--- |
| **Icon / shape** | `TransactionStatusCue` renders a lucide icon (Loader2 / CheckCircle / AlertTriangle / XCircle) that does not change with color. |
| **Text label** | Visible `aria-hidden` span + sr-only duplicate; screen readers hear the label regardless of motion preference. |
| **Color** | CSS-var token classes (`text-green-700 dark:text-green-400`, etc.) verified at ≥ 4.5 : 1 contrast ratio. |

---

## Status color tokens — WCAG AA compliance notes

The CSS-var tokens in `globals.css` (`:root` → `[data-theme='dark']`) set
`--color-success: #16a34a` (green-600) and `--color-warning: #d97706`
(amber-600). Both fail WCAG AA (< 4.5 : 1) on a white background:

| Token | Contrast on white | WCAG AA |
| :--- | :--- | :--- |
| `--color-success` #16a34a | ~2.6 : 1 | ✗ fail |
| `--color-warning` #d97706 | ~2.6 : 1 | ✗ fail |
| `--color-danger` #dc2626 | ~4.5 : 1 | ✓ borderline |

`TransactionStatusCue` and `TransactionProgressBar` use adjusted values instead:

| State | Light foreground | Dark foreground | Contrast (light/dark) |
| :--- | :--- | :--- | :--- |
| progress | `text-blue-600` (#2563eb) | `dark:text-blue-400` (#60a5fa) | 5.2 / 5.6 : 1 ✓ |
| success | `text-green-700` (#15803d) | `dark:text-green-400` (#4ade80) | 5.0 / 10.9 : 1 ✓ |
| warning | `text-amber-800` (#92400e) | `dark:text-yellow-300` (#fbbf24) | 7.0 / 10.3 : 1 ✓ |
| failure | `text-red-800` (#991b1b) | `dark:text-red-400` (#f87171) | 7.0 / 5.5 : 1 ✓ |

The raw `--color-success` / `--color-warning` tokens are still used by
`theme-soft-*` background fills (they are soft, low-opacity fills, not
foreground text), so existing surfaces that rely on them are unaffected.

---

## Reduced-motion strategy

Three levels of motion are suppressed:

1. **CSS `@keyframes` classes** — the new `@media (prefers-reduced-motion: reduce)`
   block in `globals.css` strips every `.animate-*` class and sets
   `animation-duration: 0.01ms` on all `[class*="animate-"]` elements.
2. **Tailwind `animate-spin` / `animate-pulse` on status spinners** — gated in
   `TransactionStatusCue`, `WalletConnectionTimeline`, and
   `TransactionProgressBar` via `useReducedMotion`.
3. **framer-motion transitions** — `TransactionAmountDisplay` now reads
   `useReducedMotion()` from framer-motion and passes `y: 0` / `scale: 1` /
   `duration: 0.01` when reduced-motion is requested (opacity-only fade).
4. **Smooth scrolling** — `TransactionAmountDisplay` switches
   `scrollIntoView({ behavior: 'smooth' })` to `'instant'`; `globals.css` also
   sets `scroll-behavior: auto` on `html` and `.chat-container`.

Non-animated cues (icon shape, text label, color) are always present regardless
of motion preference; the tests assert the sr-only text is not removed under
`reducedMotion=true`.

---

## High-contrast (forced-colors) strategy

The `@media (forced-colors: active)` block in `globals.css` previously covered
only buttons. It now also covers:

- `[data-testid="transaction-status-cue"]` — adds `forced-color-adjust: none`
  and a `ButtonText` border so the badge outline is preserved.
- `[data-testid="transaction-progress-bar"]` — same.
- `theme-soft-*` surfaces — bordered with `ButtonText`.
- Progress bar fill — `background-color: Highlight` forces the fill to use the
  system highlight color, keeping it visible.
- Status icon SVGs — coloured with `ButtonText`.

---

## How to run

```bash
# Headless (gating — CI unit-tests job):
pnpm test:unit -- statusContrast TransactionStatusCue TransactionProgressBar useReducedMotion WalletConnectionTimeline

# Full-browser (Playwright accessibility project — needs the web server):
pnpm test:a11y   # = playwright test --project=a11y
```

---

## Pre-existing repo CI state (unchanged by this PR)

`src/lib/payout/providers/paystackProvider.ts` has a pre-existing syntax error
at line 54 that breaks `tsc --noEmit` (71 errors) and `next build`. Neither file
was touched by this change. All new files in this PR pass `tsc`, `eslint`, and
`prettier` individually.
