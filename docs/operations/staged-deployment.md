# Staged Contract Deployment — Operational Runbook

Covers issue #283: staged contract deployment with preflight and post-deploy verification.

**Owners:** `@release-manager`, `@platform-owner`  
**Last reviewed:** 2026-11-19  
**Related files:**

| File | Purpose |
| --- | --- |
| `Dechat/stellar-contracts/scripts/staged_deploy.sh` | Four-stage deployment script |
| `.github/workflows/staged-deploy.yml` | CI workflow wiring all four stages |
| `Dechat/dex_with_fiat_frontend/src/lib/deploymentVerifier.ts` | Frontend verification library |

---

## 1. Overview

Every push to a `release/**` branch touching `Dechat/stellar-contracts/**`
triggers the `Staged Contract Deployment` workflow (`staged-deploy.yml`).
It runs four sequential stages before granting the frontend permission to
issue write transactions:

| Stage | Name | Fails fast? |
| --- | --- | --- |
| 1 | Preflight | Yes — blocks deployment |
| 2 | Deploy | Yes — blocks post-deploy |
| 3 | Post-deploy read-only probes | Yes — closes write gate |
| 4 | Write-enable gate | Decision output |

**Financial-safety note:** Stages 3 and 4 only issue read-only Stellar RPC
calls. No state-changing contract method is invoked by the verification
stages. The write-enable decision is a local boolean; this workflow never
mutates contract state to enable or disable writes.

---

## 2. What each stage checks

### Stage 1 — Preflight

| Check | What it verifies | Fatal? |
| --- | --- | --- |
| Required tools | `curl`, `jq`, `stellar` CLI present | Yes |
| RPC health | `/jsonrpc getHealth` returns `status: healthy` | Yes |
| Network passphrase | RPC returns the expected network passphrase | Yes |
| Latest ledger | `/jsonrpc getLatestLedger` returns a positive sequence | Yes |
| WASM present | Artifact file exists and is non-empty | Yes |
| WASM digest pin | SHA-256 of artifact matches `--expected-digest` (when supplied) | Yes |
| Signer key | `STELLAR_ADMIN_SECRET_KEY` env var is set | Yes (unless `--dry-run`) |
| Signer quorum | Minimum quorum for profile logged | Advisory |
| Migrations | Migrations directory or `MIGRATIONS.md` present | Advisory |

### Stage 3 — Post-deploy read-only probes

All calls use the Stellar CLI `contract invoke` in simulation mode
(read-only). **No transaction is submitted.**

| Probe | Function called | Fatal on failure? |
| --- | --- | --- |
| Contract queryable | `getContractData` via RPC | Yes |
| Chain identity re-confirm | `getNetwork` passphrase | Yes |
| Deployment config hash | `get_deploy_config_hash` | Advisory |
| Admin identity | `get_admin` (+ assertion if `--admin` supplied) | Yes when `--admin` supplied |
| Oracle identity | `get_config_snapshot` → `.oracle` (+ assertion if `--oracle`) | Yes when `--oracle` supplied |
| Pause state | `get_pause_state` → `global` must be false | **Yes — financial safety** |
| Circuit breaker | `is_circuit_breaker_tripped` must be false | **Yes — financial safety** |

---

## 3. Running locally

### Full dry-run (no network, no deploy)

```bash
cd Dechat/stellar-contracts

# Dry-run: runs preflight, skips deploy and post-deploy
./scripts/staged_deploy.sh \
  --profile testnet \
  --dry-run \
  --skip-post-deploy
```

### Dry-run with WASM digest pin

```bash
# Build first to get the WASM
stellar contract build
DIGEST=$(sha256sum target/wasm32v1-none/release/stellar_contracts.optimized.wasm | awk '{print $1}')

./scripts/staged_deploy.sh \
  --profile testnet \
  --expected-digest "sha256:${DIGEST}" \
  --dry-run \
  --skip-post-deploy
```

### Re-verify an existing deployment (no deploy step)

```bash
./scripts/staged_deploy.sh \
  --profile testnet \
  --contract-id C<56-char-contract-id> \
  --admin G<admin-address> \
  --oracle G<oracle-address>
```

### Full deployment to testnet

```bash
export STELLAR_ADMIN_SECRET_KEY=S<your-key>

./scripts/staged_deploy.sh \
  --profile testnet \
  --expected-digest "sha256:<expected-hex>" \
  --admin G<admin-address> \
  --oracle G<oracle-address>
```

### Trigger the CI workflow manually

```bash
gh workflow run staged-deploy.yml \
  --repo bitruskespo-collab/Stellar-Dex-Chat \
  --field profile=testnet \
  --field dry_run=true
```

---

## 4. Write-enable gate integration

The `write-gate` job outputs `write_enabled: true|false`.  Downstream
deployment jobs should use a `needs` dependency on `write-gate` and check
this output before proceeding:

```yaml
deploy-frontend:
  needs: [staged-deploy-call]
  if: needs.staged-deploy-call.outputs.write_enabled == 'true'
  steps:
    - name: Deploy frontend
      run: ...
```

The TypeScript `DeploymentVerifier` library
(`src/lib/deploymentVerifier.ts`) exposes the same gate decision in-process
for the frontend application, so SSR and API routes can guard writes
independently of CI:

```typescript
import { forProfile } from '@/lib/deploymentVerifier';
import { myRpcClient } from '@/lib/rpcClient';

const verifier = forProfile('testnet', myRpcClient, {
  contractId:     process.env.NEXT_PUBLIC_STELLAR_CONTRACT_ID,
  expectedAdmin:  process.env.EXPECTED_CONTRACT_ADMIN,
  expectedOracle: process.env.EXPECTED_CONTRACT_ORACLE,
});

const { writeEnabled, errors } = await verifier.runAll();
if (!writeEnabled) {
  logger.error('Write gate closed', { errors });
  throw new Error('Contract deployment not verified — writes disabled.');
}
```

---

## 5. Network profiles

| Profile | RPC URL | Min signers |
| --- | --- | --- |
| `local` | `http://localhost:8000/soroban/rpc` | 1 |
| `testnet` | `https://soroban-testnet.stellar.org` | 2 |
| `futurenet` | `https://rpc-futurenet.stellar.org` | 2 |
| `production` | `https://mainnet.sorobanrpc.com` | 3 |

Override the RPC URL with the `STELLAR_RPC_URL` environment variable.

---

## 6. Override mechanism

Any preflight or post-deploy failure can be downgraded to a warning (without
changing the write-enable output from `false` to `true`) by supplying
`--override-reason`:

```bash
./scripts/staged_deploy.sh \
  --profile testnet \
  --dry-run \
  --override-reason "Testnet RPC temporarily degraded; CI smoke-only"
```

In the CI workflow, set the `override_reason` input:

```bash
gh workflow run staged-deploy.yml \
  --repo bitruskespo-collab/Stellar-Dex-Chat \
  --field profile=testnet \
  --field override_reason="Planned maintenance window"
```

Every override is printed to stdout and to the GitHub Actions job summary so
it is permanently auditable. The override **does** flip the write gate to
`true` when all failures are downgraded; treat this as an authorised bypass
that must be recorded in the incident log.

---

## 7. Troubleshooting

### Stage 1 fails: `stellar CLI not found`

```bash
cargo install --locked stellar-cli --version 28.0.0
```

### Stage 1 fails: `RPC endpoint not healthy`

- Confirm the RPC URL (`STELLAR_RPC_URL` or profile default) is reachable.
- Run `curl -s https://soroban-testnet.stellar.org -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | jq .`
- If the testnet is under maintenance, use `--override-reason` and re-run after the window.

### Stage 1 fails: `WASM digest pin mismatch`

The artifact on disk does not match the expected digest.  Causes:
- A different WASM was built (different toolchain or source).
- The `--expected-digest` flag is stale after a source change.

**Fix:** Rebuild with the pinned toolchain, recompute the digest, and update
the pin in the CI workflow input or calling script.

### Stage 1 fails: `Network passphrase mismatch`

The RPC endpoint returned a different passphrase than expected.  You may be
pointing at the wrong network.  Verify `STELLAR_RPC_URL` and `--profile`.

### Stage 3 fails: `Admin identity mismatch`

The on-chain admin does not match `--admin`.  Causes:
- Wrong contract ID (re-verify is pointing at a different deployment).
- Admin was rotated after the last verified deployment.

**Recovery:**
1. Confirm the correct contract ID with `stellar contract id …`.
2. If the admin was legitimately rotated, update the `--admin` argument and
   re-run the post-deploy verification.
3. If the rotation was unexpected, treat this as a security incident.

### Stage 3 fails: `Contract is GLOBALLY PAUSED`

The on-chain pause state has `global: true`.  Frontend writes must not
proceed.

**Recovery:**
1. Identify who paused the contract and why (`stellar contract invoke … -- get_pause_history`).
2. Resume the contract through the admin key: `stellar contract invoke … -- resume_all`.
3. Re-run post-deploy verification to confirm the pause state is cleared.

### Stage 3 fails: `Circuit breaker is TRIPPED`

A provider outage has tripped the circuit breaker.

**Recovery:**
1. Confirm the provider is back online.
2. Reset the circuit breaker: `stellar contract invoke … -- reset_circuit_breaker`.
3. Re-run post-deploy verification.

### Write gate remains CLOSED after fixing issues

Re-run the full workflow from the beginning (not just the failing job):

```bash
gh workflow run staged-deploy.yml \
  --repo bitruskespo-collab/Stellar-Dex-Chat \
  --field profile=testnet \
  --field contract_id=<your-contract-id>
```

---

## 8. Preserving financial-safety properties

| Property | How preserved |
| --- | --- |
| No write mutations during verification | All post-deploy probes use `contract invoke` simulation; no transaction is submitted |
| Pause state is a hard block | `get_pause_state → global: true` is a *required* check — it always closes the write gate regardless of `--override-reason` **unless** the override is explicitly provided |
| Circuit breaker is a hard block | Same as pause state |
| Admin/oracle assertions are required when configured | Setting `--admin` or `--oracle` makes those checks required severity |
| No credentials in artifacts | `STELLAR_ADMIN_SECRET_KEY` is passed via CI secret; never logged or stored in outputs |
| Override is auditable | Every override is written to stdout and the GitHub Step Summary |

---

## 9. Adding a new post-deploy probe

1. Add the read-only function to the Rust contract (or identify an existing one).
2. Add a new `header / stellar_view / add_summary_row` block in
   `staged_deploy.sh` within Stage 3.
3. Add a corresponding `_check…()` private method in
   `deploymentVerifier.ts`, wired into `runPostDeploy()`.
4. Add test cases for the passing path, failure path, pre-init null, and
   throwing path in `deploymentVerifier.test.ts`.
5. Update the Stage 3 probe table in this document.

---

## 10. Escalation

| Condition | Action | Escalate to |
| --- | --- | --- |
| Preflight fails: network passphrase mismatch | Stop deployment; verify target network | `@release-manager` |
| Preflight fails: WASM digest pin mismatch | Halt and re-build from known-good source | `@security-owner`, `@release-manager` |
| Post-deploy: admin identity unexpected | Treat as security incident | `@security-owner` |
| Post-deploy: contract globally paused | Investigate pause origin before resuming | `@release-manager`, `@security-owner` |
| Post-deploy: circuit breaker tripped | Confirm provider status before reset | `@release-manager` |
| Write gate override used in production | Record in incident log; review within 24 h | `@release-manager`, `@security-owner` |
