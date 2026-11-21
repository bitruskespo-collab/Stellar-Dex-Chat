# Runbook: Contract Build Failure

**Workflow:** `contracts.yml` — Smart Contract CI
**Applies to:** `fmt`, `clippy`, `test`, `build-wasm`, `readiness-gate` jobs
**Owner:** @contract-owner
**Related:** [Runbook index](README.md) | [Migration runbook](migration.md) | [SIGNER_RECOVERY_AND_KEY_ROTATION](../SIGNER_RECOVERY_AND_KEY_ROTATION.md)

---

## 1. Identify the failing job

Open the failed Actions run. Each job maps to one failure class below.

| Job | Common root cause |
|-----|------------------|
| `fmt` | Unformatted Rust code |
| `clippy` | Lint warning promoted to error |
| `test` | Failing unit test or Cargo.lock drift |
| `build-wasm` | Compile error, missing target, WASM size budget exceeded, stellar-cli install failure |
| `readiness-gate` | Missing artifact digest, network config absent, signer secret missing, RPC endpoint unreachable |

---

## 2. Diagnosis by job

### 2.1 `fmt` — formatting failure

**Symptoms:** `error[E0001]: difference in formatting` or `cargo fmt -- --check` exits non-zero.

**Diagnosis:**
```bash
cd Dechat/stellar-contracts
cargo fmt --all -- --check
```
The diff shows every unformatted span.

**Fix:**
```bash
cargo fmt --all
```
Commit the resulting diff. The check is deterministic; no other change is needed.

**Retry:** Push the formatting commit; CI re-runs automatically.

---

### 2.2 `clippy` — lint failure

**Symptoms:** `error: ...` lines from clippy; job exits with `clippy --all-targets --all-features -- -D warnings`.

**Diagnosis:**
```bash
cd Dechat/stellar-contracts
cargo clippy --all-targets --all-features -- -D warnings 2>&1 | head -60
```

**Fix options (in order of preference):**

1. **Fix the code** — address the lint. This is always the right path for new warnings.
2. **Suppress with justification** — add `#[allow(clippy::lint_name)]` with an inline comment explaining why suppression is intentional. Use only when the lint produces a false positive or the fix would be a larger refactor tracked separately.
3. **Never** silence all warnings globally or use `#![allow(warnings)]`.

**Retry:** Push the fix; CI re-runs automatically.

---

### 2.3 `test` — test or Cargo.lock drift failure

#### 2.3a Cargo.lock drift

**Symptoms:** `Error: Dechat/stellar-contracts/Cargo.lock changed without a matching Cargo.toml change.`

**Cause:** `Cargo.lock` was updated (e.g. by a local `cargo update`) without a corresponding `Cargo.toml` change.

**Fix:**
```bash
cd Dechat/stellar-contracts
# Restore Cargo.lock to what the base branch had, then re-generate it
# from the actual Cargo.toml changes on this branch:
git checkout origin/main -- Cargo.lock
cargo update --workspace   # only if Cargo.toml actually changed
```
Commit the corrected `Cargo.lock`.

#### 2.3b Failing tests

**Diagnosis:**
```bash
cd Dechat/stellar-contracts
cargo test 2>&1 | grep -E "^(test |FAILED|error)"
```
Read the assertion output. Most test failures are deterministic; the message names the failing test and the assertion that failed.

**Fix:** Correct the code or the test. Do not comment out or skip tests to make CI pass.

**Retry:** Push the fix.

---

### 2.4 `build-wasm` — WASM compile or size failure

#### 2.4a Compile error

**Symptoms:** `error[E...]` from `stellar contract build`.

**Diagnosis:**
```bash
cd Dechat/stellar-contracts
stellar contract build 2>&1 | head -80
```

**Fix:** Resolve the compile error. WASM target (`wasm32v1-none`) has stricter constraints than the host target — no `std` features that touch the OS, no floating-point in some configurations. Check for `cfg(target_arch = "wasm32")` guards if the error is target-specific.

#### 2.4b Missing optimised artifact

**Symptoms:** `Error: expected contract artifact target/wasm32v1-none/release/stellar_contracts.optimized.wasm was not produced`

**Cause:** `stellar contract build` did not run the optimiser, or the optimiser is not installed.

**Diagnosis:**
```bash
ls -la Dechat/stellar-contracts/target/wasm32v1-none/release/*.wasm 2>/dev/null || echo "No WASM artifacts"
stellar --version
```

**Fix:**
```bash
cargo install --locked stellar-cli --version 28.0.0
stellar contract build
```
If `stellar-cli` installs but the optimised artifact is still absent, check that `stellar-cli` ≥ 21 is used (earlier versions do not produce `.optimized.wasm`).

#### 2.4c WASM size budget exceeded

**Symptoms:** `Error: WASM size <N> bytes exceeds 98500 byte limit`

**Cause:** A code or dependency change increased the contract binary size beyond the budget set in `MAX_WASM_BYTES`.

**Diagnosis:**
```bash
cd Dechat/stellar-contracts
stellar contract build
wc -c target/wasm32v1-none/release/stellar_contracts.optimized.wasm
```
Compare with `git log --oneline -5` to find which commit added the size.

**Fix options:**
1. Remove unused dependencies from `Cargo.toml`.
2. Gate large features behind `#[cfg(not(target_arch = "wasm32"))]`.
3. If the size increase is intentional and the new budget is justified, update `MAX_WASM_BYTES` in `contracts.yml` with a comment explaining the new limit and get review from a contract owner.

**Do not** raise the budget silently to make CI pass.

#### 2.4d stellar-cli install failure

**Symptoms:** `error: could not compile stellar-cli` or network timeout during `cargo install`.

**Diagnosis:** Transient network issue or crates.io rate-limit.

**Safe retry:** Re-run the failed job from the Actions UI (Actions → select run → Re-run failed jobs). Do not change any code.

---

### 2.5 `readiness-gate` — pre-promotion check failure

The readiness gate runs after all other jobs pass. Its failures indicate environment or infrastructure problems, not code bugs.

#### 2.5a Missing artifact digest

**Symptoms:** `::error::Artifact digest missing`

**Cause:** The `build-wasm` job artifact was not uploaded (upload step failed or was skipped).

**Fix:** Check the `build-wasm` job for an earlier failure. Resolve that failure first; the readiness gate will pass once a valid artifact is uploaded.

#### 2.5b Network configuration missing

**Symptoms:** `::error::Network configuration (EXPECTED_NETWORK_PASSPHRASE / EXPECTED_RPC_URL) is not set`

**Fix:**
1. Go to **Settings → Secrets and variables → Variables**.
2. Verify `EXPECTED_NETWORK_PASSPHRASE` and `EXPECTED_RPC_URL` are set for the environment (or at the repository level if no environment scoping is used).
3. Re-run the failed job.

#### 2.5c Signer secret unavailable

**Symptoms:** `::error::Signer secret unavailable for promotion`

**Fix:**
1. Verify `STELLAR_SIGNER_SECRET` is configured in **Settings → Secrets** for the target environment.
2. If the secret was rotated, update it. See [SIGNER_RECOVERY_AND_KEY_ROTATION](../SIGNER_RECOVERY_AND_KEY_ROTATION.md) for key rotation procedure.
3. Re-run the failed job.

#### 2.5d RPC provider health check failed

**Symptoms:** `::error::RPC provider health check failed (HTTP <N>)`

**Cause:** The Stellar testnet/mainnet RPC endpoint is unavailable or rate-limited.

**Diagnosis:**
```bash
curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  https://soroban-testnet.stellar.org
```

**Fix options:**
- If the endpoint is temporarily unavailable: wait 10–15 minutes and re-run the job. SDF testnet has occasional maintenance windows.
- If the endpoint is persistently down: check https://status.stellar.org and the `#stellar-dev` Discord channel.
- If a custom `EXPECTED_RPC_URL` is configured and that endpoint is down, restore or replace it in repository variables.

---

## 3. Safe retry procedure

1. Identify and fix the root cause as above.
2. Push the fix to the same branch; do not force-push.
3. CI re-runs automatically on `push`.
4. For transient infrastructure failures (stellar-cli download, RPC health), re-run only the failed job from the Actions UI without code changes.

**Never** re-run a job to paper over a real failure. The fix must be in a commit.

---

## 4. Rollback procedure

The contract build runs on PRs and on push to `main`. It does not deploy anything. There is nothing to roll back from a failed build.

If a **broken build was merged** to `main` unintentionally (e.g. via a bypass):

1. Open a revert PR immediately: `git revert <merge-commit-sha>`.
2. Mark the PR as urgent and get it merged promptly.
3. File an incident report explaining how the bypass occurred.

---

## 5. Escalation

| Condition | Escalate to |
|-----------|-------------|
| Compile error that cannot be reproduced locally | @contract-owner — may indicate toolchain version skew |
| WASM size budget increase needed | @contract-owner + one additional maintainer review |
| Signer secret missing or compromised | @security-owner immediately; follow [SIGNER_RECOVERY_AND_KEY_ROTATION](../SIGNER_RECOVERY_AND_KEY_ROTATION.md) |
| RPC endpoint persistently unavailable | @platform-owner; check https://status.stellar.org |
| Cargo.lock drift on `main` without an open PR | Treat as a potential supply-chain event; notify @security-owner |
