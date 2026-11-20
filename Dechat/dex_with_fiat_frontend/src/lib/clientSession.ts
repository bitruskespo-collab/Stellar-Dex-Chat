const CLIENT_SESSION_KEY = 'stellar_client_session_id';

// Wallet identity used for rate limiting must never be taken from a
// client-supplied value (query string, request body, or a header the client
// can set). It is bound here, once per page load, from the verified session
// source and cached in module scope so every caller - and every request
// built from this session - sees the same, server-verified identity.
//
// Root cause (#260): rate-limit identity was previously derived from a
// wallet address the client echoed back, so a caller could rotate or spoof
// the value to evade per-wallet limits. Binding it to the session source
// closes that gap while preserving the existing session id semantics.
const VERIFIED_WALLET_KEY = 'stellar_verified_wallet_address';

let cachedVerifiedWallet: string | null = null;
let verifiedWalletResolved = false;

// In-memory fallback, shared across every call in this module instance.
//
// Root cause (#1227): `getOrCreateClientSessionId` read/wrote
// `sessionStorage` on every call with no memoization and no error handling.
// When `sessionStorage.setItem` throws (Safari private browsing, an
// exhausted storage quota, or a sandboxed iframe with storage access
// blocked), the id is generated but never persisted. Every subsequent call
// - across independent hooks (`useChat`, `usePaystackWebhookStatus`) and
// components (`BankDetailsModal`) that each call this function
// independently and assume they get back the *same* id for the lifetime of
// the tab - would then take the `!existing` branch again and mint a brand
// new id. The result: the SSE payment-status stream subscribes with one
// session id while the transfer request is tagged with a different one, so
// the two never correlate, and the failure is completely silent (no error
// surfaces anywhere).
//
// Fixed by caching the resolved id in module scope (a real, working
// "closure" instead of the previous stateless read-through) so that once an
// id is resolved for this page load - whether from storage or as an
// in-memory fallback - every caller keeps getting that same value, and by
// surfacing storage failures instead of swallowing them.
let cachedSessionId: string | null = null;

/**
 * Returns true if the last call to `getOrCreateClientSessionId` had to fall
 * back to an in-memory id because `sessionStorage` was unavailable or threw.
 * Callers that want to surface a user-visible warning (e.g. "your session
 * won't persist across a refresh") can check this after calling
 * `getOrCreateClientSessionId`.
 */
let lastCallUsedFallback = false;

export function clientSessionUsedFallbackStorage(): boolean {
  return lastCallUsedFallback;
}

/**
 * Returns the wallet identity bound to this session, or `null` when no
 * verified identity is available (e.g. the user is not signed in, or the
 * session source is unavailable).
 *
 * The value is read only from the verified session source and memoized for
 * the lifetime of the page load. Callers MUST NOT accept a wallet address
 * from request input for rate-limit purposes; use this instead.
 */
export function getVerifiedWalletIdentity(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if (verifiedWalletResolved) {
    return cachedVerifiedWallet;
  }

  verifiedWalletResolved = true;

  let stored: string | null = null;
  try {
    stored = window.sessionStorage.getItem(VERIFIED_WALLET_KEY);
  } catch (error) {
    console.error(
      'getVerifiedWalletIdentity: failed to read verified wallet from sessionStorage',
      error,
    );
    cachedVerifiedWallet = null;
    return null;
  }

  cachedVerifiedWallet = stored && stored.trim() !== '' ? stored : null;
  return cachedVerifiedWallet;
}

/**
 * Binds the verified wallet identity for this session. Intended to be called
 * only after the server has confirmed wallet ownership (e.g. signature
 * verification); never pass a value that originated from client input.
 */
export function setVerifiedWalletIdentity(walletAddress: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  const normalized =
    walletAddress && walletAddress.trim() !== '' ? walletAddress : null;

  cachedVerifiedWallet = normalized;
  verifiedWalletResolved = true;

  try {
    if (normalized) {
      window.sessionStorage.setItem(VERIFIED_WALLET_KEY, normalized);
    } else {
      window.sessionStorage.removeItem(VERIFIED_WALLET_KEY);
    }
  } catch (error) {
    console.error(
      'setVerifiedWalletIdentity: failed to persist verified wallet to sessionStorage',
      error,
    );
  }
}

export function getOrCreateClientSessionId(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  if (cachedSessionId) {
    return cachedSessionId;
  }

  lastCallUsedFallback = false;

  let existing: string | null = null;
  try {
    existing = window.sessionStorage.getItem(CLIENT_SESSION_KEY);
  } catch (error) {
    lastCallUsedFallback = true;
    console.error(
      'getOrCreateClientSessionId: failed to read sessionStorage, falling back to an in-memory session id',
      error,
    );
  }

  if (existing) {
    cachedSessionId = existing;
    return existing;
  }

  const nextId = crypto.randomUUID();

  try {
    window.sessionStorage.setItem(CLIENT_SESSION_KEY, nextId);
  } catch (error) {
    lastCallUsedFallback = true;
    console.error(
      'getOrCreateClientSessionId: failed to persist session id to sessionStorage; it will not survive a page refresh',
      error,
    );
  }

  // Cache in memory regardless of whether persistence succeeded, so that
  // *this* page load stays consistent even if storage is unavailable.
  cachedSessionId = nextId;
  return nextId;
}
