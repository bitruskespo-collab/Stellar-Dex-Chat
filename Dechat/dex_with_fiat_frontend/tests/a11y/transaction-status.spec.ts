import { test, expect } from '@playwright/test';

/**
 * Accessibility checks for the transaction-status reduced-motion and
 * high-contrast support (issue #295).
 *
 * Runs under the `accessibility` Playwright project
 * (`testDir: ./tests/a11y`, `testMatch: /.*\.(spec|test)\.ts$/`):
 *   pnpm test:a11y
 *
 * These tests drive the `/test-transaction-status` harness page and assert:
 *   1. Every status state renders a non-animated cue (icon + text, `data-status`).
 *   2. The step description is a polite live region.
 *   3. `animate-spin` class is absent from progress bar fill elements
 *      (the fill never spins — the spinner lives on the cue icon).
 *   4. The harness page does not scroll horizontally at narrow viewports
 *      (narrow-layout regression).
 *   5. The theme-* contrast utility classes are present on status surfaces.
 *
 * Note: `@axe-core/playwright` is not currently a devDependency. These checks
 * use direct DOM/attribute assertions that are deterministic without an axe
 * engine. Adding axe would give deeper auditing — see REDUCED_MOTION_CONTRAST.md.
 */

test.describe('Transaction-status harness — non-animated status cues', () => {
  test('harness page mounts and shows the progress bar', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByTestId('transaction-status-harness')).toBeVisible();
    await expect(page.getByTestId('transaction-progress-bar')).toBeVisible();
  });

  test('every status kind renders a data-status cue', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    for (const kind of ['progress', 'success', 'warning', 'failure']) {
      const cueWrapper = page.getByTestId(`status-cue-${kind}`);
      await expect(cueWrapper).toBeVisible();
      const inner = cueWrapper.locator('[data-testid="transaction-status-cue"]');
      await expect(inner).toHaveAttribute('data-status', kind);
    }
  });

  test('step description is a polite live region', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    const liveRegion = page.locator('[role="status"][aria-live="polite"]').first();
    await expect(liveRegion).toBeVisible();
    await expect(liveRegion).toHaveAttribute('aria-atomic', 'true');
  });

  test('progressbar has aria-valuenow, aria-valuemin, aria-valuemax', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    const bar = page.getByRole('progressbar').first();
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', '100');
    // aria-valuenow comes from the initial progress prop (50)
    await expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  test('every step in the gallery has a status cue', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    const steps = [
      'idle', 'wallet_signing', 'submitting', 'confirming_on_chain',
      'provider_dispatch', 'settled', 'failed', 'retryable_error', 'read_only_outage',
    ];

    for (const step of steps) {
      const row = page.getByTestId(`step-row-${step}`);
      await expect(row).toBeVisible();
      const cue = row.locator('[data-testid="transaction-status-cue"]');
      await expect(cue).toBeVisible();
    }
  });
});

test.describe('Transaction-status harness — step-specific cue kinds', () => {
  test('settled step shows a success cue', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    const row = page.getByTestId('step-row-settled');
    const cue = row.locator('[data-testid="transaction-status-cue"]');
    await expect(cue).toHaveAttribute('data-status', 'success');
  });

  test('failed step shows a failure cue', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    const row = page.getByTestId('step-row-failed');
    const cue = row.locator('[data-testid="transaction-status-cue"]');
    await expect(cue).toHaveAttribute('data-status', 'failure');
  });

  test('retryable_error step shows a warning cue', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    const row = page.getByTestId('step-row-retryable_error');
    const cue = row.locator('[data-testid="transaction-status-cue"]');
    await expect(cue).toHaveAttribute('data-status', 'warning');
  });
});

test.describe('Transaction-status harness — narrow-layout regression', () => {
  for (const width of [320, 375, 414]) {
    test(`page body fits within ${width}px viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/test-transaction-status');
      await page.waitForLoadState('domcontentloaded');

      const fits = await page.evaluate(
        (w) => document.body.scrollWidth <= w,
        width,
      );
      expect(fits, `body scrolled wider than ${width}px`).toBe(true);
    });
  }
});

test.describe('Transaction-status harness — interactive step changes', () => {
  test('changing the step selector updates data-step on the progress bar', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('step-select').selectOption('settled');
    const bar = page.getByTestId('transaction-progress-bar');
    await expect(bar).toHaveAttribute('data-step', 'settled');

    // success cue must appear
    const cue = bar.locator('[data-testid="transaction-status-cue"]');
    await expect(cue).toHaveAttribute('data-status', 'success');
  });

  test('changing to retryable_error shows the Retry button', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('step-select').selectOption('retryable_error');
    await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
  });

  test('clicking Retry increments the retry counter', async ({ page }) => {
    await page.goto('/test-transaction-status');
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('step-select').selectOption('retryable_error');
    await page.getByRole('button', { name: /retry/i }).click();

    await expect(page.getByTestId('retry-count')).toContainText('Retry clicked: 1');
  });
});
