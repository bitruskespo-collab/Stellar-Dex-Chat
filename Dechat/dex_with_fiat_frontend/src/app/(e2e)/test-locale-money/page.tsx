'use client';

import { useMemo } from 'react';

import { financialEdgeCaseFixtures } from '@/lib/localeFixtures';
import { runAllLocaleChecks, type LocaleQaFailure } from '@/lib/localeQaChecks';

/**
 * Localization QA harness for financial edge cases (issue #296).
 *
 * Renders every synthetic locale fixture case in the DOM and runs the same
 * deterministic checks the Vitest suite asserts, surfacing any failure into a
 * `<pre data-testid="locale-failures">` block (mirroring the
 * `test-bank-details` amount-property harness). Each case also exposes a
 * stable `data-testid` so the `amount-property` Playwright project can assert
 * per-case status and the absence of aggregate failures.
 *
 * Financial safety is preserved by construction: this page only reads the
 * parsers; it never mutates the BigInt arithmetic layers.
 */
export default function TestLocaleMoneyPage() {
  const all = useMemo(() => runAllLocaleChecks(), []);

  const failedIds = useMemo(
    () => new Set(all.failures.map((f) => f.caseId)),
    [all],
  );

  const status = (id: string) => (failedIds.has(id) ? 'fail' : 'pass');

  return (
    <div
      data-testid="locale-money-harness"
      aria-label="Localization QA financial edge cases"
      style={{
        fontFamily: 'ui-monospace, monospace',
        padding: 16,
        maxWidth: 768,
      }}
    >
      <h1>Localization QA — Financial Edge Cases</h1>
      <p data-testid="locale-summary">
        {all.passed}/{all.total} checks passed ({all.failures.length} failures)
      </p>

      {all.failures.length > 0 && (
        <pre data-testid="locale-failures">
          {all.failures.map(renderFailure).join('\n')}
        </pre>
      )}

      <section aria-label="Cross-locale stroops invariance">
        <h2>Canonical invariance</h2>
        {financialEdgeCaseFixtures.canonicalInvariance.map((group) => (
          <div
            key={group.id}
            data-testid={`locale-case-invariance-${group.id}`}
            data-status={status(group.id)}
          >
            <strong>{group.canonicalDecimal}</strong> → {group.expectedStroops}{' '}
            stroops
            <ul>
              {Object.entries(group.localeInputs).map(([locale, input]) => (
                <li key={locale}>
                  {locale}: {input}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-label="Decimal and grouping separators">
        <h2>Separator matrix</h2>
        {financialEdgeCaseFixtures.separatorMatrix.map((spec) => (
          <div key={spec.locale}>
            <h3>
              {spec.label} ({spec.locale})
            </h3>
            <ul>
              {spec.samples.map((sample) => (
                <li
                  key={sample.id}
                  data-testid={`locale-case-separator-${sample.id}`}
                  data-status={status(sample.id)}
                >
                  {sample.id}: &quot;{sample.input}&quot; → valid=
                  {String(sample.expectedValid)}
                  {sample.expectedStroops
                    ? `, stroops=${sample.expectedStroops}`
                    : ''}
                  {sample.expectedError
                    ? `, error=${sample.expectedError}`
                    : ''}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section aria-label="Non-Latin digits">
        <h2>Non-Latin digits (rejected)</h2>
        <ul>
          {financialEdgeCaseFixtures.nonLatinDigits.map((entry) => (
            <li
              key={entry.id}
              data-testid={`locale-case-noldigit-${entry.id}`}
              data-status={status(entry.id)}
            >
              {entry.id} ({entry.locale}): &quot;{entry.input}&quot; → ascii
              &quot;{entry.asciiNormalized}&quot; ({entry.reason})
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Long translated strings">
        <h2>Long translated strings</h2>
        <ul>
          {financialEdgeCaseFixtures.longTranslatedStrings.map((entry) => (
            <li
              key={entry.id}
              data-testid={`locale-case-longstring-${entry.id}`}
              data-status={status(entry.id)}
              data-locale={entry.translationLocale}
            >
              <span data-testid={`locale-longstring-text-${entry.id}`}>
                {entry.text}
              </span>
              <br />
              <small>
                length={entry.text.length}, key={entry.key}
              </small>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Narrow layouts">
        <h2>Narrow layouts</h2>
        <ul>
          {financialEdgeCaseFixtures.narrowLayouts.map((entry) => (
            <li
              key={entry.id}
              data-testid={`locale-case-narrow-${entry.id}`}
              data-status={status(entry.id)}
              data-overflow-strategy={entry.overflowStrategy}
              data-viewport-width={entry.viewportWidth}
              data-canonical-amount={entry.amount}
            >
              {entry.component} @ {entry.viewportWidth}px:{' '}
              <span data-testid={`locale-narrow-formatted-${entry.id}`}>
                {entry.formattedAmount}
              </span>{' '}
              ({entry.overflowStrategy})
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Currency symbol ambiguity">
        <h2>Currency-symbol ambiguity</h2>
        <ul>
          {financialEdgeCaseFixtures.currencySymbolAmbiguity.map((entry) => (
            <li
              key={entry.id}
              data-testid={`locale-case-currency-${entry.id}`}
              data-status={status(entry.id)}
              data-ambiguous={String(entry.ambiguous)}
            >
              &quot;{entry.symbol}&quot; ambiguous={String(entry.ambiguous)}
              {entry.reason ? `, reason=${entry.reason}` : ''}
              {entry.resolvedCurrency
                ? `, resolves=${entry.resolvedCurrency}`
                : ''}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Fiat precision boundaries">
        <h2>Fiat precision boundaries</h2>
        <ul>
          {financialEdgeCaseFixtures.fiatPrecisionCases.map((entry) => (
            <li
              key={entry.id}
              data-testid={`locale-case-fiat-${entry.id}`}
              data-status={status(entry.id)}
            >
              {entry.currency} (exp {entry.exponent}): &quot;{entry.input}&quot;
              →{' '}
              {entry.expectedValid
                ? `minor=${entry.expectedMinorUnits}`
                : `error=${entry.expectedErrorCode}`}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function renderFailure(f: LocaleQaFailure): string {
  return `[${f.category}] ${f.caseId}: ${f.message}`;
}
