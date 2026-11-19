# Release Health Gates — Operational Runbook

Covers issue #284: rollback-safe frontend and API release health gates.

**Owners:** `@release-manager`, `@platform-owner`  
**Last reviewed:** 2026-11-19  
**Related files:**
- `Dechat/dex_with_fiat_frontend/src/lib/releaseHealthGate.ts` — gate library
- `Dechat/dex_with_fiat_frontend/src/app/api/health/route.ts` — health endpoint
- `.github/workflows/release-health-gate.yml` — CI workflow

---

## 1. Overview

Every push to a `release/**` branch triggers the `Release Health Gate` workflow.
It polls `GET /api/health` for up to five minutes, evaluates three metrics against
configurable thresholds, and either marks the release healthy or signals that a
rollback is needed.

**Financial-safety constraint:** a ROLLBACK decision blocks further payout
processing via `isPayoutProcessingPermitted()`. It does not itself execute any
financial mutation. The operator must initiate the rollback action independently
(see §4).

---

## 2. Decision rules

The gate evaluates metrics in priority order on every poll:

| Priority | Condition | Decision |
| --- | --- | --- |
| 1 | Payout failures ≥ `maxPayoutFailures` within window | **ROLLBACK** |
| 2 | Error rate > `maxErrorRate` AND requests ≥ `minRequestsForErrorRate` | **ROLLBACK** |
| 3 | Error rate > `maxErrorRate / 2` AND requests ≥ `minRequestsForErrorRate` | **DEGRADED** |
| 4 | None of the above | **HEALTHY** |

DEGRADED returns HTTP 200 and permits payout processing — it is a warning, not
a block. ROLLBACK returns HTTP 503 and sets `payoutProcessingPermitted: false`.

### Default thresholds

| Parameter | Default | Environment variable |
| --- | --- | --- |
| `maxErrorRate` | 0.05 (5 %) | `MAX_ERROR_RATE` |
| `maxPayoutFailures` | 3 | `MAX_PAYOUT_FAILURES` |
| `windowMs` | 600 000 ms (10 min) | `HEALTH_WINDOW_MS` |
| `minRequestsForErrorRate` | 5 | — (code constant) |
| Probe interval | 30 s | `PROBE_INTERVAL_SECONDS` |
| Probe timeout | 300 s | `PROBE_TIMEOUT_SECONDS` |

Override at the repository or environment level in **Settings → Variables**.

---

## 3. Checking gate status

### Via the CI job summary

1. Open the failed workflow run in GitHub Actions.
2. Click the **Rollback Decision** job.
3. The job summary table shows decision, error rate, payout failures, and the
   human-readable reason.
4. The gate-report artifact (`release-health-gate-report-<sha>`) contains the
   full JSON record for post-incident review.

### Via the API directly

```bash
# Check live gate state (uses default thresholds)
curl -s https://<deployment>/api/health | jq .releaseHealth

# Check with custom thresholds (one-shot, does not mutate server state)
curl -s "https://<deployment>/api/health?maxErrorRate=0.03&maxPayoutFailures=2" \
  | jq .releaseHealth
```

**Example HEALTHY response:**

```json
{
  "status": "ok",
  "timestamp": "2026-11-19T12:00:00.000Z",
  "releaseHealth": {
    "decision": "HEALTHY",
    "payoutProcessingPermitted": true,
    "reason": null,
    "metrics": {
      "totalRequests": 240,
      "erroredRequests": 3,
      "errorRate": 0.0125,
      "payoutFailures": 0
    },
    "thresholds": {
      "maxErrorRate": 0.05,
      "maxPayoutFailures": 3,
      "windowMs": 600000,
      "minRequestsForErrorRate": 5
    },
    "windowMs": 600000
  }
}
```

**Example ROLLBACK response (HTTP 503):**

```json
{
  "status": "rollback",
  "releaseHealth": {
    "decision": "ROLLBACK",
    "payoutProcessingPermitted": false,
    "reason": "Payout failures (3) reached threshold (3) within the observation window.",
    "metrics": { "payoutFailures": 3, "errorRate": 0.02 }
  }
}
```

---

## 4. Rollback procedure

The gate signals that rollback is needed; the operator executes it.

### 4a. Revert via GitHub release (standard path)

1. Identify the last known-good release tag (e.g. `v1.2.3`).
2. Re-run the deployment workflow for that tag:
   ```
   gh workflow run deploy-futurenet.yml --ref v1.2.3
   ```
3. Monitor the subsequent health-gate run until it reaches **HEALTHY**.
4. Record the incident in the payout audit ledger (`PROVIDER_UNAVAILABLE` or
   `INTERNAL_ERROR` category) so the reconciliation report reflects the gap.

### 4b. Revert via git revert (hotfix path)

```bash
git checkout main
git revert --no-commit <bad-sha>
git commit -m "revert: rollback unhealthy release <bad-sha>"
git push origin main
```

Then re-deploy from `main`.

### 4c. Frontend-only rollback

If only the Next.js frontend is affected:

```bash
# Re-deploy the previous Vercel/edge deployment
gh workflow run frontend-build.yml --ref <previous-tag>
```

---

## 5. Authorising an emergency override

If the rollback is not viable (e.g. the previous version also has a critical
bug) an operator may override the gate by setting a repository or environment
variable **before re-running the workflow**.

```
Settings → Variables → New repository variable
Name:  ROLLBACK_OVERRIDE_REASON
Value: "Hotfix v1.2.4 required; previous version has CVE-XXXX-YYYY"
```

The override reason is printed to the job summary and stored in the
gate-report artifact. It is **not** a silent bypass — every override is
auditable. Clear the variable once the situation is resolved.

> **Financial-safety note:** An override does not re-enable payout processing
> on a live server that has already seen a ROLLBACK decision. The server-side
> gate accumulates samples independently of CI. Payout processing will resume
> automatically once the observation window expires and healthy traffic
> re-establishes the gate as HEALTHY.

---

## 6. Testing the rollback workflow with a non-production release

The workflow includes an inline Python mock server so the entire gate-and-rollback
path can be exercised without a live environment.

**Trigger a mock-server test run:**

```bash
# Dispatch against any branch — no real deployment URL needed
gh workflow run release-health-gate.yml \
  --ref feat/issue-284-release-health-gates
```

Because `HEALTH_GATE_TARGET_URL` is not set, the workflow starts its own mock
server that returns a HEALTHY response. The job summary will show probe attempts
and the final **HEALTHY** verdict.

**Simulate a ROLLBACK (payout failures):**

1. Set `MAX_PAYOUT_FAILURES=0` as a repository variable (or use
   `workflow_dispatch` inputs: `max_payout_failures=0`).
2. The mock server always returns `payoutFailures: 0`, so to get an actual
   ROLLBACK in mock mode set `max_payout_failures=0` which makes the threshold
   unreachable from the start and forces a timeout-ROLLBACK, or point
   `HEALTH_GATE_TARGET_URL` at a staging deployment that actually has failures.

**Simulate a ROLLBACK (error rate):**

```bash
gh workflow run release-health-gate.yml \
  --ref feat/issue-284-release-health-gates \
  --field max_error_rate=0.001  # threshold below mock's ~1.7 % error rate
```

The gate will fire ROLLBACK on the first probe since the mock error rate
(1.67 %) exceeds the 0.001 override threshold.

---

## 7. Feeding the gate from API route handlers

Import the thin helpers from the health route and call them from any route
that should contribute to gate metrics:

```typescript
import {
  recordApiRequest,
  recordPayoutFailure,
  isPayoutProcessingPermitted,
} from '@/app/api/health/route';

// In a route handler (e.g. initiate-transfer):
export async function POST(req: Request) {
  // Guard payout processing before doing any work
  if (!isPayoutProcessingPermitted()) {
    return NextResponse.json(
      { error: 'PROVIDER_OUTAGE', message: 'Payout processing is currently suspended.' },
      { status: 503 },
    );
  }

  try {
    const result = await initiateTransfer(/* ... */);
    recordApiRequest(false, '/api/initiate-transfer');
    return NextResponse.json(result);
  } catch (err) {
    recordApiRequest(true, '/api/initiate-transfer');
    if (isPayoutProcessingFailure(err)) {
      recordPayoutFailure(idempotencyKey, 'PROVIDER_UNAVAILABLE');
    }
    throw err;
  }
}
```

**Rules for `recordPayoutFailure`:**
- Pass only sanitised identifiers (idempotency key, internal reference).
- Never pass account numbers, amounts, names, or any PII.
- Use the error category constants from
  `Dechat/dex_with_fiat_frontend/src/lib/payout/errors.ts`
  (`PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `INTERNAL_ERROR`).

---

## 8. Gate report artifact schema

Every workflow run uploads a `release-health-gate-report-<sha>.json` artifact
(retained 30 days). Schema:

```json
{
  "schemaVersion": "1",
  "ref": "refs/heads/release/v1.2.4",
  "sha": "<commit-sha>",
  "runId": "<actions-run-id>",
  "runAttempt": "1",
  "probedUrl": "https://<deployment>/api/health",
  "thresholds": {
    "maxErrorRate": "0.05",
    "maxPayoutFailures": "3",
    "windowMs": "600000"
  },
  "result": {
    "decision": "HEALTHY",
    "errorRate": "0.0125",
    "payoutFailures": "0",
    "totalRequests": "240",
    "reason": ""
  },
  "generatedAt": "2026-11-19T12:05:00Z"
}
```

---

## 9. Preserving existing financial-safety properties

| Property | How it is preserved |
| --- | --- |
| Idempotency | The gate records failure counts; it never retries or replays transactions. |
| Audit trail | `recordPayoutFailure` feeds the gate only; payout lifecycle events are still written to `PayoutAuditLedger`. |
| No double-spend | The gate blocks further processing on ROLLBACK; it does not cancel in-flight transactions. |
| No PII in artifacts | Gate metrics store counters and sanitised references only — no account data. |
| Circuit breaker independence | `CircuitBreaker` (per-provider, in-process) and `ReleaseHealthGate` (cross-deployment, CI) are independent layers. Both must permit a request for it to proceed. |

---

## 10. Alerting and escalation

| Condition | Immediate action | Escalate to |
| --- | --- | --- |
| ROLLBACK decision in CI | Review job summary, check server logs, initiate §4 | `@release-manager` |
| ROLLBACK override used | Confirm override reason is documented, clear variable after deploy | `@platform-owner`, `@security-owner` |
| Probe timeout (> 5 min no stable verdict) | Check deployment health independently; treat as ROLLBACK | `@platform-owner` |
| Gate report artifact missing | Re-run workflow; if persistent, check Actions storage quota | `@platform-owner` |
