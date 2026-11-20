// src/lib/auth/nonceStore.ts
//
// Server-side wallet-session nonce store.
//
// Security properties:
//  - Nonces are one-time: `consumeNonce` atomically deletes the entry so only
//    the first caller can succeed (compare-and-delete semantics).
//  - Nonces are short-lived: each entry carries an expiry (`ttlMs`).
//  - Nonces are bound to the intended wallet address and origin; consumption
//    fails if either does not match the issued values.
//  - Expired entries are rejected on consumption and swept by a cleanup
//    interval so the store does not grow unbounded.
//
// This module is intended to run in a server context only (Node runtime).
// It must never be imported into client bundles.

import { randomBytes } from 'crypto';

/** Default lifetime of an issued nonce. */
export const DEFAULT_NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Default interval between expired-entry sweeps. */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

/** Number of random bytes used to generate a nonce (hex-encoded). */
const NONCE_BYTE_LENGTH = 32;

export interface IssueNonceParams {
  /** Wallet address the nonce is bound to. */
  wallet: string;
  /** Origin (scheme + host + port) the nonce is bound to. */
  origin: string;
  /** Optional override for the nonce lifetime in milliseconds. */
  ttlMs?: number;
}

export interface IssuedNonce {
  /** The opaque nonce value to hand to the client. */
  nonce: string;
  /** Epoch milliseconds at which the nonce expires. */
  expiresAt: number;
}

export interface ConsumeNonceParams {
  /** The nonce presented by the client. */
  nonce: string;
  /** Wallet address presented by the client. */
  wallet: string;
  /** Origin presented by the client. */
  origin: string;
}

export type ConsumeNonceFailureReason =
  | 'missing'
  | 'expired'
  | 'wallet_mismatch'
  | 'origin_mismatch';

export type ConsumeNonceResult =
  | { ok: true }
  | { ok: false; reason: ConsumeNonceFailureReason };

interface NonceRecord {
  wallet: string;
  origin: string;
  expiresAt: number;
}

/**
 * Normalizes a wallet address for comparison. EVM addresses are
 * case-insensitive; we compare lowercased to avoid spurious mismatches.
 */
function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

/**
 * Normalizes an origin for comparison (lowercase, no trailing slash).
 */
function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * In-memory nonce store. Keyed by nonce value.
 *
 * NOTE: This is process-local. In a multi-instance deployment, replace the
 * backing Map with a shared store (e.g. Redis) that supports atomic
 * compare-and-delete (GETDEL / Lua script). The public API of this module is
 * designed so that swap does not require changes at call sites.
 */
const store = new Map<string, NonceRecord>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function sweepExpired(now: number = Date.now()): void {
  for (const [nonce, record] of store) {
    if (record.expiresAt <= now) {
      store.delete(nonce);
    }
  }
}

function ensureCleanupTimer(): void {
  if (cleanupTimer !== null) return;
  // `unref` so the timer does not keep the process alive (Node only).
  cleanupTimer = setInterval(() => sweepExpired(), DEFAULT_CLEANUP_INTERVAL_MS);
  const maybeUnref = cleanupTimer as unknown as { unref?: () => void };
  if (typeof maybeUnref.unref === 'function') {
    maybeUnref.unref();
  }
}

/**
 * Issues a new single-use nonce bound to the given wallet and origin.
 */
export function issueNonce({ wallet, origin, ttlMs }: IssueNonceParams): IssuedNonce {
  if (!wallet || typeof wallet !== 'string') {
    throw new Error('issueNonce: wallet is required');
  }
  if (!origin || typeof origin !== 'string') {
    throw new Error('issueNonce: origin is required');
  }

  const lifetime =
    typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
      ? ttlMs
      : DEFAULT_NONCE_TTL_MS;

  const nonce = randomBytes(NONCE_BYTE_LENGTH).toString('hex');
  const expiresAt = Date.now() + lifetime;

  store.set(nonce, {
    wallet: normalizeWallet(wallet),
    origin: normalizeOrigin(origin),
    expiresAt,
  });

  ensureCleanupTimer();

  return { nonce, expiresAt };
}

/**
 * Atomically consumes a nonce. Returns `{ ok: true }` only for the first
 * caller presenting a valid, unexpired nonce with matching wallet and origin.
 *
 * The entry is deleted before any validation result is returned so that a
 * concurrent second caller can never succeed, even on mismatch paths.
 */
export function consumeNonce({ nonce, wallet, origin }: ConsumeNonceParams): ConsumeNonceResult {
  if (!nonce || typeof nonce !== 'string') {
    return { ok: false, reason: 'missing' };
  }

  // Compare-and-delete: remove the entry first so only one caller can observe it.
  const record = store.get(nonce);
  if (record === undefined) {
    return { ok: false, reason: 'missing' };
  }
  store.delete(nonce);

  const now = Date.now();
  if (record.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }

  if (!wallet || typeof wallet !== 'string' || normalizeWallet(wallet) !== record.wallet) {
    return { ok: false, reason: 'wallet_mismatch' };
  }

  if (!origin || typeof origin !== 'string' || normalizeOrigin(origin) !== record.origin) {
    return { ok: false, reason: 'origin_mismatch' };
  }

  return { ok: true };
}

/**
 * Test-only hook: clears all stored nonces and stops the cleanup interval.
 * Not intended for production use.
 */
export function __resetNonceStoreForTests(): void {
  store.clear();
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Test-only hook: runs an expired-entry sweep immediately.
 */
export function __sweepExpiredNoncesForTests(now: number = Date.now()): void {
  sweepExpired(now);
}

/**
 * Test-only hook: returns the current number of stored nonces.
 */
export function __nonceStoreSizeForTests(): number {
  return store.size;
}