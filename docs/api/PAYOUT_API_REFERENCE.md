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
