# Implementation Summary

## Security: Versioned Threat Model & Abuse-Case Register

**Document version:** `TM-1.0.0`
**Status:** Published
**Owner:** Security (with Contract, Frontend, and API owners as reviewers)
**Last reviewed:** 2024-06-01

### Change History

| Version | Date       | Author   | Summary of change                                                                 |
|---------|------------|----------|------------------------------------------------------------------------------------|
| 1.0.0   | 2024-06-01 | Security | Initial published threat model and abuse-case register for browser, wallet, API, model provider, Soroban, and payout provider. |

---

## 1. Scope & Trust Boundaries

This threat model covers the DEX-with-fiat frontend and its adjacent services. The following trust boundaries are in scope:

| # | Boundary | Description |
|---|----------|-------------|
| TB1 | Browser ↔ Wallet | User-controlled browser interacts with an injected wallet extension for signing. |
| TB2 | Browser ↔ API | Frontend calls the Next.js API routes (e.g. `/api/chat`) over HTTPS. |
| TB3 | API ↔ Model Provider | API routes proxy prompts to the upstream LLM/model provider. |
| TB4 | API ↔ Soroban | API/frontend submits signed transactions to Soroban smart contracts. |
| TB5 | API ↔ Payout Provider | API initiates fiat payouts via an external payout provider. |
| TB6 | Payout Provider ↔ API (Webhooks) | Payout provider calls back into the API via webhooks. |

### Sensitive Data & Authority Flows

```
[Browser] --(1) signing intent--> [Wallet] --(2) signed tx--> [Soroban]
    |                                                              ^
    | (3) admin action (authenticated)                             |
    v                                                              |
[API /api/chat] --(4) tool routing--> [Model Provider]             |
    |                                                              |
    | (5) payout request                                           |
    v                                                              |
[Payout Provider] --(6) webhook callback--> [API] -----------------+
```

| Flow | Sensitive data | Authority |
|------|----------------|-----------|
| (1) Signing | Private key material (never leaves wallet), transaction payload | User wallet signature |
| (2) Soroban submit | Signed XDR, contract args | On-chain contract authority |
| (3) Admin actions | Admin session token, privileged parameters | Admin role (server-enforced) |
| (4) Tool routing | User prompt, tool selection, model output | API route authorization + per-user quota |
| (5) Payout | Bank/account identifiers, amount, idempotency key | API service credentials |
| (6) Webhooks | Payout status, provider signature | Provider HMAC/signature verification |

---

## 2. Abuse-Case Register

| ID | Abuse case | Impact | Likelihood | Controls | Owner | Residual risk |
|----|------------|--------|------------|----------|-------|---------------|
| AC-01 | Prompt/tool abuse to exhaust model quota | High | Medium | Per-user AI quota (`src/lib/ai/quota.ts`), aggregate usage metrics (`src/lib/ai/usage-metrics.ts`), route-level enforcement (`src/app/api/chat/route.ts`) | API | Low |
| AC-02 | Forged payout webhook | High | Medium | Provider signature verification, idempotency keys | API | Low |
| AC-03 | Unauthorized admin action | High | Low | Server-side role checks, session validation | API | Low |
| AC-04 | Malicious contract args via tool routing | High | Low | Input validation before Soroban submission | Contract | Medium |
| AC-05 | Wallet signature phishing | Medium | Medium | Explicit signing intent display, no blind signing | Frontend | Medium |
| AC-06 | Model provider data leakage | Medium | Low | Prompt minimization, no secrets in prompts | API | Low |

---

## 3. Mitigation Links

| Control | Linked code / test / follow-up |
|---------|--------------------------------|
| Per-user AI quota | `src/lib/ai/quota.ts` |
| Aggregate usage metrics | `src/lib/ai/usage-metrics.ts` |
| Route-level enforcement | `src/app/api/chat/route.ts` |
| Webhook signature verification | Follow-up: `SEC-112-webhook-verify` |
| Soroban input validation | Follow-up: `SEC-112-contract-validation` |
| Admin role enforcement | Follow-up: `SEC-112-admin-authz` |

---

## 4. Review Triggers

This threat model MUST be reviewed and re-versioned when any of the following occur:

- A new trust boundary is introduced.
- A new payout provider is integrated.
- A Soroban contract upgrade changes authority or data flows.
- A new model provider or tool-routing path is added.
- Any high-risk abuse case changes impact or likelihood.

---

## 5. Exclusions

Operational secrets (API keys, signing keys, provider credentials) are explicitly out of scope for this document and are managed via the secrets store.

---

## 6. Read-Model Freshness Metadata

Indexed read models (admin and user APIs) return a freshness envelope alongside results so a stale projection is never presented as confirmed settlement state.

### Envelope fields

| Field | Type | Description |
|-------|------|-------------|
| `sourceLedgerCursor` | string \| null | Last ledger cursor applied to the projection. `null` when the projection has never been synced. |
| `databaseUpdatedAt` | ISO-8601 string \| null | Commit time of the last write to the projection. |
| `stale` | boolean | `true` when the projection lags the source ledger beyond the configured tolerance. |
| `stalenessReason` | string \| null | Machine-readable reason (`cursor_lag`, `no_cursor`, `sync_error`) when `stale` is `true`. |

### Stale semantics

- When `stale` is `true`, consumers MUST treat amounts and statuses as provisional and MUST NOT render them as confirmed settlement.
- `stale` is derived from `sourceLedgerCursor` lag against the current ledger cursor; a missing cursor (`null`) always yields `stale: true` with `stalenessReason: "no_cursor"`.
- The envelope is additive; existing result fields are unchanged.

---

## 7. Database Concurrency Test Suite

Parallel-request tests run against the production database engine to prove uniqueness and locking constraints prevent duplicate recipients, payouts, webhook events, and retry jobs.

### Running the suite

```bash
# Point at a disposable test database on the production engine (Postgres).
# Never use production data or real credentials here.
export TEST_DATABASE_URL="postgres://test_user:test_password@localhost:5432/dex_test"
npm run test:concurrency
```

- The suite is skipped when `TEST_DATABASE_URL` is unset, so default CI runs are unaffected.
- Each test spawns concurrent requests (e.g. duplicate recipient creation, duplicate payout submission, replayed webhook delivery, duplicate retry-job enqueue) and asserts exactly one row is persisted and the rest fail with a conflict error.
- Fixtures use synthetic identifiers only; no real user data or credentials.

---

## 8. Archival & Restore Verification

### Retention tiers

| Tier | Data | Retention |
|------|------|-----------|
| Audit | Admin actions, payout state transitions | Long-term (compliance window) |
| Webhook | Raw provider webhook payloads and signatures | Medium-term |
| Provider | Provider settlement reports and evidence | Medium-term |

### Checksummed export / import

- Exports are written with a per-record checksum and a manifest checksum over the full export.
- Import verifies the manifest checksum and each record checksum before applying; any mismatch aborts the import.
- After restore, records are reconciled against active payout state; a mismatch is reported as a verification failure rather than silently accepted.

---

## 9. FX & Settlement Calculation Lineage

Every displayed and paid amount persists a `CalculationLineage` record so an auditor can recompute it.

### `CalculationLineage` fields

| Field | Description |
|-------|-------------|
| `calculationVersion` | Version of the calculation logic applied. |
| `inputSourceIds` | Identifiers of the inputs (rates, quotes, ledger entries) used. |
| `currencyMetadataVersion` | Version of the currency metadata (decimals, symbols) applied. |
| `roundingMode` | Rounding decision applied (e.g. `half_up`, `floor`). |
| `roundingScale` | Scale (decimal places) the result was rounded to. |
| `resultAmount` | Final amount produced. |

### Recompute procedure

1. Load the `CalculationLineage` record for the amount.
2. Fetch each input referenced by `inputSourceIds` at the recorded versions.
3. Re-apply `calculationVersion` logic with `currencyMetadataVersion` and the recorded rounding decision.
4. Compare the recomputed amount to `resultAmount`; any difference is a lineage discrepancy and must be investigated before the amount is treated as confirmed.
=======
