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
