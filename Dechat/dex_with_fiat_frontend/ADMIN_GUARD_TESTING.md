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

---

# Capability Flags & Kill-Switch Runbook

This section documents the staged-rollout and kill-switch controls for
frontend and API capabilities (issue #123). Flags are **server-controlled** and
**per-environment**; the frontend only reflects server state and never decides
whether a capability is allowed.

## Flag model

Each capability has an explicit default per environment. A flag is a boolean
`enabled` value; the server is the single source of truth.

| Capability | development | staging | production |
| ---------- | ----------- | ------- | ---------- |
| `frontend.trading` | enabled | enabled | enabled |
| `frontend.payouts` | enabled | enabled | disabled |
| `api.toolRouting` | enabled | enabled | enabled |
| `api.payouts` | enabled | disabled | disabled |

Defaults are declared in code (not inferred from missing values): an unknown or
missing flag resolves to **disabled** (fail-closed).

## Enforcement

- The server evaluates the flag on every request for the capability and
  rejects disabled capabilities with a `403` before any state change.
- Hiding a UI control is **not** enforcement; direct API requests are checked
  the same way as UI-originated requests.
- Flags never weaken wallet signature verification or on-chain (Soroban)
  authorization. A disabled flag blocks the capability; an enabled flag does
  **not** bypass signature or contract checks.

## Mutation & audit

- Only authorized administrators (enforced by `AdminGuard` / server admin
  allow-list) may change a flag. Unauthorized callers receive `403` and no
  change is applied.
- Every change is audited with: **actor**, **timestamp**, **reason**, and
  **prior value**. The audit entry is written atomically with the change.

## Rollback / kill-switch procedure

1. Identify the capability and environment.
2. Set the flag to `disabled` with a written reason.
3. Confirm the audit entry records actor, time, reason, and prior value.
4. Verify a direct request to the capability is rejected (`403`).
5. Re-enable only after the root cause is resolved and re-tested.

## Prohibited

- Do **not** bypass on-chain checks or signature verification to "work around"
  a disabled flag.
- Do **not** rely on hidden UI controls as a security boundary.
- Do **not** mutate flags outside the audited, authorized path.

## Validation

Test all flag states (enabled/disabled per environment) and direct requests to
each capability. Confirm unauthorized callers cannot change or bypass flags and
that disabled capabilities are rejected server-side.
