# Chat History & AI Intent Evaluation

This document describes how the chat layer interprets user messages, how
amounts are validated, and how locale-aware intent evaluation works without
affecting transaction arithmetic.

## Locale-aware intent evaluation (issue #108)

Language interpretation is deliberately separated from canonical parsing and
contract unit conversion. The pipeline is:

1. **Language interpretation** — detect the user's locale and extract the
   intent (e.g. "send", "swap") plus the raw amount/currency tokens as the
   user typed them. This stage is best-effort and never produces a final
   numeric value.
2. **Canonical parsing** — normalize the extracted tokens into a canonical
   decimal string using the declared locale rules below. This stage is
   deterministic and locale-driven.
3. **Contract unit conversion** — convert the canonical decimal into base
   units (e.g. wei) using the token's decimals. This stage is unchanged and
   remains the single source of truth for transaction arithmetic.

Because stages 2 and 3 are deterministic and independent of the language
model, adding new languages cannot change how amounts are computed.

## Supported locales

Each locale declares its decimal separator, grouping separator, and the
representative examples used by the offline evaluations.

| Locale | Decimal sep | Grouping sep | Example amount | Parsed canonical | Currency example |
| ------ | ----------- | ------------ | -------------- | ---------------- | ---------------- |
| `en-US` | `.` | `,` | `1,234.56` | `1234.56` | `$1,234.56` → USD |
| `en-GB` | `.` | `,` | `1,234.56` | `1234.56` | `£1,234.56` → GBP |
| `de-DE` | `,` | `.` | `1.234,56` | `1234.56` | `1.234,56 €` → EUR |
| `fr-FR` | `,` | narrow no-break space | `1 234,56` | `1234.56` | `1 234,56 €` → EUR |
| `es-ES` | `,` | `.` | `1.234,56` | `1234.56` | `1.234,56 €` → EUR |
| `ja-JP` | `.` | `,` | `1,234.56` | `1234.56` | `¥1,234` → JPY |

### Ambiguity examples

- `1.234` in `de-DE`/`es-ES` is a grouping form → `1234`.
- `1.234` in `en-US` is a decimal form → `1.234`.
- `1,234` in `en-US` is a grouping form → `1234`.
- `1,234` in `de-DE` is a decimal form → `1.234`.
- A bare `$` is ambiguous across USD/CAD/AUD and must be resolved by the
  declared locale or withheld for clarification.

## Edge cases

### Mixed-locale input

When the detected language and the amount formatting disagree (e.g. an
`en-US` sentence containing `1.234,56`), the parser does **not** guess. The
intent is withheld and the user is asked to confirm the amount.

### Ambiguous currency symbols

Symbols shared by multiple currencies (`$`, `¥`) are only resolved when the
locale unambiguously maps to a single currency. Otherwise the request is
withheld for clarification.

### Unsupported languages

If the detected locale is not in the supported table above, the intent is
withheld for clarification rather than falling back to a default locale.

## Provenance for AI-generated financial claims (issue #216)

Rate and fee figures that originate from the language model are never
presented as current facts on their own. Every such claim must carry
user-visible provenance so the user can judge how fresh and how reliable it
is.

### Rate and fee claims must cite their source

When the assistant surfaces a rate or fee, the response must include the
underlying quote/provider timestamp it was derived from, for example:

> 1 ETH ≈ 3,120.45 USD — quote from *ExampleSwap* at 2024-05-01T12:00:00Z.

A rate or fee claim without an attached quote/provider timestamp is treated
as unsupported and is not shown as a current fact (see the refusal path
below). The timestamp is rendered from the quote record, not from the model
output, so the model cannot fabricate freshness.

### Estimates are labelled as estimates

Values that are approximate, projected, or derived from a model estimate are
labelled explicitly as estimates rather than presented as current facts:

> Estimated network fee: ~0.00042 ETH (estimate, not a live quote).

Labels are applied by the presentation layer based on the claim kind, so an
estimate can never be rendered with the same styling as a live quote.

### Unsupported numeric values are declined

If the model produces a numeric rate or fee that cannot be tied to a quote or
provider record, the assistant declines to present it as a current fact. It
instead explains that it cannot confirm the value and points the user to the
live quote source. This mirrors the existing "withheld for clarification"
behavior used for ambiguous amounts: the safe path is to withhold rather than
guess.

### Diagnostics

Provenance diagnostics record only the claim kind (`rate`, `fee`), whether a
quote/provider timestamp was attached, and the coarse outcome (`cited`,
`estimate`, `declined`). They never include the raw model output or the
numeric value, consistent with the logging rules above.

## Diagnostics

Diagnostics and logs record only the locale, the resolved intent kind, and a
coarse outcome (`parsed`, `withheld`, `unsupported`). They never include the
raw user prompt or the extracted amount tokens, so sensitive input is not
persisted in logs.

## Validation

Offline evaluations run per locale against the representative examples in the
table. For every case the parsed value must either match the deterministic
canonical parsing result or be withheld for clarification; no evaluation may
produce a value that differs from canonical parsing.

Provenance evaluations additionally cover the normal path (a rate/fee claim
with a quote timestamp is cited), the estimate path (approximate values are
labelled), and the failure path (a numeric claim without a quote is declined
rather than shown as a current fact).
