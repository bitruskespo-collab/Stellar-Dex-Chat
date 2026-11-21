# Synthetic Test Fixtures

This repository uses deterministic, privacy-safe synthetic fixtures for wallets, bank accounts, webhooks, and payouts.

## Rules

- **Deterministic**: fixture generators accept a seed and return stable output for the same seed.
- **Synthetic only**: no real user data, production credentials, live provider keys, or private keys.
- **Obvious markers**: synthetic records include `synthetic: true` and `syn_`/`000...` prefixes where practical.
- **Public identifiers only**: Stellar public addresses/contract IDs in fixtures are non-secret test identifiers.

## Frontend

Central generators live in `src/lib/fixtures/`:

- `seededRandom.ts` - seeded PRNG/helpers
- `synthetic.ts` - wallet/bank/webhook/payout fixtures
- `privacyGuard.ts` - runtime/text fixture safety checks

Run checks:

```bash
pnpm test:fixtures:privacy
pnpm test:unit
```

## Contract fixtures

Contract JSON fixtures under `Dechat/stellar-contracts/fixtures/` must remain synthetic/public-only. The frontend privacy guard scans committed fixture directories, and contract tests should avoid embedding secrets or production identifiers.
