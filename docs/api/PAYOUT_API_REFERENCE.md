# Payout API Reference & Versioning Policy

## API Versioning Policy
- **Semantic Versioning**: All route contracts adhere to `v1`, `v2` URL prefixes.
- **Breaking Changes**: Changing field types, removing fields, or adding required request headers requires a major version bump.
- **Deprecation**: Deprecated routes remain functional for a minimum of 6 months after formal notice.
- **Transport version**: Clients may set `X-API-Version: v1`. The header is optional for backward compatibility; missing headers select v1.
- **Incompatible versions**: Unsupported versions return HTTP 406 with `UNSUPPORTED_API_VERSION` in `body.error.code`.
- **Current success envelope**: `{ "version": "v1", "success": true, "data": ... }`. Legacy `success` and `data` fields remain present.
- **Deprecated schema removal**: No v1 field may be removed until the deprecation notice has remained active for at least 6 months and compatibility tests have passed.

## Current application endpoints

### `POST /api/fx-quote`

Request a server-priced, short-lived NGN payout quote:

```json
{ "tokenSymbol": "XLM", "tokenAmount": 10, "currency": "ngn" }
```

The response contains a `quoteId`, opaque signed `quoteToken`, exact decimal
exchange rate, rounded `fiatAmountMinorUnits`, rounding policy, provider
request/response identifiers, source, and `expiresAt`. The token amount and
exchange rate are canonicalized and the final amount is rounded half-up to
the currency's minor unit. Quotes expire after two minutes. Clients must use
the quoted amount and request a new quote after expiry; they must not calculate
or edit the payout value locally.

### `POST /api/initiate-transfer`

Requires an `X-Idempotency-Key` header. The request must include `amount`,
`currency`, `quoteId`, and the corresponding signed `quoteToken`, in addition
to the payout source and recipient. The server verifies the signature,
expiration, quote identifier, currency, precision, and exact minor-unit amount
before contacting the provider. The provider receives the canonical decimal
amount derived from those verified minor units.

The append-only `fx_quote_created`, `payout_initiated`, and
`payout_provider_accepted` audit events link the quote to the idempotency key,
provider reference, provider transfer ID/code, and final transfer amount and
currency. The signed token itself is not written to the audit ledger.

## Beneficiary verification and authorization
- The payout UI establishes wallet identity by signing `authenticate:<wallet-address>:<timestamp>` with Freighter and posting the signature, address, and timestamp to `POST /api/auth/wallet-session`. The timestamp must be within five minutes. The endpoint returns a short-lived bearer session token and CSRF token and sets the session in an HttpOnly cookie.
- Browser clients send the bearer token as `Authorization: Bearer <sessionToken>` and the returned CSRF token as `X-CSRF-Token` on payout mutations. A wallet address supplied without a valid signature/session is not an identity credential.
- `POST /api/verify-account` requires a server-verified wallet session. On success it returns the verified account name, a masked account number, an opaque `verificationToken`, and its expiry; full account and bank identifiers are never returned.
- `POST /api/create-recipient` also requires the authenticated wallet session and the `verificationToken`. The signed token expires after five minutes and is bound to the wallet identity, account number, bank code, currency, and provider-verified account name. Changing any of these details requires a new verification.
- Missing/invalid authorization returns `BENEFICIARY_VERIFICATION_REQUIRED`; expired authorization returns `BENEFICIARY_VERIFICATION_EXPIRED`; mismatched details return HTTP 409 with `BENEFICIARY_DETAILS_CHANGED`.
- Client-supplied user IDs/scopes do not establish beneficiary ownership. Beneficiary deduplication and recovery are scoped to the authenticated wallet.
- Configure the same random `BENEFICIARY_DEDUPE_SECRET` on every production application instance. Keep it in the deployment secret manager; rotating it invalidates outstanding verification tokens.
- Verification tokens are self-contained and stateless so verification and recipient creation can be served by different application instances. They contain only keyed fingerprints, not account details.

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

### Provider circuit isolation
Circuit health is isolated by provider and operation:

- `account_verification`
- `recipient_creation`
- `transfer_initiation`
- `status_query`
- `transfer_cancellation`

An outage in one operation does not open circuits for another operation.
Health metrics are available in `GET /api/health` under `providerCircuits`.
Provider outage responses remain `503` with `Retry-After` and `PROVIDER_OUTAGE`;
the same provider operation may enter `HALF_OPEN` independently after cooldown.

### Evidence reconciliation
`POST /api/admin/reconciliation` polls stale pending payouts. Its response includes
`conflicts` and per-payout outcomes. `GET /api/admin/reconciliation?format=report`
returns reconciliation records and includes persisted evidence conflicts for
authorized operators.

The effective status follows the documented [payout evidence precedence model](../payout/EVIDENCE_PRECEDENCE.md).
An evidence conflict is persisted for review; it does not silently replace the
highest-precedence status.

### Escrow liability parity

`GET /api/admin/liability-parity` is a read-only check that compares outstanding
on-chain escrow receipts with active persisted payout reservations. Results are
grouped by asset and receipt and include `AMOUNT_MISMATCH`,
`MISSING_RESERVATION`, `MISSING_LIABILITY`, `DUPLICATE_RESERVATION`,
`INVALID_RECORD`, and `SOURCE_TRUNCATED` mismatch types. The response includes
`readOnly: true` and `correctionsApplied: 0` and never changes payout or contract
state.

`POST /api/admin/liability-parity` accepts a JSON snapshot with `liabilities`,
`reservations`, optional `assetAliases`, and optional `filters`. It runs the same
comparison without reading the live contract or reservation ledger, which makes
it suitable for fixtures and incident replay. Both routes require admin
authentication and the admin IP allowlist. See the
[liability parity runbook](../runbooks/liability-parity.md) for response fields
and investigation steps.

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

Payout routes retain the legacy `message` field and include a stable machine
code in `error.code`. Quote-related failures include `FX_QUOTE_REQUIRED`
(428), `FX_QUOTE_EXPIRED` (410), `FX_QUOTE_MISMATCH` (409),
and `FX_QUOTE_UNAVAILABLE` (503). Reusing an idempotency key with different
request details returns `IDEMPOTENCY_CONFLICT` (409). A client must obtain a
fresh quote after expiration and must not retry a modified request with an
already-used idempotency key.

Clients must branch on `error.code` (and HTTP status), never on the English
`message` string. The frontend maps those stable codes to locale resources via
`src/lib/localizedErrors.ts`; translations may change the wording but not the
code, retryability, or safety decision. See
[transaction-locale-contract.md](../../Dechat/dex_with_fiat_frontend/docs/transaction-locale-contract.md)
for the contributor contract.
