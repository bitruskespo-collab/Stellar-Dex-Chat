# Contributing

Thanks for your interest in contributing to this project. This document describes how to set up your environment, run the repository's validation checks, and execute the focused regression suites that guard our contract, API, and frontend behavior.

## Prerequisites

Before running any validation command, make sure the following tools are installed and available on your `PATH`:

- **Node.js** (LTS) and **npm** — used for the frontend, API contract tests, and cross-browser smoke suite.
- **Rust** and **Cargo** — used to build and test the smart contracts.
- **`wasm32-unknown-unknown` target** — install with `rustup target add wasm32-unknown-unknown`.
- **Playwright browsers** — install with `npx playwright install` (Chromium, Firefox, and WebKit are all required for the cross-browser smoke suite).
- **`cargo` tooling for Wasm size checks** — the contract validation stage reports Wasm size against documented thresholds.

Install JavaScript dependencies from the repository root before running any frontend or API checks:

```sh
npm ci
```

## Single validation command

All repository checks are driven from the root through a single validation command with scoped modes. The command runs each stage in order and **returns a nonzero exit code if any prerequisite is missing or any stage fails**. It never reports success when a stage was skipped due to a missing tool.

```sh
npm run validate -- <mode>
```

### Modes

| Mode | What it runs |
| --- | --- |
| `frontend` | Frontend lint, type checks, unit tests, and the API consumer contract tests. |
| `contracts` | Contract build, contract unit/regression tests, and the worst-case resource regression suite (CPU, memory, and Wasm size thresholds). |
| `full` | Everything in `frontend` and `contracts`, plus the cross-browser wallet and transaction UX smoke suite. |

Examples:

```sh
npm run validate -- frontend
npm run validate -- contracts
npm run validate -- full
```

### Exit behavior

- **Exit `0`** — every stage in the selected mode completed successfully and all documented thresholds were met.
- **Nonzero exit** — a prerequisite is missing, a stage failed, or a threshold was exceeded. The failing stage is printed to the console so you can reproduce it directly.

Run `full` before opening a pull request. If you are only touching one area, the scoped modes (`frontend` or `contracts`) are faster and are the same checks CI runs for that area.

## Contract resource regression tests

The `contracts` mode includes a regression suite that benchmarks each public contract entry point against the maximum supported queue size, signer count, and batch size. The suite fails when CPU instructions, memory, or compiled Wasm size exceed the documented thresholds. If you change contract logic, run this suite and confirm the thresholds still hold; if a threshold must change intentionally, update the documented values and call out the change explicitly in your pull request.

## API consumer contract tests

The `frontend` mode includes API consumer contract tests that validate route responses, error shapes, and status codes against the versioned OpenAPI schema. These tests cover malformed inputs and provider failures so that undocumented response drift is caught before merge. When you change an API route or its response shape, update the published schema and the corresponding tests together.

To run only the API contract tests locally:

```sh
npm run test:api-contract
```

## Cross-browser wallet and transaction UX smoke suite

The `full` mode runs a focused Playwright suite across **Chromium, Firefox, and WebKit**. It covers wallet connection, signature rejection, pending transaction recovery, and payout status. Browser-specific wallet mocks are isolated per browser project so a mock for one engine cannot mask a failure in another.

To run the smoke suite locally:

```sh
npx playwright install
npm run test:e2e:smoke
```

To run a single browser while iterating:

```sh
npm run test:e2e:smoke -- --project=chromium
npm run test:e2e:smoke -- --project=firefox
npm run test:e2e:smoke -- --project=webkit
```

## Fixtures and credentials

Do not add credentials, secrets, or real user data to fixtures. Use synthetic, deterministic test data only. Wallet mocks must not reference real accounts or keys.

## Submitting changes

1. Run `npm run validate -- full` and confirm it exits `0`.
2. Update related API, operational, and contributor documentation when your change affects it.
3. Describe any intentional compatibility or behavior change explicitly in your pull request, including any threshold adjustments in the contract resource suite.