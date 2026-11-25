# Error Codes

Authoritative list of error codes returned by the FiatBridge Soroban contract.
Generated from the `Error` enum in `Dechat/stellar-contracts/src/lib.rs`.

## Error Code Reference

| Code | Name | Series | Description |
|------|------|--------|-------------|
| 10 | `Overflow` | Arithmetic | Integer overflow in calculation |
| 101 | `NotInitialized` | Initialization | Contract has not been initialized (no admin set) |
| 102 | `AlreadyInitialized` | Initialization | Contract has already been initialized |
| 103 | `InternalError` | Initialization | Internal contract error (e.g., integer overflow) |
| 104 | `ContractPaused` | Initialization | Contract is paused; operations are blocked |
| 201 | `Unauthorized` | Authorization | Caller is not authorized for this operation |
| 202 | `NotAllowed` | Authorization | Allowlist is enabled and caller is not on it |
| 203 | `NoPendingAdmin` | Authorization | No pending admin was set (cannot accept) |
| 204 | `InvalidRecipient` | Authorization | Recipient address failed validation |
| 205 | `NotOperator` | Authorization | Caller is not an operator |
| 206 | `OperatorCapReached` | Authorization | Maximum operator limit reached |
| 207 | `SameAdmin` | Authorization | New admin is the same as current admin |
| 301 | `ZeroAmount` | Constraints | Amount is zero or negative |
| 302 | `ExceedsLimit` | Constraints | Amount exceeds per-token limit |
| 303 | `ExceedsLimitMaxCap` | Constraints | Amount exceeds maximum cap limit |
| 304 | `DailyLimitExceeded` | Constraints | Daily deposit limit exceeded for user/token pair |
| 305 | `ExceedsFiatLimit` | Constraints | USD-cent value exceeds fiat limit |
| 306 | `ReferenceTooLong` | Constraints | Reference bytes exceed MAX_REFERENCE_LEN (64) |
| 307 | `CooldownActive` | Constraints | User deposited too recently; cooldown active |
| 308 | `AntiSandwichDelayActive` | Constraints | Anti-sandwich delay active |
| 309 | `TokenNotWhitelisted` | Constraints | Token is not whitelisted |
| 310 | `AddressDenied` | Constraints | Address is on the deny list |
| 311 | `RescueForbidden` | Constraints | Rescue operation not allowed |
| 312 | `CircuitBreakerActive` | Constraints | Circuit breaker is active (threshold exceeded) |
| 313 | `InvalidMemoHash` | Constraints | Memo hash is invalid |
| 314 | `FeeWithdrawalExceedsBalance` | Constraints | Fee withdrawal exceeds available balance |
| 315 | `CircuitBreakerTripped` | Constraints | Circuit breaker has been tripped |
| 316 | `MaxDeniedReached` | Constraints | Maximum denied addresses reached |
| 317 | `InvalidAmount` | Constraints | Amount format is invalid |
| 318 | `SelfReferentialAddress` | Constraints | Address cannot reference itself |
| 319 | `LimitCapCannotBeLowered` | Constraints | Cannot lower an existing limit cap |
| 322 | `InvalidPageSize` | Constraints | Pagination limit is zero or exceeds the supported maximum |
| 401 | `InsufficientFunds` | Funds & Balances | Contract balance insufficient for withdrawal |
| 402 | `NoFeesToWithdraw` | Funds & Balances | No accumulated fees to withdraw |
| 403 | `TransferFailed` | Funds & Balances | Token transfer failed or returned unexpected balance delta |
| 404 | `ShortTransfer` | Funds & Balances | Token transferred less than requested amount |
| 405 | `TokenInterfaceInvalid` | Funds & Balances | Required token balance or decimal query failed or returned unsupported precision |
| 501 | `RequestNotFound` | Withdrawal Queue | Withdrawal request does not exist |
| 502 | `WithdrawalLocked` | Withdrawal Queue | Withdrawal request not yet unlocked |
| 503 | `OperatorDailyLimitExceeded` | Withdrawal Queue | Operator's daily withdrawal limit exceeded |
| 504 | `QueueIndexMigrationRequired` | Withdrawal Queue | Existing queue index backfill must complete before queue mutations |
| 505 | `QueueLimitReached` | Withdrawal Queue | Maximum active withdrawal queue depth reached |
| 601 | `ActionNotQueued` | Governance & Timelock | Admin action is not queued |
| 602 | `ActionNotReady` | Governance & Timelock | Admin action timelock has not elapsed |
| 603 | `InactivityThresholdNotReached` | Governance & Timelock | Inactivity threshold not yet reached |
| 604 | `NoEmergencyRecoveryAddress` | Governance & Timelock | No emergency recovery address configured |
| 605 | `UpgradeNotReady` | Governance & Timelock | Upgrade timelock has not elapsed |
| 606 | `UpgradeProposalMissing` | Governance & Timelock | No upgrade proposal pending |
| 607 | `UpgradeDelayTooShort` | Governance & Timelock | Upgrade delay is below MIN_UPGRADE_DELAY |
| 701 | `OracleNotSet` | External Services | Oracle not configured |
| 702 | `OraclePriceInvalid` | External Services | Oracle returned invalid price |
| 703 | `SlippageExceeded` | External Services | Slippage exceeds configured maximum |
| 704 | `SlippageTooHigh` | External Services | Slippage is too high for this operation |
| 705 | `OracleObservationMissing` | External Services | No usable oracle observation was returned |
| 706 | `OracleObservationStale` | External Services | Oracle observation exceeds the configured age |
| 707 | `OracleObservationFutureDated` | External Services | Oracle observation is dated after the current ledger |
| 708 | `OracleConfidenceTooLow` | External Services | Oracle observation confidence is below the configured threshold |
| 709 | `OracleConfigInvalid` | External Services | Oracle freshness or confidence configuration is invalid |
| 710 | `FiatConversionOverflow` | External Services | Fiat conversion exceeded safe integer arithmetic bounds |
| 711 | `OracleSpreadTooWide` | External Services | Aggregated oracle spread exceeds the configured bound |
| 712 | `OracleSourcesInsufficient` | External Services | Fewer than the configured number of valid oracle sources responded |
| 713 | `OracleVersionUnsupported` | External Services | A source returned an unsupported observation version |
| 801 | `WithdrawalQuotaExceeded` | Quota & Migration | Withdrawal quota exceeded |
| 802 | `MigrationAlreadyComplete` | Quota & Migration | Data migration already complete |
| 803 | `BatchOperationFailed` | Quota & Migration | Batch operation failed |
| 804 | `MigrationInvalidState` | Quota & Migration | Migration preconditions or postconditions failed |
| 805 | `MigrationSchemaMismatch` | Quota & Migration | Stored schema version is newer than this migration supports |
| 901 | `InvalidNonce` | Replay Protection | Provided nonce is ahead of current (jump) |
| 902 | `StaleNonce` | Replay Protection | Provided nonce is behind current (replay) |
| 1001 | `BelowMinimum` | Deposit Floor | Amount below minimum deposit |
| 1101 | `InvalidThreshold` | Multi-sig | Multi-sig threshold is invalid |
| 1102 | `DuplicateSigner` | Multi-sig | Duplicate signer in multi-sig set |
| 1103 | `SignerNotFound` | Multi-sig | Signer not found in multi-sig set |
| 1104 | `ProposalNotFound` | Multi-sig | Multi-sig proposal not found |
| 1105 | `AlreadyApproved` | Multi-sig | Address already approved this proposal |
| 1106 | `ProposalAlreadyExecuted` | Multi-sig | Multi-sig proposal already executed |
| 1107 | `ThresholdNotMet` | Multi-sig | Approval threshold not met |
| 1108 | `MaxSignersReached` | Multi-sig | Maximum signers reached |
| 1109 | `ProposalExpired` | Multi-sig | Proposal passed its expiry ledger and can no longer execute |
| 1204 | `AdminRecoveryAlreadyPending` | Admin Recovery | An admin recovery proposal is already pending |
| 1205 | `AdminRecoveryNotPending` | Admin Recovery | No admin recovery proposal is pending |

## Error Series Summary

| Series | Code Range | Domain |
|--------|-----------|--------|
| Arithmetic | 10 | Overflow prevention |
| Initialization | 101–104 | Contract lifecycle and state |
| Authorization | 201–207 | Access control and permissions |
| Constraints | 301–322 | Amount, limit, pagination, and business rule validation |
| Funds & Balances | 401–402 | Balance checks and fee management |
| Withdrawal Queue | 501–505 | Withdrawal request processing |
| Governance & Timelock | 601–607 | Admin actions and contract upgrades |
| External Services | 701–713 | Oracle, pricing, and conversion integration |
| Quota & Migration | 801–803 | Quota enforcement and data migrations |
| Replay Protection | 901–902 | Nonce validation |
| Deposit Floor | 1001 | Minimum deposit enforcement |
| Multi-sig | 1101–1109 | Multi-signature proposal and execution |
| Admin Recovery | 1204–1205 | Delayed recovery proposal state |
