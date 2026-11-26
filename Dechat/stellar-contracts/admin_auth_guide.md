# Stellar Dex Chat: Admin Authentication Guide

This guide explains the architecture and security model of the Administrative Authentication system in the Stellar Dex Chat application.

## Overview

The administrative system is designed with a "Blockchain-First" philosophy. Unlike traditional web applications that rely on central databases or session cookies for role-based access control (RBAC), Stellar Dex Chat anchors administrative authority directly to the Stellar blockchain.

## Security Architecture

### 1. On-Chain Source of Truth
The definitive list of administrators and their privileges is stored within the `FiatBridge` smart contract on the Stellar network. 

### 2. Zero-Trust Frontend
The frontend does not store "is_admin" flags in local storage or cookies. Instead, every time an administrative route is accessed, the following flow occurs:
- The user's connected wallet address is retrieved via `useStellarWallet`.
- A real-time call is made to the smart contract's `get_admin` function (exposed as `getAdmin()` in the frontend library).
- The frontend compares the two addresses. Access is granted **only if they match exactly**.

### 3. Smart Contract Guards
Even if a malicious user bypasses the frontend UI checks, they cannot execute administrative actions. Every administrative function in the smart contract (e.g., `set_limit`, `pause`, `set_operator`) includes an internal `admin.require_auth()` check. This requires a valid cryptographic signature from the authorized admin address to succeed.

## Admin Roles & Permissions

| Action | Required Role | Function |
|--------|---------------|----------|
| Pause/Unpause | Admin | `pause()`, `unpause()` |
| Manage Operators | Admin | `set_operator()` |
| Set Asset Limits | Admin | `set_limit()` |
| Deny Addresses | Admin | `deny_address()` |
| Transfer Ownership| Admin | `transfer_admin()` |
| Admin Recovery | Recovery Address proposes; successor authorizes | `propose_admin_recovery()`, `execute_admin_recovery()` |

## Best Practices for Administrators

1. **Hardware Wallet**: Always use a hardware wallet (like Ledger) for the primary Admin address.
2. **Operator Role**: For day-to-day tasks like heartbeat signals, use the **Operator** role. Operators have restricted permissions and can be pruned by the Admin if compromised.
3. **Multisig Control**: The contract supports M-of-N multi-signature control for critical governance actions. Ensure the threshold is set to a value that balances security and availability (e.g., 3-of-5).

## Multisig Proposal Expiry and Cleanup (Issue #175)

Pending multisig proposals expire so stale approvals cannot linger in contract
storage indefinitely. The rules are:

- **Window**: a proposal expires at `created_at + get_multisig_expiry()`
  ledgers. The admin configures the window with
  `set_multisig_expiry(ledgers)`; `0` restores the default of `17_280`
  ledgers (~24 hours). The policy is instance-wide and applies to existing
  pending proposals as well as new ones.
- **Boundary**: a proposal is expired when the current ledger is **greater
  than or equal to** its expiry ledger. One ledger before expiry it is still
  live; exactly at the expiry ledger it is expired.
- **No execution after expiry**: `execute_multisig_action` returns
  `ProposalExpired` (1109) for an expired proposal. Expiry never changes the
  outcome of an executed proposal and no funds move.
- **Bounded cleanup**: the admin calls
  `prune_expired_multisig_proposals(max_scan)`. Each call scans at most
  `max_scan` proposal IDs, clamped to `1..=MAX_MULTISIG_CLEANUP_SCAN` (50),
  starting from a persisted cursor. It removes only expired, unexecuted
  proposals, emits one `multisig_expired` event per removal, and leaves
  executed proposals untouched. The cursor wraps after `NextMultisigID`.
- **Draining a backlog**: repeat the call until the returned
  `MultisigCleanupResult::is_complete` is `true`. No other entry point needs to
  change; asking a signer to re-propose is the recovery path for an expired
  action.

## Lost-Admin Recovery

The admin must configure an independent recovery address with
`set_emergency_recovery` while the admin key is available. That recovery
address can propose a successor only after `InactivityThreshold` ledgers have
passed without admin activity. The successor must separately authorize
`execute_admin_recovery`, and execution is blocked until the 48-hour timelock
has elapsed. Any intervening action authenticated as the current admin clears
the recovery proposal. Proposal and execution events provide an on-chain audit
trail. The ordinary `transfer_admin` / `accept_admin` flow remains unchanged.

## Verification
You can verify the current admin at any time using a Stellar explorer (like StellarExpert) by querying the `FiatBridge` contract instance storage for the `Admin` key.
