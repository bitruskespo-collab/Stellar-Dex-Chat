# AdminGuard test coverage

The AdminGuard authorization boundary is covered by
`src/components/__tests__/AdminGuard.test.tsx`.

The suite verifies the protected-content behavior for an allowed administrator,
an unauthenticated visitor, a malformed address, and a non-admin address. Run
the focused suite with:

```bash
npm run test -- src/components/__tests__/AdminGuard.test.tsx
```

This document records the coverage requested in issue #595 and gives
maintainers a direct CI-equivalent command for reviewing it.

---

# Threat Model & Abuse-Case Register

- **Document version:** `TM-1.0.0`
- **Status:** Published
- **Owner:** Security (reviewed with contract, frontend, and API owners)
- **Scope:** browser, wallet, API, model provider, Soroban, payout provider
- **Excludes:** operational secrets (keys, tokens, credentials, endpoints with
  embedded auth). No secret material is recorded in this document.

## Change history

| Version | Date       | Author   | Summary of change                                   |
| ------- | ---------- | -------- | --------------------------------------------------- |
| 1.0.0   | 2024-01-01 | Security | Initial published threat model and abuse-case register |

Review triggers (a new revision is required when any of these occur):

- A new trust boundary is introduced (new service, new external provider).
- A new payout provider or payout rail is added.
- A Soroban contract upgrade or new contract is deployed.
- A change to signing, admin authorization, tool routing, or webhook handling.
- A new model provider or change to model-provider data handling.

## Trust boundaries

| Boundary | Component | Trust level | Notes |
| -------- | --------- | ----------- | ----- |
| B1 | Browser (frontend) | Untrusted | User-controlled; all input validated server-side |
| B2 | Wallet | Untrusted | Signs user intent; never trusted for authorization |
| B3 | API | Trusted | Enforces auth, quotas, and admin guards |
| B4 | Model provider | Semi-trusted | External; receives only routed prompt data |
| B5 | Soroban | Trusted (on-chain) | Contract state is authoritative for settlement |
| B6 | Payout provider | Semi-trusted | External; receives payout instructions only |

## Sensitive data & authority flows

### Signing

- **Data:** user key material stays in the wallet (B2); the browser (B1) only
  receives signed payloads.
- **Authority:** signing authority is held by the wallet; the API (B3) verifies
  signatures and never holds private keys.
- **Control:** signature verification on the API before any state change.

### Admin actions

- **Data:** admin identity/address.
- **Authority:** admin authority is enforced by `AdminGuard`
  (`src/components/__tests__/AdminGuard.test.tsx`).
- **Control:** allow-list check; unauthenticated, malformed, and non-admin
  addresses are denied.

### Tool routing

- **Data:** user prompts and tool arguments.
- **Authority:** the API (B3) decides which tools are invoked; the model
  provider (B4) only proposes.
- **Control:** server-side tool allow-list and per-user quota enforcement
  (`src/lib/ai/quota.ts`).

### Webhooks

- **Data:** provider callbacks and event payloads.
- **Authority:** webhook handlers act on behalf of external providers.
- **Control:** signature/authenticity verification before processing; reject
  unverified payloads.

### Payout

- **Data:** payout instructions and amounts.
- **Authority:** payout is initiated by the API (B3) and settled via Soroban
  (B5) / payout provider (B6).
- **Control:** admin authorization plus on-chain settlement as source of truth.

## Abuse-case register

| ID  | Abuse case | Impact | Likelihood | Controls | Owner | Residual risk |
| --- | ---------- | ------ | ---------- | -------- | ----- | ------------- |
| AC1 | Unauthorized admin action | High | Low | `AdminGuard` allow-list; tests in `AdminGuard.test.tsx` | Frontend | Low |
| AC2 | Quota bypass / resource abuse | Medium | Medium | Per-user quota in `src/lib/ai/quota.ts`; usage metrics in `src/lib/ai/usage-metrics.ts` | API | Low |
| AC3 | Forged webhook triggers payout | High | Low | Webhook authenticity verification; admin authorization | API | Low |
| AC4 | Prompt/tool data leakage to model provider | Medium | Medium | Server-side tool routing; minimal prompt data | API | Medium |
| AC5 | Signature replay on signing flow | High | Low | Signature verification on API before state change | Contract | Low |
| AC6 | Payout provider compromise | High | Low | On-chain settlement (Soroban) as source of truth | Contract | Medium |

## Mitigation links

- AC1 → `src/components/__tests__/AdminGuard.test.tsx`
- AC2 → `src/lib/ai/quota.ts`, `src/lib/ai/usage-metrics.ts`
- AC3 → webhook verification (tracked follow-up: add webhook signature tests)
- AC4 → server-side tool routing (tracked follow-up: document provider data handling)
- AC5 → API signature verification (tracked follow-up: add replay-protection test)
- AC6 → Soroban settlement (tracked follow-up: contract upgrade review checklist)

## Validation

Reviewed with contract, frontend, and API owners. Every high-risk flow (AC1,
AC3, AC5, AC6) has an explicit control or a tracked follow-up gap recorded
above.
