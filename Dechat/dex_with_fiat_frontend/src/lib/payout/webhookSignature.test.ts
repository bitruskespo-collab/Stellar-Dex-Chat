import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import crypto from 'crypto';
import {
  verifyWebhookSignature,
  verifySignatureConstantTime,
} from './webhookSignature';

describe('Webhook Signature Verification (Issue #34)', () => {
  const primarySecret = 'sk_test_primary_secret_1234567890abcdef';
  const previousSecret = 'sk_test_previous_secret_0987654321fedcba';
  const samplePayload = JSON.stringify({
    event: 'transfer.success',
    data: { reference: 'TRF_sig_1', amount: 5000 },
  });

  function sign(payload: string, secret: string): string {
    return crypto.createHmac('sha512', secret).update(payload).digest('hex');
  }

  describe('Constant-time signature comparison', () => {
    it('accepts equal 128-char hex signatures', () => {
      const sig = sign(samplePayload, primarySecret);
      expect(verifySignatureConstantTime(sig, sig)).toBe(true);
      expect(verifySignatureConstantTime(sig.toUpperCase(), sig.toLowerCase())).toBe(true);
    });

    it('rejects differing signatures of equal length', () => {
      const sig1 = sign(samplePayload, primarySecret);
      const sig2 = sign(samplePayload, previousSecret);
      expect(verifySignatureConstantTime(sig1, sig2)).toBe(false);
    });

    it('rejects non-hex or invalid length strings', () => {
      expect(verifySignatureConstantTime('short', 'short')).toBe(false);
      expect(
        verifySignatureConstantTime(
          'g'.repeat(128), // 'g' is not hex
          'g'.repeat(128),
        ),
      ).toBe(false);
    });
  });

  describe('verifyWebhookSignature pipeline', () => {
    it('verifies valid HMAC-SHA512 signature', () => {
      const validSig = sign(samplePayload, primarySecret);
      const res = verifyWebhookSignature({
        rawPayload: samplePayload,
        signature: validSig,
        secrets: [primarySecret],
      });
      expect(res.valid).toBe(true);
    });

    it('rejects missing signature', () => {
      const res = verifyWebhookSignature({
        rawPayload: samplePayload,
        signature: null,
        secrets: [primarySecret],
      });
      expect(res.valid).toBe(false);
      expect(res.error).toBe('missing_signature');
    });

    it('rejects malformed signature', () => {
      const malformedVectors = [
        '',
        'invalid-hex',
        'a'.repeat(64), // only 64 chars instead of 128
        'z'.repeat(128), // non-hex character 'z'
        '12345',
      ];

      for (const badSig of malformedVectors) {
        const res = verifyWebhookSignature({
          rawPayload: samplePayload,
          signature: badSig,
          secrets: [primarySecret],
        });
        expect(res.valid).toBe(false);
        expect(res.error).toBe('malformed_signature');
      }
    });

    it('rejects tampered payload', () => {
      const validSig = sign(samplePayload, primarySecret);
      const tamperedPayload = samplePayload.replace('5000', '9999');

      const res = verifyWebhookSignature({
        rawPayload: tamperedPayload,
        signature: validSig,
        secrets: [primarySecret],
      });
      expect(res.valid).toBe(false);
      expect(res.error).toBe('invalid_signature');
    });

    it('rejects stale signature timestamp', () => {
      const validSig = sign(samplePayload, primarySecret);
      const staleTimestamp = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago

      const res = verifyWebhookSignature({
        rawPayload: samplePayload,
        signature: validSig,
        timestamp: staleTimestamp,
        secrets: [primarySecret],
        maxAgeMs: 5 * 60 * 1000,
      });
      expect(res.valid).toBe(false);
      expect(res.error).toBe('stale_signature');
    });

    it('accepts fresh signature timestamp within tolerance', () => {
      const validSig = sign(samplePayload, primarySecret);
      const freshTimestamp = String(Date.now() - 30 * 1000); // 30 seconds ago

      const res = verifyWebhookSignature({
        rawPayload: samplePayload,
        signature: validSig,
        timestamp: freshTimestamp,
        secrets: [primarySecret],
      });
      expect(res.valid).toBe(true);
    });

    it('supports key rotation across bounded overlap window', () => {
      // Signature signed with previous secret during rotation window
      const sigFromOldKey = sign(samplePayload, previousSecret);

      const res = verifyWebhookSignature({
        rawPayload: samplePayload,
        signature: sigFromOldKey,
        secrets: [primarySecret, previousSecret],
      });

      expect(res.valid).toBe(true);
    });

    it('rejects if signature does not match any configured rotated secret', () => {
      const unrelatedSecret = 'sk_test_unrelated_secret_key_1111111111';
      const invalidSig = sign(samplePayload, unrelatedSecret);

      const res = verifyWebhookSignature({
        rawPayload: samplePayload,
        signature: invalidSig,
        secrets: [primarySecret, previousSecret],
      });

      expect(res.valid).toBe(false);
      expect(res.error).toBe('invalid_signature');
    });
  });
});
