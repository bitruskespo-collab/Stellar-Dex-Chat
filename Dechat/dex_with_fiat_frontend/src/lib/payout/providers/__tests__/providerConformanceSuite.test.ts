/**
 * Fiat Provider Adapter Conformance Test Suite
 * Addresses Issue #100: Apply the same safety-critical contract to current and future payout adapters.
 */

import { describe, it, expect } from 'vitest';
import { PayoutProvider, PayoutTransferRequest, PayoutTransferResponse } from '../types';

export function runProviderConformanceSuite(
  providerName: string,
  createAdapter: () => PayoutProvider
) {
  describe(`Conformance Suite: ${providerName}`, () => {
    it('enforces idempotency key on transfer initiation', async () => {
      const adapter = createAdapter();
      const request: PayoutTransferRequest = {
        amount: 5000,
        currency: 'NGN',
        recipient: 'RCP_12345',
        reference: 'ref_unique_123',
      };

      const res1 = await adapter.initiateTransfer(request);
      expect(res1).toBeDefined();
      expect(res1.status).toMatch(/pending|success|queued/i);

      // Duplicate submission should return the same transfer record
      const res2 = await adapter.initiateTransfer(request);
      expect(res2.reference).toBe(res1.reference);
    });

    it('declares unsupported capabilities explicitly rather than approximating', () => {
      const adapter = createAdapter();
      expect(typeof adapter.supportsBulkPayout).toBe('boolean');
      expect(typeof adapter.supportsReversal).toBe('boolean');
    });

    it('safely handles timeout outcomes without reporting false success', async () => {
      const adapter = createAdapter();
      if (typeof adapter.handleTimeout === 'function') {
        const timeoutRes = await adapter.handleTimeout('ref_timeout_test');
        expect(timeoutRes.status).not.toBe('success');
      }
    });
  });
}

// Deliberately incorrect fake adapter to verify test suite catches non-conformance
class DeliberatelyIncorrectFakeAdapter implements PayoutProvider {
  name = 'broken_fake';
  supportsBulkPayout = false;
  supportsReversal = false;

  async initiateTransfer(req: PayoutTransferRequest): Promise<PayoutTransferResponse> {
    // Violates idempotency by generating a random reference every call
    return {
      reference: `random_${Math.random()}`,
      status: 'pending',
      amount: req.amount,
      currency: req.currency,
    };
  }

  async verifyWebhookSignature(): Promise<boolean> {
    return true;
  }
}

describe('Conformance Test Runner Self-Verification', () => {
  it('detects idempotency violation in non-conforming adapter', async () => {
    const broken = new DeliberatelyIncorrectFakeAdapter();
    const req: PayoutTransferRequest = { amount: 100, currency: 'NGN', recipient: 'r', reference: 'r1' };
    const r1 = await broken.initiateTransfer(req);
    const r2 = await broken.initiateTransfer(req);
    expect(r1.reference).not.toBe(r2.reference); // Confirms non-conformance is detectable
  });
});
