# Supported Network Compatibility Matrix (Issue #84)

This matrix defines the required protocol capabilities, network identities, and validation checks for the FiatBridge Soroban smart contracts.

| Network Identity | Protocol Version | Required Passphrase | Requires Oracle | Timeout Limit | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Local Standalone** | Protocol 20+ | `Standalone Network ; February 2017` | Optional | 30s | Supported (Dev) |
| **Testnet** | Protocol 21+ | `Test SDF Network ; September 2015` | Required | 60s | Supported (Staging) |
| **Public Mainnet** | Protocol 21+ | `Public Global Stellar Network ; September 2015` | Required | 120s | Production Ready |

## Preflight Verification Invariants
1. **Chain Passphrase Check**: Contracts reject transactions initiated against unrecognized network passphrases.
2. **Oracle Staleness**: On networks requiring oracles, prices older than 300 seconds are rejected.
3. **RPC Simulation**: Contract calls must pass read-only simulation before signing.
