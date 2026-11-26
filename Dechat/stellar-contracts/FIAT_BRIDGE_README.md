# FiatBridge Contract

A Soroban smart contract implementing a fiat-to-crypto bridge with deposit receipts, withdrawal queues, daily volume limits, oracle-based fiat caps, and a timelock admin system.

---

## Architecture Diagram

The diagram below illustrates the complete flow through the contract, split into the **user path** and the **admin path**.

```mermaid
flowchart TD
    subgraph USER["User Path"]
        U1([User]) -->|"deposit(from, amount, token, reference)"| D1[Validate:\ncooldown · allowlist\ntoken whitelist · limits]
        D1 -->|pass| D2[Transfer tokens → contract]
        D2 --> D3[Emit Receipt + ReceiptIndex]
        D3 --> D4[(Storage:\nReceipt\nReceiptCounter\nUserDeposited\nTokenRegistry)]
    end

    subgraph WITHDRAW["Withdrawal Queue Path"]
        W1([Admin]) -->|"request_withdrawal(to, amount, token)"| W2[Create WithdrawRequest\nwith unlock_ledger]
        W2 --> W3[(Storage:\nWithdrawQueue(id))]
        W3 -->|"execute_withdrawal(id, partial?)"| W4{ledger ≥\nunlock_ledger?}
        W4 -->|No| W5[❌ WithdrawalLocked]
        W4 -->|Yes| W6[Transfer tokens → recipient]
    end

    subgraph ADMIN["Admin Path"]
        A1([Admin]) -->|set_operator / transfer_admin| A2[queue_admin_action\nwith ≥48h delay]
        A2 --> A3[(QueuedAdminAction)]
        A3 -->|execute_admin_action| A4{ledger >\ntarget_ledger?}
        A4 -->|No| A5[❌ ActionNotReady]
        A4 -->|Yes| A6[Execute & record LastAdminActionLedger]

        A1 -->|accrue_fee| AF1[set_fiat_limit\nset_oracle]
        A1 -->|withdraw_fees| WF1["withdraw(to, amount, token)"]
    end

    D4 -.->|ReceiptCounter| W1
```

---

## Withdrawal Queue Scheduling

Pending requests are indexed in global and risk-tier linked queues. Settling,
cancelling, or reclaiming a request removes its links with bounded work. The
admin scheduler examines at most `MAX_RISK_TIER + 1` tier heads. With
`age_intervals = floor(age_ledgers / 720)`, its score is
`effective_tier * 33 + 32 - min(age_intervals, 32)`, where
`effective_tier = max(0, risk_tier - age_intervals)`. Lower scores go first;
ties are ordered by enqueue ledger and request ID. The score is bounded by
1,088. Aging changes scheduling only:
timelocks, authorization, denylist, circuit-breaker, and solvency checks still
apply when funds move.

`get_withdrawal_queue_page(cursor, limit)` returns pending requests in request-ID
order. `limit` must be between 1 and 100, and `next_cursor` is the continuation
cursor. For existing deployments, call
`migrate_withdrawal_queue_index(cursor, limit)` as admin until it returns
`None`; each call scans at most 25 request IDs. Queue mutations return
`QueueIndexMigrationRequired` until this backfill completes.

New requests are bounded by `MAX_WITHDRAWAL_QUEUE_DEPTH` (100) active entries.
A full queue returns `QueueLimitReached` before request IDs, rate-limit usage,
or queue indexes are changed.

## Oracle Availability and Token Retirement

`get_oracle_health(token)` provides an O(1) diagnostic view that reports whether
the configured observation is valid, missing, stale, future-dated, low
confidence, or unavailable. The view and other non-price-sensitive reads remain
available when the oracle is unhealthy. Deposits with a fiat cap or an expected
price, and withdrawals with an expected price, use the timestamped
`ObservationOracle` interface and fail closed with distinct oracle errors.
Price-only oracle integrations must implement `get_observation` before being
used for those operations.

`set_token_deposits_enabled(token, false)` stops new deposits without blocking
withdrawal requests or settlement for that asset.
`get_token_retirement_readiness(token)` reports the bounded conditions for
removal: deposits must be disabled, liabilities and net deposited value must
both be zero, no fees may remain, escrow migration must be complete when there
are receipts, the fee remainder must be zero, and the token cannot be the
default asset. Removed token addresses cannot be registered again.
`remove_token(token)` enforces those conditions and otherwise returns
`TokenNotRetirable`.

## Scoped Emergency Pauses

`set_pause_scope(scope, paused)` independently controls deposits, new withdrawal
requests, withdrawal execution, or admin/fee transfers. `get_pause_state()`
reports these flags and the legacy global pause. Scoped pauses do not disable
read-only views, queue cancellation, expiry reclamation, or token recovery.
Pause checks do not bypass or replace the contract's other authorization and
solvency checks.

---

## Circuit Breaker and Oracle Recovery

The FiatBridge combines a global rolling withdrawal breaker with a
permissionless oracle-health trip.

### What it watches and blocks

- Successful `withdraw` and `execute_withdrawal` calls contribute to the rolling
  total in `GlobalDailyWithdrawn { amount, window_start }`. The default window
  is 24 hours (`WINDOW_LEDGERS`).
- Once a successful withdrawal brings the total to or above the configured
  threshold, that transaction completes and the breaker trips. Subsequent
  protected operations are rejected.
- `check_oracle_health(token)` is permissionless and records an oracle-failure trip
  when the versioned adapter cannot return a fresh, accepted aggregate. It
  returns `false`, emits `OracleFailureTripEvent` with the oracle/token/ledger,
  and moves no funds.
- The breaker blocks `withdraw`, `request_withdrawal`, `execute_withdrawal`,
  `heartbeat`, and selected admin changes such as `set_limit`. Read-only views
  remain available; cancellations and emergency recovery keep their existing
  independent authorization and solvency checks.

### How reset works

- Admin may clear a volume-only trip with `reset_circuit_breaker()`.
- An oracle-failure trip can only be manually or automatically cleared after a
  fresh, valid aggregate is available from the versioned adapter. Configure it
  with `set_oracle_adapter`; legacy `set_oracle` sources are not recovery
  evidence.
- The reset window defaults to 48 hours; `u32::MAX` disables auto-reset.
- Every reset restarts the rolling withdrawal window and emits the existing
  reset event. Auto-reset of an oracle-failure trip also rechecks oracle health.

## Versioned multi-source oracle adapter

`OracleAdapter` accepts up to nine distinct source contracts implementing
`VersionedOracleSource::get_observation`. Version 1 observations include a
positive price, its decimal precision, recording ledger, and confidence. The
adapter excludes stale, future-dated, low-confidence, and invalid observations;
normalizes accepted prices to seven decimal places; requires the configured
minimum source count; enforces the maximum spread in basis points; and returns
the median using checked arithmetic. Unsupported source versions fail with a
stable adapter error.

`OracleAdapterConfig` consists of `max_age_ledgers`, `min_confidence`,
`min_sources`, and `max_spread_bps`. Source lists are capped at nine distinct
addresses. Use `init(admin, sources, config)` to create the adapter, then
`set_sources` or `set_config` for authenticated updates. `get_aggregated_price`
returns a typed adapter error; `get_price` is the `Option<i128>` compatibility
interface.

Use FiatBridge's `set_oracle_adapter` to preserve distinct errors for too few
sources, excessive spread, and unsupported versions. The adapter's `get_price`
method remains available for integrations using the compatibility interface.

## Fiat-volume valuation policy

Fiat-volume limits are charged at **deposit time**. Each deposit made while a
fiat cap is enabled
persists its token amount and precision, oracle address/adapter version,
accepted price, calculated USD cents, ledger, active limits, rolling-window
length, and before/after user/global totals under the receipt ID. Retrieve this
immutable record with `get_receipt_fiat_valuation`. Later price or limit changes
cannot retroactively change the cap decision. Failed transfers and balance
checks roll back the volume update and valuation record atomically.

### Operational guidance

- Use the breaker as a **system-wide safety rail**, not as a user-specific rate limiter.
- Keep the threshold high enough to tolerate normal batched withdrawals but low enough to catch runaway operator or automation behavior.
- If the breaker trips unexpectedly, inspect recent withdrawal and heartbeat activity before manually resetting it.
## Admin Authentication Architecture

Admin privileges in the FiatBridge are strictly tied to the on-chain state. The architecture ensures that no front-end spoofing or bypassed routing can escalate privileges.

1. **Root of Trust**: The admin address is established during `init` and stored directly in the contract's instance storage (`DataKey::Admin`).
2. **Authorization**: Any administrative operation (e.g., `withdraw`, `set_limit`) requires a cryptographic signature matching the stored admin address. This is enforced by `require_auth` at the Soroban SDK level.
3. **Frontend Integration**: The Next.js frontend fetches the true admin address by calling `get_admin()` directly on the smart contract before displaying admin UI components or authorizing admin routes. 

### Multisig Policy Snapshots (Issue #174)

Each `MultisigProposal` and `SignerRotationProposal` records an immutable snapshot of the active multisig policy at creation time (`policy_version`, `policy_signers`, `policy_threshold`). `MultisigPolicyVersion` starts at `1` during `init` and increments monotonically whenever `execute_signer_rotation` applies a signer-set or threshold change.

- **Approval & Execution Binding**: `approve_multisig_action`, `execute_multisig_action`, `approve_signer_rotation`, and `execute_signer_rotation` verify that the active policy version, signer set, and threshold still match the proposal's bound snapshot (`Error::PolicyVersionMismatch` otherwise).
- **No Cross-Rotation Reinterpretation**: Approvals gathered under an earlier policy version cannot be carried over or reinterpreted after a rotation, even if a later rotation restores the same signers and threshold. Pending proposals from prior versions must be re-proposed under the active policy.
- **Query Views**: `get_multisig_policy_version()` returns the active monotonic policy version (`0` if uninitialized), and `get_multisig_policy_snapshot()` returns `Option<MultisigPolicySnapshot>`.

---

## Recovery, History, and Token Accounting

### Delayed Admin Recovery

Configure an independent recovery address using `set_emergency_recovery` before
the admin key is lost. After the configured inactivity threshold, the recovery
address calls `propose_admin_recovery(successor)`. The proposed successor must
authorize `execute_admin_recovery()` after the 48-hour timelock. Any intervening
admin-authenticated action invalidates the proposal. `AdminRecoveryProposedEvent`
and `AdminRecoveryExecutedEvent` record the proposal and completed transfer.
This recovery path does not change the standard `transfer_admin` /
`accept_admin` flow.

### Historical Pagination

`get_receipts_page_after(after_cursor, limit)` and
`get_completed_withdrawals_page(after_cursor, limit)` use exclusive cursors:
pass `None` for the first page, then pass the returned `next_cursor` to continue.
The cursor represents the last sequence/request ID examined. Each call examines
at most `limit` IDs (`1..=MAX_AUDIT_PAGE_SIZE`); pruned or unavailable records
are skipped while the cursor still advances, preventing gaps from causing an
unbounded scan.

### Per-Token Escrow Accounting

`get_token_escrow_accounting(token)` reports the token balance decomposition:

`token_balance = user_assets + fee_liability + unassigned_dust`

`pending_withdrawal_liability` is a subset of `user_assets`. Deposits,
withdrawals, and partial withdrawals are accounted in the token's smallest
unit, so partial transfers introduce no additional rounding. Fee rounding
residue is retained per token as a numerator over 10,000 in `FeeRemainder`;
it becomes a whole smallest unit only when later deposits complete the
fraction. The view reports token precision and fails if liabilities are
underfunded rather than returning a misleading decomposition.

---

## Error Code Reference

All errors are returned as `Result<_, Error>` variants. The contract uses a flat numbering scheme starting at 1.

| Code | Variant | Series | Description | Returned By |
|------|---------|--------|-------------|-------------|
| 1 | `NotInitialized` | Initialization | Contract has not been initialized (no admin set) | `withdraw`, `request_withdrawal`, `cancel_withdrawal`, `set_limit`, `set_cooldown`, `set_lock_period`, `transfer_admin`, `set_oracle`, `set_fiat_limit`, `queue_admin_action`, `execute_admin_action`, all view fns |
| 103 | `InternalError` | Initialization | Internal contract error (e.g. integer overflow) | `deposit`, `request_withdrawal`, `execute_withdrawal` |
| 2 | `AlreadyInitialized` | Initialization | `init` was called on a contract already initialized | `init` |
| 3 | `Unauthorized` | Auth | Caller is not the contract admin | (reserved; auth enforced via `require_auth`) |
| 4 | `ZeroAmount` | Amount Validation | Amount is ≤ 0, or `init` called with `limit ≤ 0` | `init`, `deposit`, `withdraw`, `request_withdrawal`, `execute_withdrawal` |
| 5 | `ExceedsLimit` | Amount Validation | Deposit amount exceeds per-token deposit limit | `deposit` |
| 6 | `InsufficientFunds` | Amount Validation | Contract balance is too low to fulfill the withdrawal | `withdraw`, `execute_withdrawal` |
| 7 | `WithdrawalLocked` | Withdrawal | Withdrawal request has not yet reached its unlock ledger | `execute_withdrawal` |
| 8 | `RequestNotFound` | Withdrawal | No withdrawal request exists for the given ID | `execute_withdrawal`, `cancel_withdrawal` |
| 9 | `TokenNotWhitelisted` | Token | Token address has no entry in the token registry | `deposit`, `set_limit` |
| 10 | `ReferenceTooLong` | Input Validation | Reference bytes exceed `MAX_REFERENCE_LEN` (64 bytes) | `deposit` |
| 11 | `DailyLimitExceeded` | Rate Limiting | User's per-token daily deposit accumulator has exceeded the configured limit | `deposit` (via `enforce_daily_deposit_limit`) |
| 12 | `CooldownActive` | Rate Limiting | User deposited too recently; cooldown period has not elapsed | `deposit` |
| 13 | `NotAllowed` | Access Control | Allowlist is enabled and caller is not on it | `deposit` |
| 305 | `ExceedsFiatLimit` | Oracle | Deposit would push user's rolling USD-cent volume above the fiat cap | `deposit` (via `validate_fiat_limit`) |
| 405 | `TokenInterfaceInvalid` | Token | Required token balance or decimal query failed or returned unsupported precision | Token interaction |
| 701 | `OracleNotSet` | Oracle | Oracle address is not configured | `deposit` (via `validate_fiat_limit`) |
| 702 | `OraclePriceInvalid` | Oracle | Oracle returned a non-positive price | `deposit` (via `validate_fiat_limit`) |
| 705 | `OracleObservationMissing` | Oracle | No usable oracle observation was returned | `deposit` |
| 706 | `OracleObservationStale` | Oracle | Oracle observation exceeds the configured age | Oracle validation |
| 707 | `OracleObservationFutureDated` | Oracle | Oracle observation is dated after the current ledger | Oracle validation |
| 708 | `OracleConfidenceTooLow` | Oracle | Oracle observation confidence is below the configured threshold | Oracle validation |
| 709 | `OracleConfigInvalid` | Oracle | Oracle configuration is invalid or an adapter is required for health recovery | Oracle configuration |
| 710 | `FiatConversionOverflow` | Oracle | Fiat conversion exceeded safe integer arithmetic bounds | `deposit` |
| 711 | `OracleSpreadTooWide` | Oracle | Accepted source prices exceed the configured spread | `deposit` with adapter configured |
| 712 | `OracleSourcesInsufficient` | Oracle | Fewer than the configured minimum number of valid sources responded | `deposit` with adapter configured |
| 713 | `OracleVersionUnsupported` | Oracle | A configured source returned an unsupported observation version | `deposit` with adapter configured |
| 16 | `NoPendingAdmin` | Admin Transfer | `accept_admin` called but no pending admin was set | `accept_admin` |
| 17 | `ActionNotReady` | Timelock | Timelock delay is less than `MIN_TIMELOCK_DELAY`, or execution attempted before `target_ledger` | `queue_admin_action`, `execute_admin_action` |
| 18 | `ActionNotQueued` | Timelock | No queued admin action exists for the given ID | `execute_admin_action` |
| 504 | `QueueIndexMigrationRequired` | Withdrawal Queue | Existing queue index backfill must complete before queue mutations | `request_withdrawal`, `execute_withdrawal`, `cancel_withdrawal`, `finalize_cancellation`, `reclaim_expired_withdrawal` |
| 19 | `NoEmergencyRecoveryAddress` | Emergency | Emergency recovery address has not been set | (reserved for emergency recovery flow) |
| 20 | `InactivityThresholdNotReached` | Emergency | Admin inactivity period has not yet elapsed | (reserved for inactivity-triggered recovery) |
| 21 | `InvalidRecipient` | Withdrawal | Recipient address failed validation | (reserved for future recipient checks) |

### Error Series Summary

| Series | Code Range | Domain |
|--------|-----------|--------|
| Initialization | 1–2 | Contract lifecycle |
| Auth | 3 | Authorization |
| Amount Validation | 4–6 | Amount checks |
| Withdrawal | 7–8 | Queue management |
| Token | 9 | Whitelist |
| Input Validation | 10 | Byte constraints |
| Rate Limiting | 11–12 | Deposit throttling |
| Access Control | 13 | Allowlist |
| Oracle | 14–15 | Price oracle / fiat limit |
| Admin Transfer | 16 | Two-step admin handover |
| Timelock | 17–18 | Admin action queue |
| Emergency | 19–20 | Inactivity recovery |
| Future / Reserved | 21 | Planned extensions |

---

## CI Doc-Check

A GitHub Actions step validates that the error table stays in sync with the contract source. Add the following to your CI workflow:

```yaml
- name: Check error code docs are up-to-date
  run: |
    # Extract error variant count from lib.rs
    CONTRACT_ERRORS=$(grep -c '= [0-9]\+,' stellar-contracts/src/lib.rs)
    # Extract row count in the error table (lines starting with | followed by a digit)
    DOC_ERRORS=$(grep -cP '^\| \d+' stellar-contracts/FIAT_BRIDGE_README.md)
    echo "Contract errors: $CONTRACT_ERRORS, Documented errors: $DOC_ERRORS"
    if [ "$CONTRACT_ERRORS" != "$DOC_ERRORS" ]; then
      echo "ERROR: Error code count mismatch. Update FIAT_BRIDGE_README.md"
      exit 1
    fi
```

---

## Public Functions

| Function | Auth | Description |
|----------|------|-------------|
| `init(admin, token, limit)` | — | Initialize the contract |
| `deposit(from, amount, token, reference)` | `from` | Deposit tokens and receive a receipt |
| `withdraw(to, amount, token)` | admin | Immediate admin withdrawal |
| `request_withdrawal(to, amount, token)` | admin | Queue a time-locked withdrawal |
| `execute_withdrawal(id, partial?)` | — | Execute a queued withdrawal after unlock |
| `get_withdrawal_queue_page(cursor, limit)` | — | Read pending withdrawals in bounded request-ID pages |
| `get_next_priority_withdrawal()` | — | Select the next request by aging-adjusted risk tier |
| `get_withdrawal_schedule_info(id)` | — | Read age, effective tier, score, and enqueue ledger |
| `cancel_withdrawal(id)` | admin | Cancel a queued withdrawal |
| `set_pause_scope(scope, paused)` | admin | Pause one value-moving path |
| `get_pause_state()` | — | Read global and scoped pause flags |
| `migrate_withdrawal_queue_index(cursor, limit)` | admin | Backfill the bounded pending queue index |
| `set_token_deposits_enabled(token, enabled)` | admin | Enable or disable new deposits without blocking settlement |
| `get_token_retirement_readiness(token)` | — | Read constant-time retirement preconditions |
| `remove_token(token)` | admin | Remove a fully settled, migrated, non-default token |
| `get_oracle_health(token)` | — | Read bounded oracle availability and freshness diagnostics |
| `set_limit(token, limit)` | admin | Update per-token deposit limit |
| `set_limit_max_cap(max_cap)` | admin | Set the global ceiling for future per-token liability limits |
| `get_set_limit_max_cap()` | — | Read the current global per-token limit ceiling |
| `set_daily_deposit_limit(token, limit_per_day)` | admin | Set per-token 24-hour rolling-window deposit limit for users |
| `set_cooldown(ledgers)` | admin | Set per-user deposit cooldown |
| `transfer_admin(new_admin)` | admin | Initiate two-step admin transfer |
| `accept_admin()` | pending admin | Complete admin transfer |
| `set_emergency_recovery(recovery, cap)` | admin | Configure the independent recovery address and transfer cap |
| `propose_admin_recovery(successor)` | configured recovery address | Propose successor after admin inactivity |
| `execute_admin_recovery()` | proposed successor | Complete recovery after delay and explicit authorization |
| `get_admin_recovery_proposal()` | — | Read the pending recovery proposal |
| `get_receipts_page_after(after_cursor, limit)` | — | Read receipt history using bounded exclusive-cursor pages |
| `get_completed_withdrawals_page(after_cursor, limit)` | — | Read settled withdrawals using bounded exclusive-cursor pages |
| `get_token_escrow_accounting(token)` | — | Verify the per-token user/fee/dust balance decomposition |
| `set_operator(operator, active)` | admin | Grant or revoke operator role (with timelock role check) |
| `queue_renounce_admin()` | admin | Queue irreversible admin renounce under timelock |
| `execute_renounce_admin()` | admin | Complete admin renounce after timelock elapses |
| `set_oracle(oracle)` | admin | Set oracle contract address |
| `set_oracle_adapter(oracle)` | admin | Set a versioned multi-source oracle adapter |
| `check_oracle_health(token)` | — | Trip the breaker if the versioned adapter has no healthy price for the token |
| `set_fiat_limit(limit_usd_cents)` | admin | Set daily USD fiat limit |
| `queue_admin_action(type, payload, delay)` | admin | Queue a timelocked admin action |
| `execute_admin_action(id)` | admin | Execute a matured admin action |
| `set_token_allowlist_enabled(token, enabled)` | admin | Enable/disable allowlist for a specific token |
| `add_token_allowlist(token, address)` | admin | Add address to token-specific allowlist |
| `remove_token_allowlist(token, address)` | admin | Remove address from token-specific allowlist |
| `get_daily_deposit_record(user)` | — | Get 24h fiat deposit volume for a user |
| `get_receipt_fiat_valuation(receipt_id)` | — | Read the immutable deposit-time fiat valuation record |
| `get_multisig_policy_version()` | — | Read the current monotonic multisig policy version |
| `get_multisig_policy_snapshot()` | — | Read the active multisig policy snapshot (`version`, `signers`, `threshold`) |

---

# FiatBridge Contract — Integrator Reference

## Receipt IDs

### Current Type: `BytesN<32>`

Receipt IDs are deterministic **32-byte SHA-256 hashes**, not sequential `u64` integers.

#### Derivation

The contract derives each receipt ID by hashing a struct that combines the
depositor address, token address, amount, memo hash, and a monotonically
increasing per-contract `ReceiptCounter`:

```rust
// DataKey::ReceiptCounter tracks the next counter value (u64)
// DataKey::ReceiptIndex(counter) maps counter → BytesN<32> receipt hash
// DataKey::Receipt(BytesN<32>) stores the full Receipt struct
```

#### Reading a receipt ID from the `rcpt_issd` event (TypeScript)

```ts
import { Contract, SorobanRpc, xdr } from "@stellar/stellar-sdk";

const server = new SorobanRpc.Server("https://soroban-testnet.stellar.org");

// Fetch the transaction's result metadata and scan contract events
const txMeta = await server.getTransaction(txHash);

for (const event of txMeta.resultMetaXdr.v3().sorobanMeta()?.events() ?? []) {
  const topics = event.body().v0().topics();
  const eventName = topics[0].sym().toString(); // "rcpt_issd"

  if (eventName === "rcpt_issd") {
    // event data is a BytesN<32> — hex-encode it for storage / display
    const receiptIdBytes: Buffer = Buffer.from(
      event.body().v0().data().bytes()
    );
    const receiptIdHex = receiptIdBytes.toString("hex");
    console.log("Receipt ID:", receiptIdHex);
    // e.g. "a3f1c8...64d2" (64 hex chars = 32 bytes)
  }
}
```

### `ReceiptIndex` enumeration

The contract maintains a `ReceiptIndex(u64)` mapping so receipts can be
iterated by sequential position without knowing the hash in advance:

```ts
// Query receipt by index position (0-based)
const receiptHash: string = await contract.get_receipt_by_index({ index: 0n });

// Total number of receipts issued
const count: bigint = await contract.get_receipt_counter();
```

> Note: `get_receipt_by_index` distinguishes between an out-of-range index
> (`ReceiptIndexOutOfBounds`) and a stale or expired receipt reference
> (`ReceiptNotFound`). Queries also emit a `ReceiptQueryEvent` for
> off-chain auditability.

---

## Migration Notes for Integrators

### Upgrading from `u64` receipt IDs

Previous versions of this contract used a plain `u64` counter as the receipt
ID. If you stored receipt IDs from an older deployment, re-index them as
follows:

| Old field | New field | Notes |
|-----------|-----------|-------|
| `receipt_id: u64` | `receipt_id: BytesN<32>` | 32-byte SHA-256 hash |
| Direct equality check (`id == 5`) | Hash comparison or index lookup | Use `ReceiptIndex(5)` to map counter → hash |

#### Storage key changes

```
Before:  DataKey::Receipt(u64)
After:   DataKey::Receipt(BytesN<32>)
         DataKey::ReceiptIndex(u64)   ← new: counter → hash mapping
         DataKey::ReceiptCounter      ← new: next counter value
```

#### Event payload changes

```
Before:  rcpt_issd data = u64
After:   rcpt_issd data = BytesN<32>
```

Update any event indexers that cast the `rcpt_issd` data field to `u64` to
instead treat it as a 32-byte buffer and hex-encode it for storage.
