# Provider circuit-breaker operation isolation

Circuit breakers are keyed by both provider name and payout operation. The
supported operations are:

- `account_verification`
- `recipient_creation`
- `transfer_initiation`
- `status_query`
- `transfer_cancellation`

A provider outage only opens the breaker for the operation that observed it.
For example, status-query failures do not block account verification or recipient
creation. Permanent 4xx provider rejections do not trip an operation breaker.

Each operation independently follows `CLOSED -> OPEN -> HALF_OPEN -> CLOSED`.
Its cooldown and probe state are reported in `/api/health` under
`providerCircuits`. This output contains provider, operation, state, counts,
timestamps, and cooldown data only; it does not expose credentials or customer
data.
