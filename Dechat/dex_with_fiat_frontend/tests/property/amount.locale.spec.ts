import { test, expect } from '@playwright/test';

/**
 * Localization QA UI checks for financial edge cases (issue #296).
 *
 * Drives the `/test-locale-money` harness in a real browser and asserts it
 * surfaces no failures, plus per-case status. This is the full-browser variant
 * of the headless Vitest component check at
 * `src/lib/__tests__/localeMoneyHarness.test.tsx`; both assert the same
 * invariants from `src/lib/localeQaChecks.ts`.
 *
 * Runs under the `amount-property` Playwright project
 * (`testMatch: /amount.*\.(spec|test)\.ts$/`, `testDir: ./tests/property`):
 *   pnpm exec playwright test --project=amount-property
 *
 * The harness is a pure client-side page, so no wallet bridge or API stubs are
 * required — only the shared web server provisioned by playwright.config.ts.
 */

test.describe('Localization QA financial edge cases', () => {
  test('harness reports zero failures', async ({ page }) => {
    await page.goto('/test-locale-money');
    await page.waitForLoadState('domcontentloaded');

    // The aggregate failure block must not render when all checks pass.
    await expect(page.getByTestId('locale-failures')).toBeHidden();

    const summary = page.getByTestId('locale-summary');
    await expect(summary).toContainText(/0 failures/);
  });

  test('every fixture category renders passing cases', async ({ page }) => {
    await page.goto('/test-locale-money');
    await page.waitForLoadState('domcontentloaded');

    await expect(
      page.getByTestId('locale-case-invariance-token-1234.56'),
    ).toHaveAttribute('data-status', 'pass');
    await expect(
      page.getByTestId('locale-case-separator-en-grouped'),
    ).toHaveAttribute('data-status', 'pass');
    await expect(
      page.getByTestId('locale-case-noldigit-arabic-indic'),
    ).toHaveAttribute('data-status', 'pass');
    await expect(
      page.getByTestId('locale-case-longstring-fr-network-mismatch'),
    ).toHaveAttribute('data-status', 'pass');
    await expect(
      page.getByTestId('locale-case-currency-dollar'),
    ).toHaveAttribute('data-ambiguous', 'true');
    await expect(
      page.getByTestId('locale-case-fiat-jpy-whole'),
    ).toHaveAttribute('data-status', 'pass');
  });

  test('ambiguous symbols require clarification and unambiguous ones resolve', async ({ page }) => {
    await page.goto('/test-locale-money');
    await page.waitForLoadState('domcontentloaded');

    for (const id of ['dollar', 'yen', 'krone']) {
      await expect(
        page.getByTestId(`locale-case-currency-${id}`),
      ).toHaveAttribute('data-ambiguous', 'true');
    }
    for (const id of ['euro', 'naira', 'usdc', 'xlm']) {
      await expect(
        page.getByTestId(`locale-case-currency-${id}`),
      ).toHaveAttribute('data-ambiguous', 'false');
    }
  });

  test.describe('narrow layouts do not overflow horizontally', () => {
    for (const width of [280, 320, 360, 414]) {
      test(`body fits within ${width}px viewport`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/test-locale-money');
        await page.waitForLoadState('domcontentloaded');

        const fits = await page.evaluate(
          (w) => document.body.scrollWidth <= w,
          width,
        );
        expect(fits, `body scrolled wider than ${width}px`).toBe(true);
      });
    }
  });
});
