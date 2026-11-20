import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import TestLocaleMoneyPage from '@/app/(e2e)/test-locale-money/page';

/**
 * Automated UI check for the localization QA harness (issue #296).
 *
 * This renders the real `/test-locale-money` harness page in jsdom and asserts
 * it surfaces no failures — the same assertion the `amount-property`
 * Playwright project makes in a real browser. Keeping a headless variant here
 * means the locale UI check runs in `pnpm test:unit` (a gating CI job)
 * independent of the E2E web server, while the Playwright spec remains the
 * full-browser variant.
 */
describe('TestLocaleMoneyPage harness', () => {
  it('mounts and reports every fixture case with zero failures', () => {
    render(<TestLocaleMoneyPage />);

    // The aggregate failure block must not render when all checks pass.
    expect(screen.queryByTestId('locale-failures')).toBeNull();

    const summary = screen.getByTestId('locale-summary');
    expect(summary.textContent).toContain('failures');
    expect(summary.textContent).toMatch(/0 failures/);
  });

  it('renders a pass status for a representative case in each category', () => {
    render(<TestLocaleMoneyPage />);

    // Cross-locale stroops invariance.
    const invariance = screen.getByTestId(
      'locale-case-invariance-token-1234.56',
    );
    expect(invariance.getAttribute('data-status')).toBe('pass');

    // Separator matrix (en-US grouped → 1234.56).
    const sep = screen.getByTestId('locale-case-separator-en-grouped');
    expect(sep.getAttribute('data-status')).toBe('pass');

    // Non-Latin digit rejection.
    const noldigit = screen.getByTestId('locale-case-noldigit-arabic-indic');
    expect(noldigit.getAttribute('data-status')).toBe('pass');

    // Long translated strings render in full.
    const longstring = screen.getByTestId(
      'locale-case-longstring-fr-network-mismatch',
    );
    expect(longstring.getAttribute('data-status')).toBe('pass');
    const longText = within(longstring).getByText(/dépôts/i);
    expect(longText.textContent?.length).toBeGreaterThan(40);

    // Narrow layouts expose an overflow strategy and canonical amount.
    const narrow = screen.getByTestId('locale-case-narrow-amount-320');
    expect(narrow.getAttribute('data-overflow-strategy')).toBe('truncate');
    expect(narrow.getAttribute('data-canonical-amount')).toBe('1000000');

    // Currency-symbol ambiguity.
    const dollar = screen.getByTestId('locale-case-currency-dollar');
    expect(dollar.getAttribute('data-ambiguous')).toBe('true');
    const euro = screen.getByTestId('locale-case-currency-euro');
    expect(euro.getAttribute('data-ambiguous')).toBe('false');

    // Fiat precision boundaries.
    const jpy = screen.getByTestId('locale-case-fiat-jpy-whole');
    expect(jpy.getAttribute('data-status')).toBe('pass');
  });
});
