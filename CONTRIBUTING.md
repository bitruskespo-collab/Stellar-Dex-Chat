# Contributing

Thanks for contributing to Dechat. This document covers the workflow for
changes that touch the Soroban smart contract interface and its generated
TypeScript client bindings, as well as the payout side-effect pipeline.

## Contract bindings and ABI compatibility

The TypeScript bindings under `Dechat/dex_with_fiat_frontend/src/contracts/`
are generated from the Soroban contract spec using the pinned toolchain
recorded in the repository. They are committed artifacts and must stay in
sync with the contract source.

### Regenerating bindings

After any change to the contract interface, regenerate the bindings with the
pinned toolchain and commit the result together with the contract change:

```sh
# from the repository root, using the pinned toolchain
make bindings        # or the documented generation command for this repo
```

Generation is deterministic: running it on an unchanged contract must leave
unrelated files untouched. If regeneration produces diffs outside the
bindings directory, treat that as a bug and fix the generator rather than
committing the noise.

### CI drift check

CI builds the contract spec from the pinned toolchain and compares it against
the committed bindings. The check fails when any of the following drift
without regenerated bindings:

- function signatures (added, removed, or renamed functions)
- argument names, types, or ordering
- return types
- error codes and their variants

When the check fails, CI emits a reviewable ABI diff artifact so reviewers can
see the exact mismatch. To resolve it, regenerate the bindings and commit them
in the same change as the contract edit.

### Breaking-change versioning

Classify interface changes before merging:

- **Non-breaking** — additive changes such as new functions, new optional
  arguments, or new error variants. These may ship in a minor release.
- **Breaking** — removed or renamed functions, changed argument or return
  types, reordered arguments, or removed/renumbered error codes. These require
  a major version bump of the contract interface and a migration note in the
  changelog.

Breaking changes must be called out explicitly in the pull request description,
including the old and new signatures, so reviewers can confirm the versioning
policy was applied.

## Payout side effects: transactional outbox

Payout state mutations and the outbound provider commands they trigger are
committed atomically through a transactional outbox. Do not call the payment
provider directly from a request handler or from the code path that mutates
payout state.

### How it works

1. **Atomic write.** A payout state change and its corresponding outbox row
   (`payout_outbox`) are written in a single database transaction. Either both
   commit or both roll back — there is no window where state is persisted but
   the provider command is lost, or vice versa.
2. **Stable idempotency key.** Each outbox row carries a deterministic
   idempotency key derived from the payout id, command type, and command
   version (for example `payout:<id>:<command>:v<version>`). The key is stable
   across retries and replays, so the provider can safely deduplicate.
3. **Asynchronous dispatch.** A dispatcher reads pending outbox rows, sends
   the command to the provider using the stored idempotency key, and marks the
   row delivered. Delivery is at-least-once; correctness relies on the
   provider honoring the idempotency key, so never generate a fresh key on
   retry.

### Schema

The `payout_outbox` table (see the migration alongside `001_payout_state.sql`)
stores the command payload, the stable idempotency key, a status, an attempt
count, and timestamps. Status transitions are `pending` → `delivered`, with
failed attempts incrementing the attempt count while the row stays `pending`
for retry.

### Testing expectations

Changes to this pipeline must include focused regression tests covering:

- the normal path (state committed, command dispatched, row marked delivered);
- a crash between database commit and provider dispatch, verifying the pending
  row is picked up and delivered on the next dispatcher run without
  duplicating side effects (idempotency key reuse);
- provider failure and retry, verifying the attempt count increments and the
  idempotency key is unchanged.

## Provider capability contract: reversals and recalls

Provider adapters declare the reversal and recall semantics they support so
callers never assume a capability the provider does not have. Each adapter
exposes a capability descriptor covering:

- **Cancellation** — whether a payout can be cancelled before settlement, and
  the states in which cancellation is permitted.
- **Recall** — whether a settled payout can be recalled/reversed, and the
  states in which recall is permitted.
- **Status semantics** — the provider status values the adapter maps onto the
  internal payout lifecycle, and which of those are terminal.

### Unsupported actions

When a caller requests a cancellation, recall, or status transition the
adapter does not declare support for, the action must be routed to an explicit
**manual-review** outcome. Never report success for an unsupported action, and
never silently drop it. Manual-review outcomes are surfaced through the same
API and UI conventions as other payout states so operators can act on them.

### Testing expectations

Changes to the capability contract must include focused regression tests
covering:

- the normal path for each declared capability (cancellation, recall, status);
- an unsupported action routing to manual-review rather than reporting
  success;
- authorization and recovery edge cases for the manual-review path.

## Pull request checklist

- [ ] Contract interface changes include regenerated bindings.
- [ ] The CI drift check passes with no ABI diff.
- [ ] Breaking changes are documented and versioned as described above.
- [ ] Regeneration left unrelated files unchanged.
- [ ] Payout side effects go through the transactional outbox with a stable
      idempotency key; no direct provider calls from state-mutation paths.
- [ ] Outbox changes include crash/retry regression tests.
- [ ] Provider adapters declare their reversal/recall/status capabilities, and
      unsupported actions route to manual-review instead of false success.
