import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { serverEnv as env } from '@/lib/serverEnv';
import { telemetry } from '@/lib/telemetry';

export interface PayoutSecurityOptions {
  allowedOrigins?: string[];
  allowWalletClientsWithoutOrigin?: boolean;
  requireCsrfForBrowserSessions?: boolean;
  csrfSecret?: string;
  maxTokenAgeMs?: number;
}

const DEFAULT_MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getAllowedOrigins(customOrigins?: string[]): string[] {
  const allowed = new Set<string>();

  if (customOrigins) {
    customOrigins.forEach((o) => allowed.add(o.trim().toLowerCase()));
  }

  const envOrigins = process.env.ALLOWED_ORIGINS;
  if (envOrigins) {
    envOrigins.split(',').forEach((o) => allowed.add(o.trim().toLowerCase()));
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL;
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      allowed.add(url.origin.toLowerCase());
    } catch {
      allowed.add(appUrl.trim().toLowerCase());
    }
  }

  // Common localhost origins for development and testing
  allowed.add('http://localhost:3000');
  allowed.add('http://127.0.0.1:3000');
  allowed.add('https://localhost:3000');
  allowed.add('http://localhost');

  return Array.from(allowed);
}

/**
 * Derives the origin from the request URL, Origin header, or Referer header.
 */
export function extractRequestOrigin(request: NextRequest): string | null {
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    return originHeader.trim().toLowerCase();
  }

  const refererHeader = request.headers.get('referer');
  if (refererHeader) {
    try {
      const url = new URL(refererHeader);
      return url.origin.toLowerCase();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks whether a client request is a wallet-based client or programmatic client.
 * Non-browser clients do not send Origin or browser Sec-Fetch headers.
 */
export function isWalletOrProgrammaticClient(request: NextRequest): boolean {
  const hasOrigin = !!request.headers.get('origin');
  const hasReferer = !!request.headers.get('referer');
  const hasSecFetch = !!request.headers.get('sec-fetch-site');

  return !hasOrigin && !hasReferer && !hasSecFetch;
}

/**
 * Generates an HMAC-signed CSRF token.
 */
export function generateCsrfToken(
  sessionScope: string = 'default',
  secret?: string,
  clock: () => number = Date.now,
): string {
  const csrfSecret =
    secret ||
    env.PAYSTACK_SECRET_KEY ||
    process.env.CSRF_SECRET ||
    'stellar-dex-chat-csrf-secret-token';

  const timestamp = clock();
  const payload = `${sessionScope}:${timestamp}`;
  const hmac = crypto
    .createHmac('sha256', csrfSecret)
    .update(payload)
    .digest('hex');

  return `${timestamp}.${hmac}`;
}

/**
 * Validates an HMAC-signed CSRF token.
 */
export function validateCsrfToken(
  token: string | null | undefined,
  sessionScope: string = 'default',
  secret?: string,
  maxAgeMs: number = DEFAULT_MAX_TOKEN_AGE_MS,
  clock: () => number = Date.now,
): boolean {
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [timestampStr, receivedHmac] = parts;
  const timestamp = Number.parseInt(timestampStr, 10);
  if (Number.isNaN(timestamp)) return false;

  const now = clock();
  if (now - timestamp > maxAgeMs || timestamp > now + 60_000) {
    return false; // Expired or future timestamp
  }

  const csrfSecret =
    secret ||
    env.PAYSTACK_SECRET_KEY ||
    process.env.CSRF_SECRET ||
    'stellar-dex-chat-csrf-secret-token';

  const payload = `${sessionScope}:${timestamp}`;
  const expectedHmac = crypto
    .createHmac('sha256', csrfSecret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedHmac, 'hex'),
      Buffer.from(expectedHmac, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Builds explicit CORS headers and strictly rejects wildcard credentialed access.
 */
export function buildCorsHeaders(
  request: NextRequest,
  options: {
    allowedOrigins?: string[];
    allowCredentials?: boolean;
  } = {},
): Record<string, string> {
  const allowCredentials = options.allowCredentials ?? true;
  const configuredAllowed = getAllowedOrigins(options.allowedOrigins);
  const requestOrigin = extractRequestOrigin(request);

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-CSRF-Token, X-Idempotency-Key, x-trace-id, x-span-id, sec-fetch-site',
    'Access-Control-Max-Age': '86400',
  };

  // Rule: Reject wildcard credentialed access
  // When credentials are used, Access-Control-Allow-Origin MUST NOT be '*'
  if (requestOrigin) {
    const isAllowed =
      configuredAllowed.includes(requestOrigin) ||
      (request.nextUrl &&
        requestOrigin === request.nextUrl.origin.toLowerCase());

    if (isAllowed) {
      headers['Access-Control-Allow-Origin'] = requestOrigin;
      if (allowCredentials) {
        headers['Access-Control-Allow-Credentials'] = 'true';
      }
    }
  }

  return headers;
}

export interface SecurityEvaluation {
  allowed: boolean;
  statusCode?: number;
  error?: string;
  message?: string;
  isWalletClient?: boolean;
}

/**
 * A versioned data key used to encrypt stored payout fields.
 *
 * Only the `id` (a non-secret key identifier) is ever persisted alongside
 * ciphertext. The raw key material (`material`) must never be written to
 * storage, logs, telemetry, or API responses.
 */
export interface PayoutDataKey {
  /** Stable, non-secret identifier persisted with ciphertext (e.g. "k-2024-01"). */
  id: string;
  /** Raw key material. Never persist or expose this value. */
  material: Buffer;
  /** Lifecycle state of the key. */
  status: 'active' | 'previous' | 'retired';
}

export interface PayoutKeyRing {
  /** The key currently used for new encryptions. */
  active: PayoutDataKey;
  /** Older keys still accepted for decryption during rotation. */
  previous?: PayoutDataKey[];
  /** Keys that must no longer be used for decryption. */
  retired?: PayoutDataKey[];
}

export interface EncryptedPayoutField {
  /** Key identifier only — never key material. */
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface ReencryptionProgress {
  total: number;
  processed: number;
  reencrypted: number;
  skipped: number;
  failed: number;
  done: boolean;
}

export interface ReencryptionResult<T> {
  value: T;
  progress: ReencryptionProgress;
}

export class PayoutKeyError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'UNKNOWN_KEY_ID'
      | 'RETIRED_KEY'
      | 'INVALID_KEY_RING'
      | 'DECRYPTION_FAILED',
  ) {
    super(message);
    this.name = 'PayoutKeyError';
  }
}

const PAYOUT_IV_LENGTH = 12;

function assertKeyRing(keyRing: PayoutKeyRing): void {
  if (!keyRing || !keyRing.active || !keyRing.active.id) {
    throw new PayoutKeyError('Key ring must define an active key', 'INVALID_KEY_RING');
  }
  const seen = new Set<string>();
  const all = [keyRing.active, ...(keyRing.previous ?? []), ...(keyRing.retired ?? [])];
  for (const key of all) {
    if (!key || !key.id) {
      throw new PayoutKeyError('Every key must have an id', 'INVALID_KEY_RING');
    }
    if (seen.has(key.id)) {
      throw new PayoutKeyError(`Duplicate key id '${key.id}'`, 'INVALID_KEY_RING');
    }
    seen.add(key.id);
  }
}

/**
 * Resolves a key by its persisted identifier. Retired keys are rejected so
 * that data encrypted under them can no longer be read.
 */
export function resolvePayoutKey(
  keyRing: PayoutKeyRing,
  keyId: string,
): PayoutDataKey {
  assertKeyRing(keyRing);
  if (keyRing.active.id === keyId) return keyRing.active;

  const previous = (keyRing.previous ?? []).find((k) => k.id === keyId);
  if (previous) return previous;

  const retired = (keyRing.retired ?? []).find((k) => k.id === keyId);
  if (retired) {
    throw new PayoutKeyError(
      `Key '${keyId}' has been retired and can no longer decrypt data`,
      'RETIRED_KEY',
    );
  }

  throw new PayoutKeyError(`Unknown key id '${keyId}'`, 'UNKNOWN_KEY_ID');
}

/**
 * Encrypts a payout field with the active key. Only the key identifier is
 * stored alongside the ciphertext.
 */
export function encryptPayoutField(
  plaintext: string,
  keyRing: PayoutKeyRing,
): EncryptedPayoutField {
  assertKeyRing(keyRing);
  const key = keyRing.active;
  const iv = crypto.randomBytes(PAYOUT_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.material, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    keyId: key.id,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypts a payout field using the key identified by `field.keyId`.
 * Supports active and previous keys; retired keys are rejected.
 */
export function decryptPayoutField(
  field: EncryptedPayoutField,
  keyRing: PayoutKeyRing,
): string {
  const key = resolvePayoutKey(keyRing, field.keyId);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key.material,
      Buffer.from(field.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(field.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(field.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    throw new PayoutKeyError(
      `Failed to decrypt field with key '${field.keyId}'`,
      'DECRYPTION_FAILED',
    );
  }
}

/**
 * Re-encrypts a single field under the active key. Fields already encrypted
 * with the active key are returned unchanged (skipped).
 */
export function reencryptPayoutField(
  field: EncryptedPayoutField,
  keyRing: PayoutKeyRing,
): { field: EncryptedPayoutField; reencrypted: boolean } {
  assertKeyRing(keyRing);
  if (field.keyId === keyRing.active.id) {
    return { field, reencrypted: false };
  }
  const plaintext = decryptPayoutField(field, keyRing);
  return { field: encryptPayoutField(plaintext, keyRing), reencrypted: true };
}

/**
 * Re-encrypts a batch of payout fields, reporting progress. Failures are
 * counted but do not abort the batch so partial progress is preserved.
 */
export function reencryptPayoutFields(
  fields: EncryptedPayoutField[],
  keyRing: PayoutKeyRing,
): ReencryptionResult<EncryptedPayoutField[]> {
  assertKeyRing(keyRing);
  const progress: ReencryptionProgress = {
    total: fields.length,
    processed: 0,
    reencrypted: 0,
    skipped: 0,
    failed: 0,
    done: false,
  };

  const out: EncryptedPayoutField[] = [];
  for (const field of fields) {
    try {
      const result = reencryptPayoutField(field, keyRing);
      out.push(result.field);
      if (result.reencrypted) progress.reencrypted += 1;
      else progress.skipped += 1;
    } catch {
      out.push(field);
      progress.failed += 1;
    }
    progress.processed += 1;
  }

  progress.done = true;
  return { value: out, progress };
}

/**
 * Rolls back a re-encryption by restoring the original (pre-rotation) fields.
 * The caller supplies the previously persisted snapshot; this helper only
 * validates that the snapshot is decryptable under the supplied key ring.
 */
export function rollbackReencryption(
  snapshot: EncryptedPayoutField[],
  keyRing: PayoutKeyRing,
): EncryptedPayoutField[] {
  assertKeyRing(keyRing);
  for (const field of snapshot) {
    // Throws if the snapshot references a retired or unknown key.
    resolvePayoutKey(keyRing, field.keyId);
  }
  return snapshot.map((f) => ({ ...f }));
}

/**
 * Retires a key by moving it out of the active/previous set. Data encrypted
 * under the retired key can no longer be decrypted.
 */
export function retirePayoutKey(
  keyRing: PayoutKeyRing,
  keyId: string,
): PayoutKeyRing {
  assertKeyRing(keyRing);
  if (keyRing.active.id === keyId) {
    throw new PayoutKeyError(
      'Cannot retire the active key; promote a new active key first',
      'INVALID_KEY_RING',
    );
  }
  const previous = keyRing.previous ?? [];
  const target = previous.find((k) => k.id === keyId);
  if (!target) {
    const retired = keyRing.retired ?? [];
    if (retired.some((k) => k.id === keyId)) {
      return keyRing; // Already retired — idempotent.
    }
    throw new PayoutKeyError(`Unknown key id '${keyId}'`, 'UNKNOWN_KEY_ID');
  }
  return {
    active: keyRing.active,
    previous: previous.filter((k) => k.id !== keyId),
    retired: [...(keyRing.retired ?? []), { ...target, status: 'retired' }],
  };
}

/**
 * Promotes a previous key to active, demoting the current active key to
 * previous. Used at the start of a rotation.
 */
export function promotePayoutKey(
  keyRing: PayoutKeyRing,
  keyId: string,
): PayoutKeyRing {
  assertKeyRing(keyRing);
  if (keyRing.active.id === keyId) return keyRing;
  const previous = keyRing.previous ?? [];
  const target = previous.find((k) => k.id === keyId);
  if (!target) {
    throw new PayoutKeyError(`Unknown key id '${keyId}'`, 'UNKNOWN_KEY_ID');
  }
  return {
    active: { ...target, status: 'active' },
    previous: [
      { ...keyRing.active, status: 'previous' },
      ...previous.filter((k) => k.id !== keyId),
    ],
    retired: keyRing.retired ?? [],
  };
}

/**
 * Evaluates origin, fetch metadata, and CSRF protection for state-changing routes.
 */
export function evaluatePayoutRequestSecurity(
  request: NextRequest,
  options: PayoutSecurityOptions = {},
): SecurityEvaluation {
  // 1. Handle non-browser wallet / programmatic clients without blocking them
  if (isWalletOrProgrammaticClient(request)) {
    return {
      allowed: true,
      isWalletClient: true,
    };
  }

  // 2. Fetch metadata validation
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    telemetry.addLog(
      'security',
      'warn',
      'Rejected cross-site state-changing request',
      {
        secFetchSite,
        path: request.nextUrl?.pathname,
      },
    );
    return {
      allowed: false,
      statusCode: 403,
      error: 'CROSS_SITE_REQUEST_FORBIDDEN',
      message: 'Cross-site state-changing requests are prohibited.',
    };
  }

  // 3. Origin and Referer validation
  const requestOrigin = extractRequestOrigin(request);
  const allowedOrigins = getAllowedOrigins(options.allowedOrigins);

  if (request.nextUrl && request.nextUrl.origin) {
    allowedOrigins.push(request.nextUrl.origin.toLowerCase());
  }

  if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    telemetry.addLog('security', 'warn', 'Rejected untrusted origin', {
      origin: requestOrigin,
      allowedOrigins,
    });
    return {
      allowed: false,
      statusCode: 403,
      error: 'FORBIDDEN_ORIGIN',
      message: `Origin '${requestOrigin}' is not allowed to access this resource.`,
    };
  }

  // 4. CSRF Token Strategy for browser sessions
  // If the request originates from a browser session (has cookie or requires CSRF)
  const hasCookieSession = request.headers.get('cookie') !== null;
  const requireCsrf = options.requireCsrfForBrowserSessions ?? hasCookieSession;

  if (requireCsrf && !isWalletOrProgrammaticClient(request)) {
    const csrfToken =
      request.headers.get('x-csrf-token') ||
      request.headers.get('X-CSRF-Token');

    if (
      !validateCsrfToken(
        csrfToken,
        'default',
        options.csrfSecret,
        options.maxTokenAgeMs,
      )
    ) {
      telemetry.addLog('security', 'warn', 'CSRF token missing or invalid', {
        hasToken: !!csrfToken,
        path: request.nextUrl?.pathname,
      });
      return {
        allowed: false,
        statusCode: 403,
        error: 'CSRF_VALIDATION_FAILED',
        message: 'Invalid or missing CSRF token for browser session.',
      };
    }
  }

  return { allowed: true };
}

/**
 * Middleware/helper to enforce payout security on a route.
 * Returns null if allowed, or a NextResponse if rejected or handling OPTIONS preflight.
 */
export function enforcePayoutRouteSecurity(
  request: NextRequest,
  options: PayoutSecurityOptions = {},
): NextResponse | null {
  // Handle OPTIONS preflight
  if (request.method === 'OPTIONS') {
    const corsHeaders = buildCorsHeaders(request, {
      allowedOrigins: options.allowedOrigins,
    });
    return new NextResponse(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const evaluation = evaluatePayoutRequestSecurity(request, options);
  if (!evaluation.allowed) {
    const corsHeaders = buildCorsHeaders(request, {
      allowedOrigins: options.allowedOrigins,
    });
    return NextResponse.json(
      {
        success: false,
        error: evaluation.error,
        message: evaluation.message,
      },
      {
        status: evaluation.statusCode || 403,
        headers: corsHeaders,
      },
    );
  }

  return null;
}
