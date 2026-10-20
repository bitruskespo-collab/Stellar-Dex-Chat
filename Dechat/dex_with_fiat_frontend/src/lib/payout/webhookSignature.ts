import 'server-only';
import crypto from 'crypto';

export interface WebhookSignatureVerificationOptions {
  rawPayload: string;
  signature: string | null;
  timestamp?: string | null;
  secrets?: string[];
  maxAgeMs?: number;
}

export interface VerificationResult {
  valid: boolean;
  error?:
    | 'missing_signature'
    | 'malformed_signature'
    | 'stale_signature'
    | 'invalid_signature'
    | 'missing_secret';
  message?: string;
}

const DEFAULT_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Constant-time comparison between two hex strings.
 */
export function verifySignatureConstantTime(
  expectedHex: string,
  providedHex: string,
): boolean {
  if (typeof expectedHex !== 'string' || typeof providedHex !== 'string') {
    return false;
  }
  // HMAC-SHA512 outputs 128 hex characters (64 bytes)
  if (
    !/^[0-9a-fA-F]{128}$/.test(providedHex) ||
    !/^[0-9a-fA-F]{128}$/.test(expectedHex)
  ) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'hex');
  const providedBuf = Buffer.from(providedHex.toLowerCase(), 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Returns active provider secrets for webhook verification.
 * Supports primary, previous, and comma-separated secrets for key rotation with overlap window.
 */
export function getWebhookSecrets(): string[] {
  const secrets: string[] = [];

  const primary = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (primary) {
    if (primary.includes(',')) {
      for (const s of primary.split(',')) {
        const trimmed = s.trim();
        if (trimmed && !secrets.includes(trimmed)) secrets.push(trimmed);
      }
    } else {
      secrets.push(primary);
    }
  }

  const previous = process.env.PAYSTACK_SECRET_KEY_PREVIOUS?.trim();
  if (previous && !secrets.includes(previous)) {
    secrets.push(previous);
  }

  const rotationKeys = process.env.PAYSTACK_ROTATION_SECRETS?.trim();
  if (rotationKeys) {
    for (const s of rotationKeys.split(',')) {
      const trimmed = s.trim();
      if (trimmed && !secrets.includes(trimmed)) secrets.push(trimmed);
    }
  }

  return secrets;
}

/**
 * Verifies webhook signatures against raw request payload using constant-time comparison.
 * Rejects missing, malformed, stale, or invalid signatures without domain parsing.
 */
export function verifyWebhookSignature({
  rawPayload,
  signature,
  timestamp,
  secrets = getWebhookSecrets(),
  maxAgeMs = DEFAULT_SIGNATURE_MAX_AGE_MS,
}: WebhookSignatureVerificationOptions): VerificationResult {
  if (!secrets || secrets.length === 0) {
    return {
      valid: false,
      error: 'missing_secret',
      message: 'Webhook processing is not configured',
    };
  }

  if (signature === null || signature === undefined) {
    return {
      valid: false,
      error: 'missing_signature',
      message: 'No signature provided',
    };
  }

  const normalizedSignature = signature.trim();

  // Validate hex format and length (HMAC-SHA512 produces 128 hex characters)
  if (!/^[0-9a-fA-F]{128}$/.test(normalizedSignature)) {
    return {
      valid: false,
      error: 'malformed_signature',
      message: 'Malformed signature',
    };
  }

  // Check timestamp if provided to reject stale signatures
  if (timestamp) {
    const parsedTime = Number(timestamp);
    if (!Number.isNaN(parsedTime)) {
      // Support both unix timestamp in seconds and milliseconds
      const timeMs = parsedTime < 1e12 ? parsedTime * 1000 : parsedTime;
      const age = Math.abs(Date.now() - timeMs);
      if (age > maxAgeMs) {
        return {
          valid: false,
          error: 'stale_signature',
          message: 'Stale webhook signature',
        };
      }
    }
  }

  // Verify against all active secrets (supporting key rotation)
  for (const secret of secrets) {
    const expectedHash = crypto
      .createHmac('sha512', secret)
      .update(rawPayload)
      .digest('hex');

    if (verifySignatureConstantTime(expectedHash, normalizedSignature)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    error: 'invalid_signature',
    message: 'Invalid signature',
  };
}
