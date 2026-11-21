# Chat History & Model Trace Retention

This document describes how chat history, model traces (prompts/completions), and
evaluation fixtures are stored, redacted, and deleted.

## What is stored

- **Chat history** — user-visible messages persisted per conversation.
- **Model traces** — the prompt/completion pairs sent to and returned from the
  model, stored for debugging and evaluation. Traces are written through a single
  trace-write boundary that applies redaction before persistence.
- **Evaluation fixtures** — synthetic prompt/completion pairs used by regression
  tests. Fixtures MUST be synthetic; never commit credentials or real user data.

## Redaction at the trace-write boundary

Before a trace is persisted, the following are stripped or masked:

- Secrets: API keys, bearer tokens, private keys, and anything matching known
  secret patterns (e.g. `sk-...`, `Bearer ...`, PEM blocks).
- Payout identifiers: bank account / IBAN / routing numbers, wallet addresses,
  and payout reference IDs.

Redaction happens at write time so unredacted values never reach storage. If a
field cannot be classified, it is dropped rather than stored verbatim.

## Retention policy

| Data                | Default retention | Notes                                   |
| ------------------- | ----------------- | --------------------------------------- |
| Chat history        | 90 days           | User-visible; deletable on request.     |
| Model traces        | 30 days           | Redacted at write; deletable by user/session. |
| Evaluation fixtures | Indefinite        | Synthetic only; reviewed on change.     |

Retention windows are configuration-driven; operators may shorten them. Expired
records are purged by the retention job.

## Deletion behavior

Traces can be deleted by **user** or by **session**:

- `DELETE` by user removes all traces belonging to that user.
- `DELETE` by session removes all traces for a single session.

Edge cases:

- **Authorization** — a caller may only delete traces they own; cross-user
  deletion is rejected.
- **Not found** — deleting a user/session with no traces is a no-op success
  (idempotent), so retries are safe.
- **Recovery** — deletion is permanent; there is no soft-delete restore path for
  traces. Chat history deletion follows the same rules.

## Tests

Focused regression tests cover:

- Normal path: trace written, redacted, and retrievable.
- Redaction: secrets and payout identifiers never appear in stored traces.
- Deletion by user and by session.
- Authorization failure: cross-user deletion is rejected.
- Recovery: deleting a non-existent user/session is an idempotent no-op.

All fixtures are synthetic; no credentials or real user data are used.
