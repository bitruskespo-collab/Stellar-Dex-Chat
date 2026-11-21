# Locale & Timezone Boundaries

Issue #274 adds shared helpers for UTC-persisted instants and locale-aware numeric input.

## Rules

- **Persist UTC instants**: store timestamps as ISO-8601 UTC (`toPersistedUtcIso`) or epoch values; do not persist localized display strings.
- **Display explicitly**: `formatUtcInstant`/`formatProviderCutoff` accept `locale` and `timeZone` and render from the persisted instant.
- **DST/non-UTC safe**: tests cover US DST spring/fall boundaries and non-UTC zones (e.g., America/New_York, Asia/Kolkata).
- **Localized numeric input**: `parseLocalizedDecimalInput` and `parseAssetAmount(..., { locale })` accept comma-decimal input for display convenience but preserve canonical decimal/stroops for persistence.

## Tests

- `src/lib/timeDisplay.test.ts`
- `src/lib/exactAmount.test.ts` locale normalization case
