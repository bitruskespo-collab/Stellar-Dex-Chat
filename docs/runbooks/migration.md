# Runbook: Migration and Deployment Failure

**Workflow:** `deploy-futurenet.yml` — Deploy FiatBridge to Futurenet
**Applies to:** `deploy` job — readiness gate, deploy step, canary verification; `release-validation` job
**Owner:** @contract-owner, @release-manager
**Related:** [Runbook index](README.md) | [Contract build runbook](contract-build.md) | [SIGNER_RECOVERY_AND_KEY_ROTATION](../SIGNER_RECOVERY_AND_KEY_ROTATION.md)

---

## 1. Identify the failing check

The deployment workflow runs a pre-deployment readiness gate with six checks, then deploys, then runs a post-deployment canary. Each maps to a failure class below.

### Pre-deployment readiness gate checks

| Check | Failure symptom | Section |
|-------|----------------|---------|
| `artifact-digest` | No `.wasm` artifact or empty file | §2.1 |
| `network-config` | Passphrase or RPC URL mismatch | §2.2 |
| `migrations` | No `migrations/` directory and no `MIGRATIONS.md` | §2.3 |
| `signer-availability` | `FUTURENET_ADMIN_SECRET_KEY` empty | §2.4 |
| `provider-health` | RPC `getHealth` returns non-2xx | §2.5 |
| `rollback-readiness` | Deploy script missing | §2.6 |

### Post-deployment canary checks

| Check | Failure symptom | Section |
|-------|----------------|---------|
| `chain-identity` | Network passphrase mismatch | §3.1 |
| `contract-queries` | `getContractData` fails | §3.2 |
| `api-health` | `getHealth` fails after deploy | §3.3 |
| `provider-checks` | `getLatestLedger` fails after deploy | §3.3 |

---

## 2. Pre-deployment readiness gate diagnosis

### 2.1 Artifact digest — no WASM artifact

**Symptoms:** `record "artifact-digest" "fail"` in the summary.

**Cause:** `stellar contract build` did not produce a `.wasm` file, or the build job was skipped.

**Fix:**
```bash
cd Dechat/stellar-contracts
stellar contract build
ls -la target/wasm32v1-none/release/*.wasm
```
If the artifact is absent, see [contract-build.md §2.4](contract-build.md#24-build-wasm--wasm-compile-or-size-failure).

**Retry:** Push a rebuild commit (or re-run the failed job if the build step itself succeeded on a previous run and the artifact upload was the failure).

---

### 2.2 Network configuration mismatch

**Symptoms:** `record "network-config" "fail"` — `FUTURENET_NETWORK_PASSPHRASE` does not equal the expected value.

**Cause:** A repository variable or environment variable is stale or incorrectly set.

**Fix:**
1. Go to **Settings → Environments → futurenet → Environment variables**.
2. Verify `FUTURENET_NETWORK_PASSPHRASE` is exactly `Test SDF Future Network ; April 2020` (note the spaces and semicolons).
3. Verify `FUTURENET_RPC_URL` is `https://rpc-futurenet.stellar.org`.
4. Re-run the failed job.

**Safety:** Never deploy to a network whose passphrase you cannot verify. A passphrase mismatch means the contract would be deployed to a different network than intended.

---

### 2.3 Migrations absent

**Symptoms:** Readiness gate warning: `No migrations directory or MIGRATIONS.md found`.

> This check emits a **warning**, not a hard failure. The deploy continues. However, the warning must be reviewed before the deployment proceeds.

**When to act:**
- If the deployment changes on-chain storage layout: **stop**, write the migration, and redeploy. See the migration authoring steps below.
- If no storage change is involved: document this explicitly in the PR description and in `MIGRATIONS.md`.

**Migration authoring steps:**

1. Add a migration entry-point to the contract (e.g. `fn migrate(env: Env, new_wasm_hash: BytesN<32>)`).
2. Document the migration in `Dechat/stellar-contracts/MIGRATIONS.md`:
   ```markdown
   ## vX.Y.Z — <date>
   ### Storage changes
   - Added key `...` with type `...`
   - Removed key `...`
   ### Migration steps
   1. Pause the contract.
   2. Call `migrate(new_wasm_hash)`.
   3. Verify new storage layout via `get_...()`.
   4. Unpause.
   ### Rollback
   <describe rollback path or state that rollback is not possible>
   ```
3. Commit migration and documentation together with the contract change.
4. Re-run the deployment.

---

### 2.4 Signer unavailable

**Symptoms:** `record "signer-availability" "fail"` — `FUTURENET_ADMIN_SECRET_KEY` is empty.

**Cause:** The secret is missing, expired, or was rotated without updating the environment.

**Fix:**
1. Check **Settings → Environments → futurenet → Secrets**.
2. If the secret is missing, add it.
3. If it was rotated, update it with the new value.
4. For emergency key rotation procedure, follow [SIGNER_RECOVERY_AND_KEY_ROTATION](../SIGNER_RECOVERY_AND_KEY_ROTATION.md).
5. Re-run the failed job.

**Safety:** Never commit a signer secret to the repository. Never log it. Never pass it as a command-line argument where it would appear in process listings.

---

### 2.5 Provider health check failed

**Symptoms:** `record "provider-health" "fail"` — `getHealth` returned non-2xx.

**Diagnosis:**
```bash
curl -fsS --max-time 10 https://rpc-futurenet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

**Fix:**
- If the endpoint is temporarily down: check https://status.stellar.org and wait for recovery, then re-run.
- If the endpoint has changed: update `FUTURENET_RPC_URL` in the environment and re-run.
- Do not deploy while the provider is unhealthy. An unhealthy RPC means post-deploy canary will also fail and you will not be able to verify the deployment succeeded.

---

### 2.6 Rollback readiness — deploy script missing

**Symptoms:** `record "rollback-readiness" "fail"` — `scripts/deploy_fiat_bridge_futurenet.sh` not found.

**Fix:** Verify the script exists at `Dechat/stellar-contracts/scripts/deploy_fiat_bridge_futurenet.sh` in the commit being deployed. If it was accidentally deleted, restore it from `git log` and re-deploy.

---

## 3. Post-deployment canary failure

A canary failure means the contract was deployed but cannot be verified on-chain. **This is a higher-severity event than a pre-deployment failure.**

### Immediate response

1. **Do not** deploy again without understanding why the canary failed.
2. Record the failed run URL, the contract ID output by the deploy step, and the WASM sha256.
3. Assess whether the failure is transient (RPC blip) or structural (contract not reachable).

### 3.1 Chain identity mismatch

**Symptoms:** `record "chain-identity" "fail"` — `getNetwork` returns a different passphrase.

**Cause:** The contract was deployed to the wrong network, or the RPC endpoint is routing to a different network than expected.

**Immediate action:**
1. Do not use the deployed contract.
2. Verify which network the RPC endpoint is serving:
   ```bash
   curl -s https://rpc-futurenet.stellar.org \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}' \
     | jq '.result.passphrase'
   ```
3. If the wrong network was used, the deployment is invalid. Treat this as a critical incident and escalate to @contract-owner and @security-owner immediately.

### 3.2 Contract queries failing

**Symptoms:** `record "contract-queries" "fail"` — `getContractData` returns an error for the deployed contract ID.

**Cause:** The contract was not actually deployed despite the deploy step reporting success, or the contract ID returned is incorrect.

**Diagnosis:**
```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --rpc-url https://rpc-futurenet.stellar.org \
  --network-passphrase 'Test SDF Future Network ; April 2020' \
  --source-account <admin_public_key> \
  -- get_admin
```

**Fix options:**
- If the contract is not reachable: attempt a re-deploy from the same WASM artifact (do not rebuild — reuse the artifact whose digest was recorded in the step summary to maintain provenance continuity).
- If the contract is reachable but queries fail: inspect the contract state and check for a migration requirement.

### 3.3 API or provider health failing after deploy

**Symptoms:** `api-health` or `provider-checks` fail in the canary.

**Cause:** Transient RPC instability immediately after deploy, or the deploy step consumed rate limit quota.

**Fix:** Wait 2–5 minutes and re-run the canary step (re-run the job from the Actions UI). If it fails repeatedly, escalate to @platform-owner.

---

## 4. Rollback procedure

The contract is deployed on Stellar. There is no atomic rollback for on-chain state. The procedure below is the closest equivalent.

**Before rolling back, confirm:**
- [ ] The previous contract version and its WASM hash are known and recorded.
- [ ] The previous version is compatible with the current on-chain storage layout (if storage changed, a rollback migration is required).
- [ ] The previous deploy script is available and tested.

**Rollback steps:**

1. **Pause the contract** to stop user-facing transactions while the rollback is in progress:
   ```bash
   stellar contract invoke --id <CONTRACT_ID> \
     --rpc-url https://rpc-futurenet.stellar.org \
     --network-passphrase 'Test SDF Future Network ; April 2020' \
     --source-account <admin_key> \
     -- pause
   ```

2. **Upgrade to the previous WASM:**
   ```bash
   stellar contract install \
     --wasm <path-to-previous.optimized.wasm> \
     --rpc-url https://rpc-futurenet.stellar.org \
     --network-passphrase 'Test SDF Future Network ; April 2020' \
     --source-account <admin_key>
   # Note the WASM hash output
   
   stellar contract invoke --id <CONTRACT_ID> \
     ... \
     -- upgrade --new-wasm-hash <previous-wasm-hash>
   ```

3. **Run the inverse migration** (if applicable) as documented in `MIGRATIONS.md`.

4. **Verify the rollback:**
   ```bash
   stellar contract invoke --id <CONTRACT_ID> ... -- get_admin
   ```

5. **Unpause the contract:**
   ```bash
   stellar contract invoke --id <CONTRACT_ID> ... -- unpause
   ```

6. **Document** the rollback with a post-mortem issue. Record: what failed, why, what was rolled back, and any storage state impact.

---

## 5. Escalation

| Condition | Escalate to |
|-----------|-------------|
| Signer secret missing or suspected compromised | @security-owner immediately; follow [SIGNER_RECOVERY_AND_KEY_ROTATION](../SIGNER_RECOVERY_AND_KEY_ROTATION.md) |
| Chain identity mismatch after deploy | @contract-owner + @security-owner — treat as critical incident |
| Contract deployed but canary cannot verify it | @contract-owner — assess whether a rollback is needed |
| Provider/RPC unavailable for > 30 minutes | @platform-owner; check https://status.stellar.org |
| Storage migration needed but not documented | Stop the deployment; author migration per §2.3 before retrying |
| Deployment to wrong network suspected | @security-owner immediately |
