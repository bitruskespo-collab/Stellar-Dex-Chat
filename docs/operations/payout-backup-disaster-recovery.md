# Payout Backup & Disaster Recovery Runbook

Scope: durable payout state — payout **intents**, **idempotency records**, and **audit history** — for the DEX-with-fiat payout service. This runbook defines objectives, backup ownership/retention, restore permissions, reconciliation-before-write, and the drill/remediation process.

> Goal: restore durable payout and audit data **without replaying transfers** and **without losing reconciliation capability**.

## 1. Recovery objectives

| Data class | Examples | RPO (max data loss) | RTO (max downtime) |
| --- | --- | --- | --- |
| Payout intents | intent rows, state machine transitions, provider refs | 5 min | 60 min |
| Idempotency records | request keys, dedupe/response cache | 5 min | 60 min |
| Audit history | append-only audit log, actor/action/timestamp | 0 (no loss) | 120 min |

- **RPO** is measured from the last durable commit to the last recoverable backup/PITR point.
- **RTO** is measured from incident declaration to writes resuming after reconciliation.
- Audit history is treated as **zero-loss**: it must be recoverable to the latest committed entry; if a gap is detected, writes stay paused until the gap is explained and closed.

## 2. Backup ownership, retention, and encryption

- **Owner:** Payout Platform on-call (primary), Infrastructure on-call (secondary). Escalation via the standard incident channel.
- **Encryption:** all backups encrypted at rest (KMS-managed keys) and in transit (TLS). Keys are owned by the security team; the payout service holds **no** long-lived decryption keys.
- **Retention:**
  - Continuous PITR window: **7 days**.
  - Daily full snapshots: **35 days**.
  - Monthly archives (audit history): **13 months**.
- **Dependencies:** managed database PITR/snapshot service, KMS key availability, object storage bucket, and the audit-log sink. Each dependency has its own owner and is listed in the service dependency register.

## 3. Restore permissions

- Restore into a **non-production, isolated** environment requires the `payout-restore` role (break-glass, time-boxed, audited).
- Promotion of a restored dataset to production requires **two-person approval** (Payout Platform lead + Security).
- All restore actions are logged to the audit sink with actor, target snapshot, and justification.

## 4. Restore procedure (into isolation)

1. Declare the incident and freeze payout writes (feature flag / kill switch).
2. Provision an isolated restore target; never restore over the live primary.
3. Restore the latest snapshot/PITR point into isolation.
4. Verify integrity (Section 5) **before** any write resumes.
5. Reconcile against authoritative providers and chain state (Section 6).
6. Obtain two-person approval, then promote and resume writes.

## 5. Restore validation (in isolation)

- **Counts:** intent counts by state, idempotency record counts, and audit entry counts match the pre-incident baseline within the RPO window.
- **Audit continuity:** audit log is append-only and gap-free across the restore boundary; no reordering or mutation of prior entries.
- **Idempotency:** replaying a known request key returns the original stored response and does **not** create a new transfer.
- **In-flight transfers:** every intent in a non-terminal state is enumerated and matched to a provider/chain reference (Section 6).

## 6. Reconciliation before writes resume

Restored records are **not** authoritative. Before writes resume, reconcile each restored record against the source of truth:

- **Provider state:** query the payment provider for each in-flight intent; compare status, amount, and provider reference. Resolve mismatches in favor of the provider.
- **Chain state:** for on-chain legs, confirm transaction hash, confirmations, and finality against the chain; resolve mismatches in favor of the chain.
- **Idempotency:** confirm no restored idempotency key would allow a duplicate transfer; any ambiguous key is quarantined and reviewed.
- **Audit:** confirm the restored audit history is a superset of provider/chain events; unexplained gaps block resumption.

Writes resume only when every in-flight intent is reconciled to a terminal or explicitly-tracked state and no duplicate-transfer risk remains.

## 7. Drill schedule and remediation tracking

- **Cadence:** full restore drill **quarterly**; tabletop walkthrough **monthly**.
- **Drill scope:** restore into isolation, run Section 5 validation, run Section 6 reconciliation, and record measured RPO/RTO against the objectives in Section 1.
- **Remediation tracking:** every drill produces findings with an owner and due date, tracked in the ops issue tracker. Findings that miss an objective block the next release until resolved or explicitly waived by the Payout Platform lead.
- **Evidence:** each drill records the snapshot used, measured RPO/RTO, reconciliation results, and remediation items.
