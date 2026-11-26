# Transaction locale contract (issue #292)

This document defines how transaction-critical text and numbers are localized.
It complements [locale-timezone-boundaries.md](./locale-timezone-boundaries.md)
and the financial QA fixture conventions in `LOCALE_QA_FIXTURES.md`.

## Boundary

- **Localized:** labels, messages, remediation text, grouping/decimal
  separators, and CLDR plural forms.
- **Never localized:** Soroban numeric codes, HTTP statuses, wallet string
  codes, API reason codes, status identifiers, token/currency codes, and
  canonical amounts in stroops or fiat minor units.

`src/lib/transactionLocale.ts` is display-only. It does not change
`exactAmount.ts`, `stroops.ts`, `payout/minorUnits.ts`, or any persisted value.
The formatter uses `numberingSystem: 'latn'` so displayed digits match the
ASCII-only money parser; Arabic text is localized but the digits stay ASCII.

## Resource layout

All shipped locales (`en`, `fr`, `es`, `ar`) define `transaction.*`:

- `transaction.queue.*` — withdrawal queue labels and plural templates
  (`depth_one`, `depth_other`, plus Arabic `zero`, `two`, `few`, `many`).
- `transaction.amount.*` — stored-amount label and invalid-data fallback.
- `transaction.recovery.*` — recovery panel labels and the legacy diagnostic
  code set (`1001`–`1008`, `USER_DECLINED`, `NETWORK_TIMEOUT`, `RATE_LIMITED`,
  `UNKNOWN_ERROR`).
- `transaction.errors.wallet.*` / `transaction.errors.api.*` — wallet and HTTP
  messages. These live in the transaction namespace so every locale has them.
- `transaction.errors.actions.*` — localized next steps. The values under
  `transaction.errors.recovery.*.action` are **machine IDs** from this map,
  never translated prose; translators only change `actions.*` values.
- `errors.<numeric-code>` — Soroban messages keyed by the contract code. The
  numeric key is machine-readable; only its value is translated. All 86 codes
  in `stellar-contracts/src/lib.rs` must have an entry, including the 1200-series
  cancellation codes and the newer oracle/migration codes.

Legacy recovery code `1001` means insufficient funds, while current Soroban
code `1001` means below the minimum deposit. They therefore use separate
namespaces; never merge them.

The `303`–`311` strings and safety metadata were realigned with the canonical
`stellar-contracts/src/lib.rs` enum (`303` is `ExceedsLimitMaxCap`, `304` is
`DailyLimitExceeded`, `306` is `ReferenceTooLong`, `307` is `CooldownActive`).
The previous legacy table was shifted by one and could mislabel retryability.

## API

`TranslationContext` exposes:

| Helper                          | Purpose                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `t(key, params?)`               | Resolve a dotted locale key and interpolate every `{param}`. Numeric params use the active locale's number rules. |
| `tp(key, count, params?)`       | Resolve `key_<cldrCategory>` (or `key.<cldrCategory>`), falling back to `other`, then the base key.               |
| `formatNumber(value, options?)` | Locale-aware display formatting for `number`, `bigint`, or canonical numeric strings.                             |

Pure equivalents in `src/lib/transactionLocale.ts` accept an explicit locale:
`resolveTransactionMessage`, `translateTransactionPlural`, `pluralCategory`,
and `formatTransactionNumber`.

`src/lib/localizedErrors.ts` exposes the code-first error API:

| Helper                                                   | Purpose                                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detectTransactionErrorCode(error, { httpStatus? })`     | Return a stable code from an explicit HTTP hint, structured/numeric contract code, wallet string code, or conservative keyword fallback. Arbitrary digit runs (amounts, ledgers, `HTTP 504`) are never treated as contract codes. |
| `classifyLocalizedError(error, { locale, ... })`         | Keep `code`, `fieldId`, and `safeValues`, derive category/retryability from the machine-code table, and replace message/action with locale resources. |
| `messageForTransactionCode` / `actionForTransactionCode` | Resolve Soroban, HTTP, and wallet string codes.                                                                                                     |
| `messageForDiagnosticCode` / `actionForDiagnosticCode`   | Resolve the legacy recovery code namespace.                                                                                                         |
| `localizeDiagnostics(diagnostics, locale)`               | Localize a recovery diagnostic without changing its code, correlation ID, category, retryability, timestamp, or sanitized trace.                    |

Unknown codes resolve to the localized generic message and a safe next step;
no raw diagnostic is interpolated into user-facing text.

**Intentional behavior change:** `classifyLocalizedError` treats codes absent
from the safety table as non-retryable. Previously an unrecognized error could
inherit `isRetryable: true` from keyword heuristics; blindly retrying an
unknown financial operation is unsafe. Existing `classifyError()` behavior is
unchanged for callers that still use it directly, except that an explicit
`HTTP <status>` in diagnostics is now classified as that HTTP status instead of
being mistaken for a same-number Soroban code.

`AccessibleError.code` is now set by `classifyError()` from the matched machine
code. `ErrorSummary` resolves text from that code first and only falls back to
caller-supplied text for errors without a code. `TransactionAmountDisplay`
uses `t`/`formatNumber` for stored fiat and validation fallbacks; its canonical
amount is never changed. `WithdrawalQueueStatus` renders localized templates
from machine values (state and contract version) and never displays raw RPC
diagnostics. `useWithdrawalQueueStatus` returns a stable `errorCode` plus a
localized, safe `errorMessage`; it classifies the machine diagnostic before
formatting text and no longer exposes raw RPC strings.

Components that may render without the provider (isolated unit tests, SSR
fallbacks) can use `useOptionalTranslation()`, which reads English resources
without mutating locale state.

## Contributor checklist

1. Add a stable machine code first; then add its message under `errors.<code>`
   or `transaction.errors.<group>.<code>` in **all four** locale files.
2. For counts, add every CLDR category the locale needs. English uses
   `one`/`other`; Arabic also uses `zero`, `two`, `few`, and `many`.
3. Keep codes, status values, `XLM`/`NGN`/`USD`/`USDC`, and typed safety
   phrases verbatim. Localize only the surrounding sentence.
4. Reuse `t`/`tp`/`formatNumber` instead of hard-coded `en-US` formatting or
   manual `s` suffixes.
5. Add focused tests for the normal path and at least one failure,
   authorization, or recovery case. Assert that the machine code is unchanged
   across locales.
6. Never add credentials, real secret keys, or user data to fixtures.

## Related tests

- `src/lib/transactionLocale.test.ts` — plural categories, separators, repeated
  placeholders, resource parity, bigint precision.
- `src/lib/localizedErrors.test.ts` — contract, HTTP, authorization, unknown,
  and recovery cases.
- `src/contexts/TranslationContext.test.tsx` — provider-level `t`, `tp`, and
  `formatNumber`.
- `src/hooks/__tests__/useWithdrawalQueueStatus.test.ts` — version mismatch and
  RPC failure codes with localized, non-raw messages.
- `src/components/__tests__/WithdrawalQueueStatus.test.tsx` — French and Arabic
  queue rendering, plus safe failure rendering.
- `src/components/__tests__/TransactionErrorRecovery.test.tsx` — localized
  recovery panel with unchanged machine metadata.
- `src/components/__tests__/ErrorSummary.localization.test.tsx` — message/action
  resolved from codes rather than legacy English text.
- `src/components/__tests__/TransactionAmountDisplay.localization.test.tsx` —
  locale-formatted stored fiat and validation fallback.
