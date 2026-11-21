## Summary

<!-- Describe what this PR changes and why. Link the relevant issue(s). -->

Closes #

---

## Checklist

### General

- [ ] I have read the [CONTRIBUTING](../CONTRIBUTING.md) guide.
- [ ] The PR title follows the conventional-commit format (`type(scope): description`).
- [ ] All CI checks pass (or failures are explained below).

### Contract / ABI changes

> Complete this section if any file under `Dechat/stellar-contracts/` changed.
> If no contract code changed, check **"Not applicable"** and skip the rest of this section.

- [ ] **Not applicable** — no contract source files were modified.

**If contract code was modified, all items below are required:**

- [ ] **ABI compatibility** — the public interface (function signatures, argument types, return types) is:
  - [ ] Fully backward-compatible with the deployed contract (no breaking change).
  - [ ] **OR** intentionally breaking — breaking change is documented in the description above, and a contract upgrade / re-deploy plan is included.
- [ ] **Storage migration** — persistent storage layout changes are:
  - [ ] None — storage keys and types are unchanged.
  - [ ] **OR** present — a migration script or `upgrade()` entry-point is included and tested.
- [ ] **Rollback strategy** — in the event this upgrade needs to be reverted:
  - [ ] A rollback path exists (describe it above or in `MIGRATIONS.md`).
  - [ ] **OR** the change is irreversible; this is acknowledged and justified above.
- [ ] **Generated bindings** — after rebuilding the WASM, the TypeScript bindings under `Dechat/dex_with_fiat_frontend/src/lib/contracts/` have been regenerated and are included in this PR.
- [ ] **Tests** — new or updated contract tests cover the changed entry-points and any migration path.

### Frontend changes

> Complete this section if any file under `Dechat/dex_with_fiat_frontend/` changed.
> If no frontend code changed, check **"Not applicable"**.

- [ ] **Not applicable** — no frontend source files were modified.

**If frontend code was modified:**

- [ ] UI changes are covered by unit tests or E2E tests.
- [ ] No secrets, API keys, or real user data were added to fixtures or test files.
- [ ] Bundle-size budget (`pnpm bundle-budget`) still passes.

### Documentation

- [ ] Relevant docs (`CONTRIBUTING.md`, inline comments, `MIGRATIONS.md`) are updated, or no documentation change is needed.

---

## Migration / upgrade notes

<!-- If you checked any "present" or "breaking" boxes above, describe the
     migration steps, upgrade sequence, and any required admin actions here.
     Delete this section if there are no migration notes. -->

---

## Additional context

<!-- Screenshots, benchmark results, links to related issues or discussions. -->
