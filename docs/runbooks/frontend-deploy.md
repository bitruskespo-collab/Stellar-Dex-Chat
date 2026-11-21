# Runbook: Frontend Deploy Failure

**Workflow:** `frontend-build.yml` — Frontend Build Check; `frontend.yml` — Frontend CI
**Applies to:** `build`, `lint`, `unit-tests`, `e2e`, `release-validation` jobs
**Owner:** @platform-owner
**Related:** [Runbook index](README.md) | [Artifact attestation runbook](artifact-attestation.md) | [Preview environments](../preview-environments.md)

---

## 1. Identify the failing job

| Job | Common root cause |
|-----|------------------|
| `lint` / `Lint & Type Check` | TypeScript type error, ESLint violation, Prettier formatting |
| `build` / `Build` | Compile-time error, missing env var, Next.js config issue |
| `unit-tests` | Failing Vitest test, test setup regression |
| `e2e` | Playwright browser test failure, dev server not starting |
| `release-validation` | SBOM missing or malformed, provenance JSON missing SHA or digest |

---

## 2. Diagnosis by job

### 2.1 `lint` — Prettier, ESLint, or TypeScript failure

#### 2.1a Prettier

**Symptoms:** `Prettier check failed` or files listed with formatting diff.

**Diagnosis:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm check
```

**Fix:**
```bash
pnpm format
```
Commit the result.

#### 2.1b TypeScript

**Symptoms:** `tsc --noEmit` exits non-zero; lines like `error TS2345`.

**Diagnosis:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm tsc --noEmit 2>&1 | head -40
```

**Fix:** Resolve the type error. Do not use `@ts-ignore` or `any` casts to silence errors unless the type genuinely cannot be inferred and a comment explains why.

#### 2.1c ESLint

**Symptoms:** `ESLint found errors` with file paths and rule names.

**Diagnosis:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm lint 2>&1 | head -60
```

**Fix:** Correct the code. Use `// eslint-disable-next-line rule-name -- reason` only when suppression is intentional and documented.

---

### 2.2 `build` — Next.js build failure

#### 2.2a Compile-time error

**Symptoms:** `Build failed because of webpack errors` or `Type error` during `next build`.

**Diagnosis:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm build 2>&1 | tail -40
```
Run with placeholder env vars (CI uses `PLACEHOLDER` for all secrets):
```bash
NEXT_PUBLIC_STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
NEXT_PUBLIC_STELLAR_CONTRACT_ID=PLACEHOLDER \
NEXT_PUBLIC_XLM_SAC_ID=PLACEHOLDER \
NEXT_PUBLIC_STELLAR_NETWORK=TESTNET \
GEMINI_API_KEY=PLACEHOLDER \
PAYSTACK_SECRET_KEY=PLACEHOLDER \
PAYOUT_PROVIDER=paystack \
pnpm build
```

**Fix:** Resolve the compile/type error. If the error is a missing env var that is required at build time, ensure it has a safe default or is guarded with a runtime check.

#### 2.2b pnpm install failure

**Symptoms:** `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` or `Cannot resolve module`.

**Cause:** `pnpm-lock.yaml` is out of sync with `package.json`.

**Fix:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm install          # regenerates pnpm-lock.yaml
```
Commit the updated lockfile. CI uses `--frozen-lockfile`; a stale lockfile will always fail.

#### 2.2c Bundle size budget exceeded

**Symptoms:** Bundle budget check fails (if configured).

**Diagnosis:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm build
# Check .next/analyze output or the bundle budget script
node scripts/bundle-budget-check.mjs
```

**Fix:** Identify the chunk that grew (use `ANALYZE=true pnpm build` if `@next/bundle-analyzer` is installed) and reduce it via code splitting, lazy imports, or removing unused dependencies.

---

### 2.3 `unit-tests` — Vitest failure

**Symptoms:** `FAIL src/...` with assertion diffs.

**Diagnosis:**
```bash
cd Dechat/dex_with_fiat_frontend
pnpm test:unit 2>&1 | grep -E "^(FAIL|✗|×)"
```
Run only the failing test file to get the full output:
```bash
pnpm vitest run src/path/to/failing.test.ts
```

**Fix:** Correct the code or test. Do not skip (`it.skip`) or comment out assertions to restore CI.

**Shard failures:** The CI matrix runs 4 shards in parallel. If only one shard fails, the test is likely order-dependent or has a flaky timer/async issue. Run that shard locally:
```bash
pnpm vitest run --shard=N/4   # replace N with the failing shard number
```

---

### 2.4 `e2e` — Playwright failure

**Symptoms:** Playwright test timeout or assertion failure.

**Diagnosis:**
1. Download the `playwright-report` artifact from the failed Actions run.
2. Open `playwright-report/index.html` locally to see screenshots and traces.

```bash
cd Dechat/dex_with_fiat_frontend
pnpm test:e2e 2>&1 | tail -30
```

**Common causes:**
- Selector changed: update the locator in the test.
- Network request failed: mock the request or update the fixture.
- Timing regression: use `await expect(locator).toBeVisible()` rather than fixed sleeps.
- Browser not installed: `pnpm exec playwright install --with-deps chromium`.

**Fix:** Update the test or the code. Do not raise timeouts globally to mask slow interactions.

---

### 2.5 `release-validation` — SBOM / provenance validation failure

This job runs only on `release` events. See [artifact-attestation.md](artifact-attestation.md) for the full diagnosis and repair procedure.

**Quick check:**
```bash
# From the release tag:
gh release download <tag> --pattern 'sbom-*.cdx.json' --pattern 'provenance.json' --dir /tmp/verify
test -s /tmp/verify/sbom-node.cdx.json && echo "node SBOM present"
test -s /tmp/verify/sbom-rust.cdx.json && echo "rust SBOM present"
grep '"bomFormat"' /tmp/verify/sbom-node.cdx.json
grep "$GITHUB_SHA" /tmp/verify/provenance.json
```

If any file is absent or empty, retrigger the `frontend-build.yml` workflow against the release tag by re-publishing the GitHub release.

---

## 3. Safe retry procedure

1. Fix the root cause as described above.
2. Push to the same branch; CI re-runs automatically.
3. For transient failures (pnpm registry timeout, flaky E2E test): re-run only the failed job from the Actions UI.
4. For release validation failures: fix the SBOM/provenance generation step, then re-publish (or delete and re-create) the GitHub release to retrigger the workflow.

**Do not** merge with a failing build by bypassing branch protection.

---

## 4. Rollback procedure

Frontend deployments follow the deployment pipeline. If a broken build was merged to `main`:

1. **Revert:** Open a revert PR immediately.
   ```bash
   git revert <merge-commit-sha> --no-edit
   git push origin HEAD:revert/broken-frontend-build
   ```
2. Get the revert merged through the normal review process (do not bypass protection rules).
3. If a production deployment has already been made from the broken commit, trigger a re-deployment from the last known-good commit via the deployment pipeline.

---

## 5. Escalation

| Condition | Escalate to |
|-----------|-------------|
| Build succeeds locally but fails in CI | @platform-owner — likely a Node version or env var discrepancy |
| `pnpm-lock.yaml` regeneration produces unexpected diffs | @platform-owner — may indicate a dependency resolution change |
| E2E failures that cannot be reproduced | @platform-owner — may be a CI environment or network issue |
| Release validation failure that cannot be fixed by retrigger | @platform-owner + @security-owner — SBOM provenance chain is broken |
| Build failure caused by a supply-chain advisory | @security-owner immediately |
