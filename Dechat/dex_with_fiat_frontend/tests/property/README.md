# Property Tests (`amount-property` Playwright project)

Deterministic, fixture-driven UI checks that assert financial invariants in a
real browser. This directory is the `testDir` for the `amount-property`
Playwright project configured in `playwright.config.ts`
(`testMatch: /amount.*\.(spec|test)\.ts$/`).

## Locale QA — financial edge cases (`amount.locale.spec.ts`)

Drives the `/test-locale-money` harness
(`src/app/(e2e)/test-locale-money/page.tsx`) and asserts it surfaces no
failures. The harness renders every synthetic locale fixture case and runs the
same checks the Vitest suite asserts, so the browser variant and the headless
variant agree.

### Fixture

`fixtures/locales/financial_edge_cases.json` — synthetic data only (no
credentials or real user data). Categories:

| Category | Covers |
| :--- | :--- |
| `canonicalInvariance` | The same amount in each locale's separator form resolves to **identical** BigInt stroops (financial-safety invariant). |
| `separatorMatrix` | Decimal/grouping separators across `en-US`, `de-DE`, `fr-FR`, `es-ES`, `ja-JP`, incl. valid, boundary, and failure cases. |
| `nonLatinDigits` | Arabic-Indic / Devanagari / Persian digits are rejected (ASCII-only parsing boundary). |
| `longTranslatedStrings` | Long per-locale UI strings render in full and interpolate `{param}` placeholders. |
| `narrowLayouts` | Viewport widths + overflow strategy; the spec asserts the page does not scroll wider than the viewport. |
| `currencySymbolAmbiguity` | `$`, `¥`, `kr` are withheld for clarification; unambiguous symbols resolve. |
| `fiatPrecisionCases` | Currency-exponent boundaries (JPY=0, KWD=3, NGN=2) and rejection of excess precision / scientific notation. |

### Run

```bash
# Requires the shared Playwright web server (next dev). The amount-property
# project shares the top-level globalSetup; if E2E infra is being provisioned
# elsewhere, this runs as part of it.
pnpm exec playwright test --project=amount-property
```

### Relationship to the headless check

`src/lib/__tests__/localeMoneyHarness.test.tsx` renders the same harness in
jsdom and runs in `pnpm test:unit` (a gating CI job), so the locale UI check is
enforced independent of the E2E web server. This Playwright spec is the
full-browser variant, adding real-viewport overflow assertions.
