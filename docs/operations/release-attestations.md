# Release Attestations — Operational Runbook

Covers issue #282: signed release attestations for contract and frontend artifacts.

**Owners:** `@release-manager`, `@security-owner`  
**Last reviewed:** 2026-11-19  
**Related files:**

| File | Purpose |
| --- | --- |
| `.github/workflows/signed-attestations.yml` | Produces and verifies attestation bundles |
| `.github/workflows/security-audit.yml` | Verifies attestations on every published release |
| `scripts/verify-attestation.sh` | Offline verification for maintainers |
| `Dechat/dex_with_fiat_frontend/src/lib/attestationVerifier.ts` | Programmatic verification library |

---

## 1. Overview

Every push to a `release/**` branch and every published GitHub release triggers
the `Signed Release Attestations` workflow (`signed-attestations.yml`).  It
produces [GitHub-native SLSA Provenance v1](https://slsa.dev/provenance/v1)
attestations — signed with Sigstore via an ephemeral OIDC credential — for two
artifacts:

| Artifact | Description |
| --- | --- |
| `stellar_contracts.optimized.wasm` | Compiled Soroban smart contract |
| `frontend-build.tar.gz` | Packed `.next/` build output |

Each attestation bundle is a DSSE envelope (`.jsonl` file) containing an
in-toto Statement whose predicate ties the artifact's SHA-256 digest to the
exact source revision, workflow identity, and repository that produced it.

The bundles are stored in the GitHub attestation store (queryable via
`gh attestation verify`) and also attached as release assets so external
consumers can verify without cloning the repository.

---

## 2. What gets attested

```
Contract:  stellar_contracts.optimized.wasm
           sha256:<hex>  ←  tied to  →  github.sha + workflow_ref
           Signed by: Sigstore / Fulcio CA (ephemeral OIDC cert)
           Stored:    GitHub attestation store + release asset
                      contract-attestation-bundle.jsonl

Frontend:  frontend-build.tar.gz  (packed .next/ tree)
           sha256:<hex>  ←  tied to  →  github.sha + workflow_ref
           Signed by: Sigstore / Fulcio CA (ephemeral OIDC cert)
           Stored:    GitHub attestation store + release asset
                      frontend-attestation-bundle.jsonl

Manifest:  attestation-manifest.json
           JSON record of both subjects, their digests, and the
           workflow identity.  Attached to the release for audits.
```

---

## 3. Verification — quick reference

### Online (GitHub CLI)

```bash
# Contract WASM
gh attestation verify stellar_contracts.optimized.wasm \
  --repo bitruskespo-collab/Stellar-Dex-Chat

# Frontend build archive
gh attestation verify frontend-build.tar.gz \
  --repo bitruskespo-collab/Stellar-Dex-Chat
```

Both commands check the Sigstore transparency log (Rekor), verify the
Fulcio certificate chain, and confirm the subject digest matches the file
on disk.  Exit 0 means the artifact is genuine.

### Offline (shell script)

```bash
# Download release assets first:
gh release download v1.2.3 \
  --pattern 'contract-attestation-bundle.jsonl' \
  --pattern 'frontend-attestation-bundle.jsonl' \
  --pattern 'attestation-manifest.json' \
  --dir release-assets

# Verify the WASM bundle structurally (no network required):
./scripts/verify-attestation.sh \
  stellar_contracts.optimized.wasm \
  --attestation release-assets/contract-attestation-bundle.jsonl \
  --sha <full-commit-sha> \
  --workflow .github/workflows/signed-attestations.yml \
  --no-sigstore

# Verify the frontend bundle:
./scripts/verify-attestation.sh \
  frontend-build.tar.gz \
  --attestation release-assets/frontend-attestation-bundle.jsonl \
  --sha <full-commit-sha> \
  --no-sigstore

# Verbose output to inspect parsed fields:
./scripts/verify-attestation.sh \
  stellar_contracts.optimized.wasm \
  --attestation release-assets/contract-attestation-bundle.jsonl \
  --verbose
```

### Programmatic (TypeScript)

```typescript
import { verifyAttestation, verifyAttestationJsonl } from '@/lib/attestationVerifier';
import fs from 'fs';

// Single bundle object (already JSON.parsed):
const bundle = JSON.parse(fs.readFileSync('contract-attestation-bundle.jsonl', 'utf8').split('\n')[0]);
const result = await verifyAttestation(bundle, {
  expectedDigest: 'sha256:<hex>',
  expectedRepo:   'bitruskespo-collab/Stellar-Dex-Chat',
  expectedSha:    '<commit-sha>',
  expectedWorkflow: '.github/workflows/signed-attestations.yml',
});
if (!result.ok) {
  console.error('Attestation failed:', result.errors);
}

// Full .jsonl file:
const jsonl = fs.readFileSync('contract-attestation-bundle.jsonl', 'utf8');
const result2 = await verifyAttestationJsonl(jsonl, { expectedRepo: 'bitruskespo-collab/Stellar-Dex-Chat' });
```

---

## 4. Verification checks explained

All three verification paths run the same logical set of checks:

| # | Check | Failure means |
| --- | --- | --- |
| 1 | Bundle is valid JSON | File is corrupted or truncated |
| 2 | DSSE payload present and non-empty | Envelope is malformed |
| 3 | Payload decodes to in-toto statement | Payload encoding is wrong |
| 4 | `predicateType` is SLSA Provenance v1 or v0.2 | Wrong attestation format |
| 5 | At least one subject | No artifact digest was recorded |
| 6 | Subject digest matches the artifact on disk | Artifact was tampered with |
| 7 | Repository claim contains expected repo | Attestation is from a different repo |
| 8 | Source revision matches expected SHA | Artifact built from a different commit |
| 9 | Workflow path contains expected workflow | Attestation produced by wrong workflow |
| 10 | `signatures` array non-empty | Sigstore signing did not complete |

Checks 6–9 are only applied when the corresponding option is supplied.
Checks 7–9 produce warnings rather than hard failures when the claim field is
absent from the predicate (older bundle formats may omit it).

---

## 5. Workflow job structure

```
signed-attestations.yml
│
├── attest-contract          Build WASM → attest → self-verify → upload bundle
├── attest-frontend          Build Next.js → pack → attest → self-verify → upload bundle
│
├── verify-before-deploy     ← needs: [attest-contract, attest-frontend]
│   Independent re-verification of both bundles (digest + predicateType +
│   repo claim).  This job must pass before any downstream deployment
│   workflow may proceed.
│
└── release-upload           ← needs: [verify-before-deploy], if: release
    Attach contract-attestation-bundle.jsonl, frontend-attestation-bundle.jsonl,
    attestation-manifest.json to the GitHub release.

security-audit.yml
│
└── attest-verification      ← if: release
    Downloads bundles from release assets and re-verifies them independently.
    Failure opens a tracking issue via open-tracking-issue.
```

---

## 6. Required permissions

| Permission | Scope | Reason |
| --- | --- | --- |
| `id-token: write` | `attest-contract`, `attest-frontend` | Obtain Sigstore OIDC token |
| `attestations: write` | `attest-contract`, `attest-frontend` | Store bundle in GitHub attestation store |
| `contents: write` | `release-upload` only | `gh release upload` |
| `contents: read` | All other jobs | Least-privilege default |

No secrets are required beyond `GITHUB_TOKEN` (automatically available to all
jobs).

---

## 7. Troubleshooting common failures

### `attest-contract` or `attest-frontend` fails at the attest step

**Symptom:** `actions/attest-build-provenance` exits non-zero.

**Causes and fixes:**

- **Missing `id-token: write` permission** — confirm the job-level
  `permissions` block includes `id-token: write` and `attestations: write`.
- **OIDC token unavailable** — this can happen on forks where GitHub disables
  OIDC by default.  The workflow only triggers on `release/**` branches of the
  upstream repo, so forks should not reach this step.  If running via
  `workflow_dispatch` from a fork, the step will fail — that is expected.

### `verify-before-deploy` fails: digest mismatch

**Symptom:** `Attestation digest mismatch. Expected: <hex> — Attested: <hex2>`.

This means the artifact uploaded to the `contract-wasm-attested-*` artifact
store differs from what was attested.  This should not happen in normal
operation because both use the same build step output.

**Recovery:**
1. Re-run the failed workflow run from the beginning (not just the failing job).
2. If it fails again, file a security incident — the build may have been
   tampered with between the build and attest steps.

### `attest-verification` in `security-audit.yml` skips with a warning

**Symptom:** `Attestation bundles not found on release <tag>`.

This is expected for releases published before issue #282 was merged.  No
action required.  For new releases it means `signed-attestations.yml` did not
run or its `release-upload` job failed.

**Fix:** Manually trigger `signed-attestations.yml` against the release tag:

```bash
gh workflow run signed-attestations.yml \
  --repo bitruskespo-collab/Stellar-Dex-Chat \
  --field ref=<tag>
```

Then re-run the `release-upload` job once bundles are verified.

### `attest-verification` fails: source revision mismatch

**Symptom:** `Source revision mismatch. Bundle: <sha-a> — Release tag: <sha-b>`.

The attestation bundle was produced from a different commit than the one the
release tag points to.  Possible causes:

- The `signed-attestations.yml` run used a different ref (e.g. a branch tip
  that advanced after tagging).
- The release tag was moved after the attestation was produced.

**Recovery:** Delete and recreate the release tag pointing to the correct
commit, then re-run `signed-attestations.yml`.

### `gh attestation verify` returns a certificate error

**Symptom:** `Error: certificate verification failed`.

The Sigstore certificate chain may have expired (ephemeral OIDC certs are valid
for ~10 minutes during signing).  The Rekor log entry is permanent; the
certificate is only needed for initial verification.  Try:

```bash
gh attestation verify <artifact> --repo bitruskespo-collab/Stellar-Dex-Chat \
  --no-public-good  # for private repos
```

If the error persists, the bundle may be from a signing environment that uses a
different Sigstore instance.  Check the `bundle-path` output from
`actions/attest-build-provenance` in the original run.

---

## 8. Adding a new artifact to the attestation workflow

1. Add a build step in `signed-attestations.yml` that produces the artifact
   file.
2. Add an `actions/attest-build-provenance` step referencing the artifact path
   and a descriptive `subject-name`.
3. Add an `actions/upload-artifact` step to persist the bundle.
4. Add a structural self-verification step that decodes the bundle and checks
   the subject digest (follow the existing contract or frontend pattern).
5. In `verify-before-deploy`, add a download step for the new bundle artifact
   and a verification step.
6. In `release-upload`, include the new bundle in the `gh release upload` call
   and add it to `attestation-manifest.json`.
7. In `security-audit.yml` `attest-verification`, add a parallel verify step
   for the new bundle.
8. Update this document's §2 table with the new artifact.

---

## 9. Preserving financial-safety properties

| Property | How preserved |
| --- | --- |
| No credential exposure | Attestation signing uses ephemeral OIDC tokens; no long-lived secrets are written to artifacts or logs. |
| No PII in bundles | Bundles contain only artifact digests, source SHAs, workflow identity strings, and timestamps. |
| Audit trail | Every attestation is recorded in the Sigstore Rekor transparency log — an append-only public ledger. |
| Deployment gate | `verify-before-deploy` must succeed before `release-upload` runs; a failed gate blocks release asset publication. |
| Independent re-check | `security-audit.yml` re-verifies bundles in a separate workflow run, so a compromised `signed-attestations.yml` run cannot silently suppress failures. |

---

## 10. Escalation

| Condition | Action | Escalate to |
| --- | --- | --- |
| Digest mismatch in `verify-before-deploy` | Stop release; investigate build pipeline integrity | `@security-owner`, `@release-manager` |
| `attest-verification` fails on published release | Investigate bundle provenance; consider yanking release | `@security-owner` |
| `gh attestation verify` fails for a recently released artifact | File incident; check Rekor log for the entry | `@security-owner` |
| OIDC token unavailable in CI | Check workflow permissions; do not work around by disabling the step | `@platform-owner` |
