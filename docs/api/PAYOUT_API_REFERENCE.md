# Payout API Reference & Versioning Policy (Issue #101)

## API Versioning Policy
- **Semantic Versioning**: All route contracts adhere to `v1`, `v2` URL prefixes.
- **Breaking Changes**: Changing field types, removing fields, or adding required request headers requires a major version bump.
- **Deprecation**: Deprecated routes remain functional for a minimum of 6 months after formal notice.

## Key Endpoints
1. `POST /v1/payouts/initiate`
   - Requires `Idempotency-Key` header.
   - Body: `InitiatePayoutRequest` with on-chain `txHash`, `contractId`, and fiat recipient details.
2. `GET /v1/payouts/{reference}/status`
   - Returns real-time status mapped from provider webhooks and contract events.

## Payment status event stream
`GET /api/payment-status/stream?sessionId={clientSessionId}` provides payout
updates as Server-Sent Events. Each payout update includes a decimal `id` and
JSON `data` frame, for example:

```text
id: 42
data: {"id":"42","reference":"...","status":"success","updatedAt":"..."}
```

New connections without a cursor receive live updates only. On reconnect,
EventSource sends `Last-Event-ID`; callers may also supply `lastEventId` as a
query parameter. The server replays newer events from a per-session ring of at
most 100 entries. It sends a `: ping` comment every 15 seconds when the stream
is idle and advertises a 3-second reconnect delay.

Each connection buffers at most 100 pending payout events (in addition to the
stream's one-chunk transport buffer). When that queue fills, the server stops
the subscription and drains the bounded queue before closing the stream, so a
slow reader cannot block payout processing or retain a database transaction.
EventSource reconnects automatically. If a cursor predates retained history or
is ahead of the current process cursor, the stream emits `event: resync` with
the current cursor; chat status polling refreshes the active payout.

The cursor and replay ring are process-local and are not durable across
deployments or shared between application instances. A reconnect to an
instance that cannot satisfy the cursor receives `resync`; the existing status
polling path remains the recovery mechanism for the active payout.

## Error Model
Standard RFC 7807 Problem Details are returned for non-2xx responses:
```json
{
  "type": "https://errors.stellar-dex-chat.org/idempotency-conflict",
  "title": "Idempotency Conflict",
  "status": 409,
  "detail": "A payout with this Idempotency-Key was already initiated with different payload parameters."
}
```
