# Localization QA Fixtures for Financial Edge Cases (issue #296)

Synthetic locale fixtures and automated UI checks for the financial edge cases
that localization can break: long translated strings, non-Latin digits, narrow
layouts, decimal/grouping separators, and currency-symbol ambiguity.

The change is intentionally scoped to the **display / parsing boundary**.
Canonical financial arithmetic — BigInt stroops for Stellar tokens and integer
minor units for fiat — is unchanged. The fixtures assert that locale
presentation maps back to identical canonical values, so transaction
arithmetic stays deterministic across locales.

## What was added

| Path | Role |
| :--- | :--- |
| `fixtures/locales/financial_edge_cases.json` | Versioned synthetic fixtures (the deliverable). No credentials or real user data. |
| `src/lib/localeFixtures.ts` | Typed loader + fixture types + currency-symbol ambiguity contract (`classifyCurrencySymbol`) + interpolation helper. |
| `src/lib/localeQaChecks.ts` | Pure, deterministic checks that run the fixtures against the real parsers. Shared by the harness and all tests. |
| `src/app/(e2e)/test-locale-money/page.tsx` | Harness page rendering every case; surfaces failures via `data-testid="locale-failures"`. |
| `src/lib/localeMoneyParser.test.ts` | Focused `parseLocaleMoney` regression suite (the parser previously had no unit tests). |
| `src/lib/financialLocaleFixtures.test.ts` | Fixture integrity + aggregate automated check + per-category checks + no-secrets scan. |
| `src/lib/__tests__/localeMoneyHarness.test.tsx` | Headless automated UI check (renders the harness in jsdom). |
| `tests/property/amount.locale.spec.ts` | Full-browser automated UI check (Playwright `amount-property` project). |
| `tests/property/README.md` | Contributor docs for the property project. |

## Fixture categories

`fixtures/locales/financial_edge_cases.json` (version 1) contains seven arrays:

1. **`canonicalInvariance`** — The same logical amount written in each locale's
   accepted separator form must resolve to byte-identical stroops. This is the
   financial-safety invariant. E.g. `1,234.56` (en-US), `1.234,56` (de-DE),
   `1234,56` (fr-FR), `1.234,56` (es-ES), and `1,234.56` (ja-JP) all resolve to
   `12345600000` stroops at 7 decimals.
2. **`separatorMatrix`** — Per-locale decimal/grouping separators with valid,
   boundary, and failure cases. Pinned behavior includes the en-US lone-comma
   heuristic (`1,234` → `1.234`) and the rejection of fr-FR space/apostrophe
   grouping, so intentional changes are surfaced by the tests.
3. **`nonLatinDigits`** — Arabic-Indic, Devanagari, and Persian digits are
   rejected because `parseLocaleMoney` is ASCII-only. UIs must normalize
   non-Latin digits to ASCII upstream; canonical arithmetic is untouched.
4. **`longTranslatedStrings`** — Long per-locale UI strings (≥ the declared
   `minLength`) that render in full and interpolate `{param}` placeholders,
   matching `TranslationContext.t()`.
5. **`narrowLayouts`** — Viewport widths (≤ 768px) with an overflow strategy
   (`truncate`/`wrap`); the Playwright spec asserts the page never scrolls
   wider than the viewport.
6. **`currencySymbolAmbiguity`** — `$`, `¥`, `kr` are ambiguous and must be
   withheld for clarification; `€`, `₦`, `USDC`, `XLM` resolve. Mirrors
   `scripts/benchmark.ts` `AMBIGUOUS_SYMBOLS`.
7. **`fiatPrecisionCases`** — Currency-exponent boundaries (JPY/KRW = 0, KWD/BHD
   = 3, NGN/USD = 2) and rejection of excess precision and scientific notation.

## How checks run

The checks in `src/lib/localeQaChecks.ts` are pure and shared, so every runner
asserts the same invariants:

```bash
# Headless, gating (CI `unit-tests` job):
pnpm test:unit -- localeMoneyParser financialLocaleFixtures localeMoneyHarness

# Full-browser (Playwright amount-property project; needs the web server):
pnpm exec playwright test --project=amount-property
```

## Financial-safety properties preserved

- Canonical stroops are computed with BigInt in `src/lib/exactAmount.ts` /
  `src/lib/stroops.ts`; fiat minor units in `src/lib/payout/minorUnits.ts`. This
  work does not modify them.
- `parseLocaleMoney` keeps a strict separation between the **localized display
  string** and the **canonical stroops**; the fixtures assert stroops
  equality, not display-string equality.
- No new production behavior is introduced for unsupported locales (de/fr/es
  comma-decimal detection, ASCII-only digits) — the fixtures pin existing
  behavior including its boundary cases.
- No credentials, secret keys, mnemonics, or real user data are included; a
  no-secrets scan is part of the fixture-integrity test.

## Conventions mirrored

- Versioned JSON envelope (`{ version, description, … }`) and static ES import
  in a colocated Vitest suite, matching `fixtures/events/golden_events.json` and
  `src/lib/indexerEvents.test.ts`.
- Harness route under `src/app/(e2e)/test-<feature>/page.tsx` surfacing failures
  via a `data-testid`, matching `test-bank-details/page.tsx`.
- Playwright spec under the pre-configured `amount-property` project
  (`testDir: ./tests/property`, `testMatch: /amount.*\.(spec|test)\.ts$/`).
