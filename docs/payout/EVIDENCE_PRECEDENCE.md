# Payout evidence precedence

Payout status is reconciled from three evidence sources:

1. **Signed webhook** - verified with the provider webhook secret.
2. **Provider status query** - a direct polling response.
3. **Imported statement** - a bank or provider statement.

The precedence order is strict: `signed_webhook > provider_poll > imported_statement`.
When evidence at the same source level conflicts, the newest `observedAt` value
wins. Unverified webhook data is rejected and is never admitted as evidence.

Conflicting evidence is not silently overwritten. The effective status remains
the highest-precedence evidence, and a conflict record is persisted in
`PAYOUT_DATA_DIR/payout_evidence_conflicts.jsonl` and the payout audit ledger.
The record contains the payout reference, effective status, precedence source,
and all submitted evidence for operator review.

Precedence never bypasses payout lifecycle safety. Terminal states (`failed`,
`reversed`, and `cancelled`) remain terminal, and lower-precedence evidence
cannot regress or overwrite a terminal status. Polling and statement evidence
can expose a conflict, but must not bypass monotonic transitions.
