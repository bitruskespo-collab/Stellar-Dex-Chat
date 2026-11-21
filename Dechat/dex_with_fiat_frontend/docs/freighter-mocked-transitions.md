# Freighter-Mocked Transitions (#273)

## Coverage

- **Account/network switch during signing**: `StellarWalletContext.signTx` validates live Freighter address/network against expected context and throws `WALLET_CONTEXT_CHANGED` before signing/submitting writes.
- **Wrong-network write block**: signing rejects when passphrase is not Stellar Testnet / expected context.
- **Account-scoped UI state clearing**: disconnect and account selection clear generic pending tx markers and account-scoped pending tx keys for the previous account; context version increments on account switch.

## Tests

- `src/contexts/__tests__/walletContextTransitions.test.tsx`
  - account change during signing -> blocked, no `signTransaction`
  - wrong network before write -> blocked, no `signTransaction`
  - disconnect clears account-scoped pending tx UI state

## Safety

- No credentials or real user data in fixtures.
- Existing financial safety checks preserved; wrong-context writes fail closed.
