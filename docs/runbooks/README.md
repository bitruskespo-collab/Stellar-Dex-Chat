# Maintainer Runbooks

Diagnosis, safe-retry, rollback, and escalation procedures for every class of
release and deployment workflow failure in this repository.

## Runbooks

| Runbook | Covers | Workflow(s) |
|---------|--------|-------------|
| [Contract build](contract-build.md) | fmt, clippy, test, WASM build, WASM size budget, Cargo.lock drift, readiness gate | `contracts.yml` |
| [Frontend deploy](frontend-deploy.md) | Prettier, TypeScript, ESLint, Next.js build, pnpm lockfile, unit tests, E2E, bundle budget, release validation | `frontend.yml`, `frontend-build.yml` |
| [Migration and deployment](migration.md) | Pre-deployment readiness gate, signer availability, network config, migrations, canary verification, contract rollback | `deploy-futurenet.yml` |
| [Artifact attestation and SBOM](artifact-attestation.md) | SBOM generation (Rust + Node), provenance recording, digest manifest, release-validation job | `security-audit.yml`, `frontend-build.yml`, `deploy-futurenet.yml` |

## Related operational docs

| Document | Topic |
|----------|-------|
| [docs/operations/README.md](../operations/README.md) | Payout state backup and disaster recovery |
| [docs/SIGNER_RECOVERY_AND_KEY_ROTATION.md](../SIGNER_RECOVERY_AND_KEY_ROTATION.md) | Emergency signer rotation and multisig recovery |
| [docs/PROVIDER_CREDENTIAL_ROTATION.md](../PROVIDER_CREDENTIAL_ROTATION.md) | Paystack key rotation and bounded overlap window |
| [docs/preview-environments.md](../preview-environments.md) | Ephemeral preview environment setup and teardown |
| [SECURITY.md](../../SECURITY.md) | Vulnerability reporting, severity thresholds, exception policy |

## Quick reference — which runbook for which error?

| Error message / symptom | Runbook | Section |
|------------------------|---------|---------|
| `cargo fmt -- --check` exits non-zero | [contract-build](contract-build.md) | §2.1 |
| `clippy --all-features -- -D warnings` exits non-zero | [contract-build](contract-build.md) | §2.2 |
| `Cargo.lock changed without a matching Cargo.toml change` | [contract-build](contract-build.md) | §2.3a |
| `expected contract artifact ...optimized.wasm was not produced` | [contract-build](contract-build.md) | §2.4b |
| `WASM size <N> bytes exceeds ... byte limit` | [contract-build](contract-build.md) | §2.4c |
| `Artifact digest missing` | [contract-build](contract-build.md) | §2.5a |
| `Signer secret unavailable for promotion` | [contract-build](contract-build.md) | §2.5c |
| `RPC provider health check failed` | [contract-build](contract-build.md) | §2.5d |
| `Prettier check failed` | [frontend-deploy](frontend-deploy.md) | §2.1a |
| `tsc --noEmit` type errors | [frontend-deploy](frontend-deploy.md) | §2.1b |
| `Next.js Build failed` | [frontend-deploy](frontend-deploy.md) | §2.2a |
| `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` | [frontend-deploy](frontend-deploy.md) | §2.2b |
| Vitest test failures | [frontend-deploy](frontend-deploy.md) | §2.3 |
| Playwright E2E failure | [frontend-deploy](frontend-deploy.md) | §2.4 |
| `record "artifact-digest" "fail"` (deploy) | [migration](migration.md) | §2.1 |
| `record "network-config" "fail"` | [migration](migration.md) | §2.2 |
| `record "signer-availability" "fail"` | [migration](migration.md) | §2.4 |
| `record "provider-health" "fail"` | [migration](migration.md) | §2.5 |
| `record "chain-identity" "fail"` (canary) | [migration](migration.md) | §3.1 |
| `record "contract-queries" "fail"` (canary) | [migration](migration.md) | §3.2 |
| `Missing or empty SBOM` | [artifact-attestation](artifact-attestation.md) | §2.1 / §2.2 |
| `Missing provenance file` | [artifact-attestation](artifact-attestation.md) | §2.3 |
| `sha256sum -c sbom-digests.txt` fails | [artifact-attestation](artifact-attestation.md) | §2.4 |
| Release assets not found during validation | [artifact-attestation](artifact-attestation.md) | §2.5 |

## Principles

**Diagnose before retrying.** A blind re-run can mask a real failure. Read the
failing step output and confirm the root cause before pushing a fix or
re-running a job.

**Fix in a commit, not a re-run.** Only re-run jobs (without a code change) for
transient infrastructure failures (network timeouts, rate limits, flaky tests).
Every real failure must be fixed in code and merged through the normal review
process.

**Never bypass branch protection to fix a build.** A broken build on `main`
is fixed by a revert PR, not by a force-push or protection bypass.

**Escalate when in doubt.** The escalation tables in each runbook list the
right owner for each failure class. When a failure is ambiguous or potentially
security-relevant, escalate early.

**Document incident outcomes.** After any deployment incident, file a
post-mortem issue with: what failed, root cause, timeline, fix applied, and any
process improvements. Link it from the deployment run summary.
