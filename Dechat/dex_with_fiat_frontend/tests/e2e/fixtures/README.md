# Deterministic full-stack fixture

> Issue #268: Create a deterministic full-stack fixture with seeded ledger history.

This directory provides a **disposable local test environment** with
reproducible contract state, ledger events, payout-provider responses, and
wallet identities.  The entire fixture is derived from a single string seed,
so any integration failure can be reproduced exactly by passing the same seed.

---

## Quick start

```ts
// In a Playwright spec or Vitest unit test:
import { defaultFixture } from './fixtures/generator';

const admin = defaultFixture.wallets.find(w => w.role === 'admin')!;
const events = defaultFixture.events;
const rpcMock = defaultFixture.rpc;
const paystackEnvelope = defaultFixture.provider.paystackEnvelopes.resolveAccount;
```

To generate a fixture from a **custom seed** (e.g. for a specific failure scenario):

```ts
import { generateFixture } from './fixtures/generator';

const f = generateFixture('my-failure-scenario');
// f is byte-identical to any other call with 'my-failure-scenario'
```

---

## Files

| File | Purpose |
|------|---------|
| `schema.ts` | TypeScript types for every field in `FullStackFixture`. |
| `seed.ts` | Seed/PRNG primitives: `SeededRandom`, `sha256Hex`, `hexString`, etc. |
| `generator.ts` | `generateFixture(seed)` and the pre-built `defaultFixture`. |
| `global-setup.ts` | Playwright global setup: generates the fixture, optionally starts the payout stub. |
| `global-teardown.ts` | Playwright global teardown: stops the stub, removes the temp fixture file. |
| `README.md` | This file. |

---

## What's in the fixture

### `wallets` — deterministic Stellar identities

Five wallets with valid-format `G…` Stellar addresses derived from the seed.
No secret keys are generated or stored.

| Index | Role | Label |
|-------|------|-------|
| 0 | admin | Admin |
| 1 | operator | Operator |
| 2–4 | user | User A, User B, User C |

### `ledgerHistory` — seeded on-chain event stream

Eighteen ledgers spanning sequences 1 000 – 1 170.  Every ledger carries
deterministic `closedAt` timestamps, `txHashes`, and `events`.

The sequence covers all event families present in the existing
`golden_events.json` catalog, plus the following boundary/edge cases:

- **Cancelled withdrawal** (ledger 1070): admin cancels a pending queue item.
- **Expired withdrawal** (ledger 1090): a request outlasts its timelock.
- **Fee accrual then admin fee-withdrawal** (ledgers 1010–1100).
- **Full refund** (ledger 1110): entire deposit amount returned.
- **Pause / unpause cycle** (ledgers 1120–1130).
- **Circuit breaker tripped** (ledger 1150): deposit pushes total above threshold.
- **Upgrade proposed → executed** (ledgers 1140–1150).
- **Open pending withdrawal at tip** (ledger 1170): wqDepth > 0 at the end.

### `contractState` — snapshot derived by replaying the ledger history

```ts
contractState.admin            // admin wallet address
contractState.totalDeposited   // per-token stroops (string map)
contractState.totalWithdrawn
contractState.netDeposited
contractState.balance
contractState.accruedFees
contractState.withdrawalQueue  // all queue items with final status
contractState.wqDepth          // pending items only
contractState.wqOldestQueuedLedger
contractState.wqOldestAgeLedgers
contractState.currentLedger    // 1170
```

The state satisfies the documented accounting invariants:

```
totalDeposited >= totalWithdrawn
netDeposited   = totalDeposited − totalWithdrawn
balance        >= netDeposited
```

### `provider` — deterministic payout-provider responses

#### Normal-path accounts (match `FakePayoutProvider` defaults)

| accountNumber | bankCode | accountName |
|---------------|----------|-------------|
| `0123456789` | `058` (GTBank) | John Doe |
| `0987654321` | `011` (First Bank) | Jane Smith |

#### `paystackEnvelopes` — raw axios-layer responses

```ts
// Use these when mocking axios directly (matches providerContract.test.ts convention):
mockedAxios.get.mockResolvedValue({ data: fixture.provider.paystackEnvelopes.resolveAccount });
mockedAxios.post.mockResolvedValue({ data: fixture.provider.paystackEnvelopes.initiateTransfer });
```

#### `appRouteResponses` — what `/api/*` routes return to the browser

```ts
// Use these when calling route handlers in tests:
mockVerifyAccount.mockResolvedValue(fixture.provider.appRouteResponses.verifyAccount.data);
```

#### `failures` — six failure / edge-case scenarios

```ts
const { invalidAccount, accountNotFound, rateLimited,
        insufficientFunds, providerOutage, authenticationError }
  = fixture.provider.failures;

// Inject into FakePayoutProvider:
fakeProvider.simulateError('verifyAccount', new PayoutProviderError(fc.providerError));

// Inject via axios mock:
mockedAxios.get.mockRejectedValue(fc.axiosRejection);

// Assert the browser-visible response:
expect(routeResponse.body).toMatchObject(fc.appRouteResponse);
```

| Scenario | HTTP | Code | Retryable |
|----------|------|------|-----------|
| `invalidAccount` | 422 | `INVALID_ACCOUNT` | No |
| `accountNotFound` | 404 | `ACCOUNT_NOT_FOUND` | No |
| `rateLimited` | 429 | `RATE_LIMITED` | Yes |
| `insufficientFunds` | 400 | `INSUFFICIENT_FUNDS` | No |
| `providerOutage` | 503 | `PROVIDER_UNAVAILABLE` | Yes |
| `authenticationError` | 401 | `AUTHENTICATION_ERROR` | No |

### `rpc` — Soroban RPC mock responses

```ts
// In Playwright: use page.route to intercept Soroban RPC and return fixture values:
await page.route('**/soroban/**', route => {
  route.fulfill({ status: 200, body: JSON.stringify(fixture.rpc.getLatestLedger) });
});

// simulate map: keyed by contract function name
fixture.rpc.simulate['get_admin'].xdr     // base64 ScVal XDR for admin address
fixture.rpc.simulate['get_accrued_fees'].xdr  // i128 XDR for current fees
```

---

## Seed semantics

- Any non-empty string is a valid seed.
- The same seed on any machine, at any time, produces byte-identical output.
- Different seeds produce different addresses, hashes, amounts, and references.
- The seed is recorded in `fixture.seed` and written to `E2E_FIXTURE_SEED` env var.

**Recommended naming:**

```
'default'          → general-purpose tests
'ci-run'           → CI baseline; committed digest can be asserted
'issue-268'        → specific regression coverage
'cancelled-payout' → target a failure scenario
```

---

## Reproducing an integration failure

1. Note the seed from the failed test run (printed by global-setup):
   ```
   [e2e-setup] Fixture generated (seed="ci-run", ...)
   ```
2. Re-run with that seed:
   ```sh
   E2E_FIXTURE_SEED=ci-run pnpm test:e2e
   ```
3. The fixture is byte-identical to the failing run.

---

## Payout-provider stub (optional)

The global-setup can start an in-process HTTP stub that answers Paystack-shaped
requests using the fixture data.  It is **off by default** — most tests mock at
the axios layer without needing a real server.

```sh
# Enable the stub (binds to E2E_PAYOUT_PROVIDER_URL, default http://127.0.0.1:8787)
E2E_PAYOUT_STUB_ENABLED=true pnpm test:e2e
```

Control endpoints (available when the stub is running):

```
POST /__fixture/mode   { "mode": "invalidAccount" }   # Switch to failure mode
GET  /__fixture/state                                  # Inspect current state
```

Supported modes: `normal`, `invalidAccount`, `rateLimited`, `insufficientFunds`,
`outage`, `authError`.

---

## Extending the fixture

1. Add new event families to `generator.ts → buildLedgerHistory`.
2. Add new failure cases to `buildProviderResponses → failures`.
3. Update `schema.ts` and bump `FULLSTACK_FIXTURE_SCHEMA_VERSION`.
4. Add assertions to `src/lib/deterministicFixture.test.ts`.
5. Run `pnpm test:unit` to verify the invariants still hold.

---

## Security notes

- **No secret keys.** Addresses are derived from the seed via SHA-256 → Stellar
  strkey encoding.  The seed cannot be reversed to yield a spendable key.
- **No real user data.** Account names are fixed stubs (`John Doe`, `Jane Smith`)
  that match the existing `FakePayoutProvider` defaults.  No real personal names,
  emails, phone numbers, or account numbers are added.
- **No production credentials.** The fixture carries no `sk_live_*` Paystack keys,
  JWTs, or admin secrets.
- **Local-only network endpoints.** The fixture targets `127.0.0.1`; global-setup
  rejects production endpoint patterns (enforced by `playwright.config.ts`).
