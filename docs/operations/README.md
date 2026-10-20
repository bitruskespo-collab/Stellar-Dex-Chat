# Operations Runbook

Operational procedures for the DEX-with-fiat payout stack. This document covers
observability, alerting, and — per issue #122 — backup and disaster recovery
(DR) rehearsal for durable payout state.

## Scope of durable payout state

The following data is considered authoritative payout state and MUST be covered
by backup and DR procedures:

| Data class | Description | Source of truth |
| --- | --- | --- |
| Payout intents | Requested transfers, amounts, recipients, status | Application DB |
| Idempotency records | Keys mapping client requests to intents | Application DB |
| Audit history | Append-only log of state transitions and approvals | Application DB / audit store |
| Chain state | On-chain transfer confirmations | Chain (external) |
| Provider state | Fiat payout status from payment providers | Provider APIs (external) |

## Recovery objectives

Recovery-point objective (RPO) is the maximum acceptable data loss measured in
time. Recovery-time objective (RTO) is the maximum acceptable time to restore
service.

| Data class | RPO | RTO | Notes |
| --- | --- | --- | --- |
| Payout intents | 5 minutes | 60 minutes | Continuous WAL archiving required |
| Idempotency records | 5 minutes | 60 minutes | Must be restored with intents to preserve dedupe |
| Audit history | 0 (no loss) | 120 minutes | Append-only; restore must preserve ordering |
| Chain state | N/A (external) | N/A | Reconciled from chain, never restored from backup |
| Provider state | N/A (external) | N/A | Reconciled from provider APIs |

Idempotency records and payout intents MUST be restored from the same recovery
point. Restoring them from different points can cause duplicate transfers or
lost dedupe guarantees.

## Backup ownership, retention, and encryption

- **Ownership:** The platform on-call engineer owns backup execution and
  integrity. The security team owns key management.
- **Encryption:** All backups are encrypted at rest with a KMS-managed key.
  Backups are encrypted in transit (TLS) during upload and download.
- **Retention:**
  - Payout intents and idempotency records: 35 days of point-in-time recovery.
  - Audit history: 7 years, immutable/WORM storage.
  - Weekly full backups retained for 90 days.
- **Restore permissions:** Restore access is limited to the `payout-restore`
  role. Access requires break-glass approval from two engineers and is logged.
- **Dependencies:** Restore depends on KMS key availability, the backup object
  store, and network access to the isolated restore environment. Document and
  test these dependencies during each drill.

## Restore procedure

1. Declare an incident and freeze all payout writes.
2. Provision an isolated restore environment (no production write access).
3. Restore payout intents, idempotency records, and audit history from the
   selected recovery point.
4. Verify counts and audit continuity (see validation below).
5. Reconcile against authoritative providers and chain state.
6. Only after reconciliation passes, resume writes and lift the freeze.

## Reconciliation before writes resume

Restored records MUST be reconciled against authoritative external state before
any writes resume. Never replay transfers to reconstruct state.

- **Chain state:** For each restored intent marked as submitted/confirmed,
  query the chain for the corresponding transaction. Mark intents as confirmed
  only if the chain confirms them; flag mismatches for manual review.
- **Provider state:** For each restored intent, query the payment provider for
  the authoritative status. Reconcile provider status against the restored
  intent status and record discrepancies.
- **Idempotency:** Confirm every idempotency key maps to exactly one intent and
  that no key is missing or duplicated.
- **In-flight transfers:** Identify intents that were in-flight at the recovery
  point and reconcile each against both chain and provider before resuming.

Writes resume only when all discrepancies are resolved or explicitly waived by
an incident commander with a documented rationale.

## Validation checklist

Run after every restore, in the isolated environment:

- [ ] Row counts for intents, idempotency records, and audit entries match the
      expected recovery point within tolerance.
- [ ] Audit history is continuous: no gaps in sequence numbers or timestamps.
- [ ] Idempotency keys are unique and each maps to one intent.
- [ ] In-flight transfers are reconciled against chain and provider state.
- [ ] No duplicate transfers would result from resuming writes.

## Drill schedule and remediation tracking

- **Cadence:** Full DR drill quarterly; tabletop reconciliation exercise
  monthly; backup integrity check weekly (automated).
- **Participants:** Platform on-call, security, and a payments engineer.
- **Outputs:** Each drill produces a report with RPO/RTO achieved, discrepancies
  found, and action items.
- **Remediation tracking:** All action items are filed as tracked issues with an
  owner and due date. Open remediation items are reviewed at the start of each
  subsequent drill; a drill is not considered closed until prior action items
  are resolved or explicitly re-scoped.
