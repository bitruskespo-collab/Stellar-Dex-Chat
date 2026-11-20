# FiatBridge Futurenet Deployment Guide

This document describes how to deploy the FiatBridge smart contract to Stellar's Futurenet test network.

## Overview

The FiatBridge contract deployment process includes:
- **Automated CI/CD**: GitHub Actions workflow for release branch deployments
- **Manual Deployment**: Local scripts for development and testing
- **Contract ID Management**: Automatic output of contract IDs for downstream integration

## Prerequisites

### Required Tools
- **Rust** (1.93+): Install from [rustup.rs](https://rustup.rs/), then add the WASM
  target used by the current Soroban SDK:
  ```bash
  rustup target add wasm32v1-none
  ```
- **Stellar CLI** (`stellar`), pinned to a known release:
  ```bash
  cargo install --locked stellar-cli --version 28.0.0
  stellar --version
  ```

### Futurenet Setup
1. Create a Futurenet account at [Stellar Lab](https://lab.stellar.org/)
2. Fund your account with test lumens from the [Stellar Friendbot](https://laboratory.stellar.org/#friendbot-test-network)
3. Export your secret key securely

## Local Deployment

### Bash Script

```bash
# Set environment variables
export FUTURENET_ADMIN_SECRET_KEY="your-secret-key"
export FUTURENET_RPC_URL="https://rpc-futurenet.stellar.org"
export OUTPUT_FILE="./contract_id_futurenet.txt"

# Run deployment script
bash scripts/deploy_fiat_bridge_futurenet.sh
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FUTURENET_ADMIN_SECRET_KEY` | **Required** - Admin Stellar secret key | None |
| `FUTURENET_RPC_URL` | Futurenet RPC endpoint | `https://rpc-futurenet.stellar.org` |
| `FUTURENET_NETWORK_PASSPHRASE` | Futurenet network identifier | `Test SDF Future Network ; April 2020` |
| `OUTPUT_FILE` | Path to save contract ID | `./contract_id_futurenet.txt` |

## Output

The deployment scripts will:
1. ✅ Build the contract to WASM
2. ✅ Deploy to Futurenet
3. ✅ Extract the contract ID
4. ✅ Save contract ID to the specified output file

**Example output file (`contract_id_futurenet.txt`):**
```
CABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456
```

## Automated CI/CD Deployment

### GitHub Actions Workflow

The deployment is automatically triggered on push to `release/*` branches.

**Workflow File:** `.github/workflows/deploy-futurenet.yml`

**Trigger Conditions:**
- Push to branches matching `release/**` pattern
- Only when `stellar-contracts/**` files change

**Required Secrets:**
Configure the following secret in GitHub repository settings:
- `FUTURENET_ADMIN_SECRET_KEY`: Admin secret key for Futurenet

**Steps:**
1. Checkout code
2. Set up Rust toolchain with the `wasm32v1-none` target
3. Install Stellar CLI (pinned version)
4. Build WASM contract (`stellar contract build`)
5. Deploy to Futurenet
6. Upload contract ID artifact
7. Create deployment status

### Setting Up GitHub Secrets

1. Go to **Repository Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add `FUTURENET_ADMIN_SECRET_KEY` with your Stellar secret key
4. Click **Add secret**

### Monitoring Deployments

1. Go to **Actions** tab in your GitHub repository
2. Find the "Deploy FiatBridge to Futurenet" workflow
3. Click the deployment run to see logs and details
4. Artifacts are available for 90 days

## Verifying Deployment

After deployment, verify the contract on Futurenet:

```bash
# Check the deployed contract's interface.
stellar contract info interface \
  --contract-id "CABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456" \
  --network "futurenet" \
  --network-passphrase "Test SDF Future Network ; April 2020" \
  --rpc-url "https://rpc-futurenet.stellar.org"

# Inspect the contract's metadata (SDK / compiler versions, custom entries).
stellar contract info meta \
  --contract-id "CABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456" \
  --network "futurenet" \
  --network-passphrase "Test SDF Future Network ; April 2020" \
  --rpc-url "https://rpc-futurenet.stellar.org"
```

## Troubleshooting

### Issue: "FUTURENET_ADMIN_SECRET_KEY not set"
**Solution:** Ensure the environment variable is exported:
```bash
export FUTURENET_ADMIN_SECRET_KEY="your-secret-key"
```

### Issue: "Failed to deploy contract"
**Solution:** Check the following:
- RPC URL is accessible
- Admin account has sufficient lumens (minimum ~1 XLM)
- Secret key is valid
- Network passphrase matches Futurenet

### Issue: `stellar: command not found`
**Solution:** Install the pinned Stellar CLI release (see [Required Tools](#required-tools)):
```bash
cargo install --locked stellar-cli --version 28.0.0
stellar --version
```

## Least-Privilege Runtime Permissions

Application services that interact with the deployed contract must run with the
minimum credentials and data-store privileges required for their job. This
section is the canonical inventory; keep it in sync with
`scripts/check_runtime_permissions.sh` and the service manifests under
`deploy/permissions/`.

### Credential Inventory

| Service | Credential | Scope | Notes |
|---------|------------|-------|-------|
| `fiat-bridge-indexer` | `INDEXER_STELLAR_SECRET_KEY` | Read-only Horizon/RPC access | Must not be able to submit transactions |
| `fiat-bridge-api` | `API_STELLAR_SECRET_KEY` | Submit `mint`/`burn`/`transfer` invocations only | No admin/upgrade authority |
| `fiat-bridge-admin` | `FUTURENET_ADMIN_SECRET_KEY` | Contract admin functions | Break-glass only; never mounted in long-running services |
| `fiat-bridge-migrator` | `MIGRATOR_STELLAR_SECRET_KEY` | Contract upgrade/initialize | One-shot job; revoked after migration |

Rules:
- Each service gets its **own** keypair. Shared keys across services are rejected.
- Admin and migrator keys are never exposed to request-serving pods.
- Keys are injected at runtime (GitHub Secrets / secret manager), never baked
  into images or committed to the repository.

### Data-Store Privilege Inventory

| Role | Ledger read | Ledger write | Contract storage write | Admin entries |
|------|-------------|--------------|------------------------|---------------|
| `bridge_reader` | ✅ | ❌ | ❌ | ❌ |
| `bridge_writer` | ✅ | ✅ (invoke only) | ✅ (contract-scoped) | ❌ |
| `bridge_admin` | ✅ | ✅ | ✅ | ✅ |

- `bridge_reader` backs the indexer and any read-only API surface.
- `bridge_writer` backs the API's mutation paths and is scoped to the single
  deployed contract ID — no wildcard contract or account grants.
- `bridge_admin` is reserved for the admin/migrator jobs.

### Read vs Mutation Role Split

Where practical, deploy separate credentials for read and mutation paths:

- **Read path** (`bridge_reader`): query contract state, stream events, serve
  GET endpoints. Must fail closed if a write is attempted.
- **Mutation path** (`bridge_writer`): submit state-changing invocations. Must
  not be able to read admin-only entries or perform upgrades.

If a service genuinely needs both, document the justification in its manifest
and grant the narrowest combined role rather than a wildcard.

### Deployment Permission Checks

`scripts/check_runtime_permissions.sh` runs in CI (and can be run locally) to
reject unsafe production permissions. It fails the deployment when it finds:

- Wildcard grants (`*`, `**`, `all`, `any`) in any production role or policy.
- Admin or migrator credentials referenced by a request-serving service.
- A single keypair shared across more than one service.
- Write privileges on resources outside the deployed contract ID.
- Missing read/mutation role split for services that perform both.

Run it before deploying:

```bash
# Validate the production permission manifests.
bash scripts/check_runtime_permissions.sh --env production

# Validate a specific service manifest.
bash scripts/check_runtime_permissions.sh --env production --service fiat-bridge-api
```

A non-zero exit code means the deployment must be blocked until the offending
grant is removed. Futurenet/dev manifests may use broader grants for testing,
but production manifests must pass with zero findings.

## Security Considerations

⚠️ **Important:** Never commit secret keys to the repository.

- Use GitHub Secrets for CI/CD deployments
- Store local secret keys in secure, encrypted storage
- Rotate keys periodically
- Use different keys for different environments (Futurenet, Testnet, Public)
- Follow the least-privilege inventory above; do not grant wildcard or
  cross-service permissions in production

## Additional Resources

- [Stellar smart contracts documentation](https://developers.stellar.org/docs/build/smart-contracts/overview)
- [Stellar CLI repository and reference](https://github.com/stellar/stellar-cli)
- [Futurenet Information](https://developers.stellar.org/networks/future-net)
- [Contract Deployment Guide](https://developers.stellar.org/learn/smart-contracts/deploy)
