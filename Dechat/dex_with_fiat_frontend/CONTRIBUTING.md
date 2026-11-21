# Contributing

Thanks for helping improve the DEX with Fiat frontend. This guide covers local setup, the checks we run in CI, and how to keep our visual regression baselines healthy.

## Getting started

1. Install dependencies with your package manager of choice (the repo uses `pnpm`).
2. Copy `.env.example` to `.env.local` and fill in local-only values. Never commit real credentials or user data.
3. Start the dev server with `pnpm dev`.

## Checks before opening a PR

Run the applicable checks locally before pushing:

- `pnpm lint` — static analysis and style.
- `pnpm typecheck` — TypeScript contract checks.
- `pnpm test` — unit and integration tests.
- `pnpm test:e2e` — Playwright end-to-end and visual regression tests.

If a check is not applicable to your change, note why in the PR description.

## Visual regression tests

Critical financial states are covered by Playwright screenshot tests so that regressions in layout, copy, or state handling are caught before merge. The covered states are:

- Wallet disconnected
- Stale quote
- Pending payout
- Failed payout
- Degraded RPC

Each state is captured across both the **mobile** and **desktop** viewport projects defined in `playwright.config.ts`. Volatile data (timestamps, wallet addresses, token amounts, transaction IDs) is masked in the tests so screenshots stay stable across runs and machines.

### Running visual tests

```bash
pnpm test:e2e -- --project=mobile
pnpm test:e2e -- --project=desktop
```

To update snapshots locally after an intentional UI change:

```bash
pnpm test:e2e -- --update-snapshots
```

### Updating baselines intentionally

Baselines should only change when the UI change is intentional and reviewed. When updating snapshots:

1. Confirm the diff is expected and limited to the states your change affects.
2. Run the update command above for both `mobile` and `desktop` projects.
3. Review the regenerated images in the PR diff — call out the intentional change in the PR description.
4. Do **not** commit snapshots that contain real user data, credentials, or unmasked volatile values. If a new dynamic field appears, add it to the mask list in the test rather than accepting an unstable baseline.
5. Get reviewer sign-off on the baseline change before merging.

If a snapshot fails unexpectedly, treat it as a potential regression first — investigate before reaching for `--update-snapshots`.

## Commit and PR conventions

- Keep changes scoped to the issue you are solving.
- Write clear commit messages describing the behavior change.
- Include tests for new behavior, including failure and recovery paths where relevant.
- Update documentation when behavior, APIs, or operational procedures change.
