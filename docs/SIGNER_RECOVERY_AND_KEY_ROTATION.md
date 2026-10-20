# Signer Recovery and Emergency Key Rotation Runbook (Issue #85)

## 1. Custody Boundaries & Roles
- **Multisig Signers (Threshold 2-of-3 or 3-of-5)**: Cold ledger hardware wallets held across designated security officers.
- **Operator Signers**: Online service accounts authorized only for heartbeat and fee disbursement within rate limits.
- **Approvers**: Minimum 2 maintainer approvals required to schedule any signer modification.

## 2. Compromise Indicators & Immediate Escalation
1. **Unrecognized Multisig Action Proposal**: Alert triggered if an unknown hash is proposed in `propose_multisig_action`.
2. **Abnormal Nonce Increment**: Mismatch between database sequence and on-chain account nonce.
3. **Escalation**: Immediate notification sent to the Security Incident Response Team via dedicated PagerDuty roster.

## 3. Order of Operations for Emergency Rotation
1. **Contract Pause / Circuit Breaker Trip**:
   - Authorized operator invokes `trip_circuit_breaker` or `pause()` to prevent unauthorized fund movements.
2. **Timelocked Replacement Proposal**:
   - Healthy signers submit `propose_multisig_action` specifying `RemoveSigner(compromised_key)` and `AddSigner(new_verified_key)`.
   - Contract enforces `MIN_TIMELOCK_DELAY` (48 hours = 34,560 ledgers) unless in emergency multisig override mode.
3. **Approval Gathering**:
   - Required threshold of independent signers review the proposal payload SHA-256 digest offline and call `approve_multisig_action`.
4. **Execution & Verification**:
   - Call `execute_multisig_action` once timelock matures.
   - Verify active signers via `get_multisig_signers()`.
5. **Service Restoration**:
   - Submit `reset_circuit_breaker` and resume normal operations.

## 4. Disaster Recovery & Edge Cases
- **Lost Signer Key**: If a signer key is inaccessible, remaining signers execute standard rotation if threshold is intact. If threshold is lost, disaster escrow timelock allows funds reclaim after expiry window.
- **Partially Failed Rotation**: If proposal expires before quorum, cancel proposal and initiate new transaction with updated nonce.

## 5. Rehearsal Cadence & Evidence
- **Cadence**: Tabletop drill conducted quarterly on Testnet.
- **Evidence**: On-chain transaction hashes, signed audit memos, and post-mortem logs archived in compliance vault.
