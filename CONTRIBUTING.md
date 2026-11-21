# Contributing

Thanks for contributing to Dechat. This document covers the workflow for
changes that touch the Soroban smart contract interface and its generated
TypeScript client bindings.

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

## Pull request checklist

- [ ] Contract interface changes include regenerated bindings.
- [ ] The CI drift check passes with no ABI diff.
- [ ] Breaking changes are documented and versioned as described above.
- [ ] Regeneration left unrelated files unchanged.

## CI caching

### How caches are keyed

**Rust / Cargo** (`contracts.yml`)

Every job that compiles Rust code uses `Swatinem/rust-cache` with a
`shared-key` of the form:

```
contracts-<toolchain>-<sha256(Cargo.lock)>
```

This means:

- Updating `Cargo.lock` (dependency bump) busts the cache for all Rust jobs
  simultaneously, so no job ever runs with a stale dependency tree.
- Changing the pinned toolchain string also invalidates all entries.
- All Rust jobs in the same workflow run share one cache entry, so the first
  job to finish populates it and the rest restore it.

The `stellar-cli` binary is also cached under `~/.cargo/bin`; the install step
checks the installed version at runtime and skips `cargo install` when the
version matches the pin.

**pnpm / Node.js** (`frontend.yml`)

Every frontend job uses `actions/setup-node` with `cache: "pnpm"` and
`cache-dependency-path: Dechat/dex_with_fiat_frontend/pnpm-lock.yaml`.
GitHub's built-in pnpm cache keys on the lockfile hash, so a `pnpm-lock.yaml`
change automatically busts the store.

All frontend jobs use `pnpm install --frozen-lockfile` to prevent silent
lockfile mutations during CI.

### Cache hit/miss reporting

Each caching step exposes a `cache-hit` output that is echoed to the job
summary. You can read the hit/miss status for every job directly in the
Actions UI without opening individual step logs.

### Secrets and the cache

Secrets (API keys, contract IDs, payout keys) are injected as runtime
environment variables only. They are never written into `node_modules`,
`target/`, or the step summary, so they cannot leak through cached artifacts.

### Periodic cache-verification

`.github/workflows/cache-verify.yml` runs every Sunday at 03:00 UTC (and
on `workflow_dispatch`). It builds both the Soroban WASM and the Next.js
app twice in the same runner — once with the warm cache restored and once
from a fully clean state — then compares the sha256 digests of the outputs.
A mismatch fails the job and writes a diff to the step summary, surfacing
any cache-poisoning or hidden non-determinism.

If the verification job fails, invalidate the stale cache by bumping the
relevant lockfile (`Cargo.lock` or `pnpm-lock.yaml`) or the toolchain/pnpm
version pin in the workflow env block.
