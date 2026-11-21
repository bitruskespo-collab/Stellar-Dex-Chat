# Dead-Letter Replay Runbook

Scope: operator replay of exhausted payout **dead-letter** jobs in the
DEX-with-fiat payout service. A dead-letter job is a provider transfer that
exhausted its automatic retry budget and was parked for manual review.

> Goal: replay a dead-letter job as a **bounded, audited, idempotent operator
> action** — preview the affected records, record a reason, reuse the original
> idempotency key, and record the operator plus the resulting provider state.
> The replay **must never cause a duplicate transfer**.

## 1. Why replay is operator-only and bounded

Automatic retries run unattended until the configured `maxAttempts` budget is
exhausted. After that the job moves to `dead_letter` and **stops** — it is not
retried again until an operator explicitly replays it. This bounds the
automatic retry blast radius and forces a human to confirm the underlying
failure (for example, a rotated provider key, a corrected recipient, or a
provider-side outage) is resolved before any further provider call.

Replay is **single-job and preview-first**. There is no bulk "replay all"
action: each replay targets one job, is previewed first, and requires a
non-empty reason. This keeps every replay attributable and reviewable.

## 2. Idempotency and financial safety

A replay preserves the job's **original idempotency key**. The retry queue
reuses that key for every provider call, so the payment provider deduplicates
on it. Replaying a job therefore cannot create a second transfer for the same
payout, even if the original call had partially succeeded at the provider.

The operator action is itself idempotent at the state-machine level: only a
job in `dead_letter` status can be replayed. A second replay of the same job
(after the first replay moved it to `pending`) is rejected with a `400`, not
applied a second time. There is no path from replay to a duplicate provider
call.

## 3. Replay workflow

The workflow is a deliberate, two-step confirm-then-commit flow:

1. **Preview (dry run).** `POST /api/admin/payout-retry` with
   `{ "jobId": "<id>", "action": "preview" }`. Returns the records the replay
   would touch — the retry job, the payout intent, and the idempotency record
   (the original key that will be reused) — plus an `eligible` flag. The
   preview does **not** mutate any state, so it is safe to run repeatedly.
   A non-`dead_letter` job is returned as `eligible: false` with a reason.

2. **Confirm with a reason.** `POST /api/admin/payout-retry` with
   `{ "jobId": "<id>", "action": "replay", "actor": "operator:<handle>",
   "reason": "<why this is safe>" }`. The `reason` field is **required** and
   must be non-empty; a missing or blank reason is rejected with `400` and the
   job is left untouched. The job is rescheduled for immediate execution and
   reuses its original idempotency key.

Both endpoints require admin authentication (the `x-admin-token` header,
`Authorization: Bearer <token>`, or a valid `admin_session` cookie).

## 4. Audit trail

Every successful replay appends an immutable `dead_letter_replayed` event to
the append-only payout audit ledger, recording:

- **Operator** — the `actor` that performed the replay.
- **Reason** — the operator-supplied justification.
- **Original idempotency key** — the provider dedupe key that was reused.
- **Resulting provider state** — the job's resulting status (`pending`) and the
  scheduled `nextRunAt`.

Query the ledger with `GET /api/admin/payout-audit?action=dead_letter_replayed`
or filter by `payoutId` / `actor`. The ledger is append-only and
cryptographically chained; it cannot be edited or deleted.

## 5. Boundary and failure cases

| Case | Behavior |
| --- | --- |
| Unknown `jobId` | `400` — `Retry job not found: <jobId>`. No state change. |
| Job not in `dead_letter` (e.g. still `pending`/`completed`) | `400` — `Only dead-letter jobs can be replayed. Current status: <status>`. Keeps the action idempotent; no second provider call. |
| Missing or blank `reason` | `400` — `Missing required field: reason` (API) / throws in the library. Job stays `dead_letter`; no audit event is written. |
| Unsupported `action` | `400` — `Unsupported action. Supported actions: preview, replay`. |
| Unauthenticated request | `401`. No state change. |
| Preview of an unknown job | `400` — `Retry job not found`. Preview never mutates state. |

## 6. Inspection (read-only)

- List dead-letter jobs: `GET /api/admin/payout-retry?status=dead_letter`.
- List all retry jobs (optionally filtered by status):
  `GET /api/admin/payout-retry?status=<status>`.

## 7. Operational notes

- Fix the underlying failure **before** replaying. Replaying a job whose root
  cause is unresolved will exhaust its budget again and return to dead-letter.
- Record a meaningful `reason` — for example, "Provider API key rotated;
  original transfer never reached the provider." Future operators and auditors
  rely on this field.
- Replays use the original idempotency key; never invent a new key for a
  replay, and never edit the key on a dead-letter job.
