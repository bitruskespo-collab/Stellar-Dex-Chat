# DEX with Fiat Frontend

Frontend for the DEX-with-fiat flow. It renders the swap/transaction UI, drives the
intent pipeline, and talks to the backend contract/API layer.

## Model failover: conversation and policy versions

When the intent pipeline fails over from one model/provider to another, the
failover must be **transparent to financial safety**. Two invariants are enforced:

1. **Conversation and policy versions are preserved.** Each request trace records
   the model/provider identity together with the conversation version and the
   policy version(s) that were in effect when the request was issued. A failover
   to a different provider does not reset or bump these versions; the trace shows
   the same conversation and policy versions before and after the switch.
2. **Tool allowlists are identical across failover.** The set of tools (and thus
   the transaction permissions) available to the fallback provider is exactly the
   allowlist of the primary provider. A provider change can never broaden
   transaction permissions — any attempt to add tools during failover is rejected
   and the request fails closed rather than executing with wider permissions.

### Request trace fields

Each request trace includes:

- `model` / `provider` — the model and provider that served the request.
- `conversationVersion` — the conversation version at request time.
- `policyVersion` — the policy version(s) applied to the request.
- `toolAllowlist` — the effective tool allowlist used for the request.

### Regression coverage

Focused tests cover:

- the normal failover path (provider switch preserves conversation/policy versions
  and the tool allowlist), and
- the edge case where a provider change attempts to broaden the transaction
  permission allowlist — the request must be rejected and no transaction may be
  executed with the broadened permissions.

These properties preserve the existing financial safety guarantees; no
compatibility or behavior change is introduced for the non-failover path.

## Development

See the repository `CONTRIBUTING.md` for setup, checks, and contribution
conventions.
