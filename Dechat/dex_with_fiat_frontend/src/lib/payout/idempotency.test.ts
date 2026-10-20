import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeIdempotentPayout,
  clearIdempotencyStore,
  computePayloadHash,
  IdempotencyPayloadMismatchError,
} from './idempotency';

describe('Idempotent Payout Initiation (Issue #32)', () => {
  beforeEach(() => {
    clearIdempotencyStore();
  });

  it('computes stable payload hash regardless of object key order', () => {
    const payload1 = {
      amount: 1000,
      recipient: 'RCP_123',
      source: 'balance',
      reason: 'withdrawal',
    };
    const payload2 = {
      reason: 'withdrawal',
      source: 'balance',
      recipient: 'RCP_123',
      amount: 1000,
    };
    expect(computePayloadHash(payload1)).toBe(computePayloadHash(payload2));
  });

  it('returns original result on identical retry without calling provider again', async () => {
    const providerFn = vi.fn().mockResolvedValue({
      reference: 'TRF_idemp_1',
      status: 'pending',
      transfer_code: 'TRF_idemp_1',
    });

    const payload = {
      amount: 5000,
      recipient: 'RCP_user1',
      source: 'balance',
      reason: 'payout',
    };

    // First call
    const result1 = await executeIdempotentPayout({
      idempotencyKey: 'key_123',
      userId: 'user_abc',
      payload,
      execute: providerFn,
    });

    expect(result1.isRetry).toBe(false);
    expect(result1.data.reference).toBe('TRF_idemp_1');
    expect(providerFn).toHaveBeenCalledTimes(1);

    // Second call: identical retry
    const result2 = await executeIdempotentPayout({
      idempotencyKey: 'key_123',
      userId: 'user_abc',
      payload,
      execute: providerFn,
    });

    expect(result2.isRetry).toBe(true);
    expect(result2.data.reference).toBe('TRF_idemp_1');
    // Provider was NOT called a second time
    expect(providerFn).toHaveBeenCalledTimes(1);
  });

  it('rejects key reuse with a different payload', async () => {
    const providerFn = vi.fn().mockResolvedValue({ reference: 'TRF_idemp_2' });

    const payloadOriginal = {
      amount: 5000,
      recipient: 'RCP_user1',
      source: 'balance',
      reason: 'payout',
    };

    await executeIdempotentPayout({
      idempotencyKey: 'key_reused',
      userId: 'user_abc',
      payload: payloadOriginal,
      execute: providerFn,
    });

    // Reusing same key with different amount
    const payloadDifferent = {
      amount: 10000,
      recipient: 'RCP_user1',
      source: 'balance',
      reason: 'payout',
    };

    await expect(
      executeIdempotentPayout({
        idempotencyKey: 'key_reused',
        userId: 'user_abc',
        payload: payloadDifferent,
        execute: providerFn,
      }),
    ).rejects.toThrow(IdempotencyPayloadMismatchError);

    // Provider was only called once
    expect(providerFn).toHaveBeenCalledTimes(1);
  });

  it('isolates idempotency keys across different users', async () => {
    const providerFn = vi.fn().mockImplementation(async () => ({
      reference: 'TRF_different_users',
    }));

    const payload = { amount: 2000, recipient: 'RCP_1' };

    // Same idempotencyKey but different user
    await executeIdempotentPayout({
      idempotencyKey: 'shared_key',
      userId: 'user_A',
      payload,
      execute: providerFn,
    });

    await executeIdempotentPayout({
      idempotencyKey: 'shared_key',
      userId: 'user_B',
      payload,
      execute: providerFn,
    });

    // Both calls executed because keys are scoped to user
    expect(providerFn).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent duplicate requests by resolving all callers to the single provider response', async () => {
    let resolveProvider!: (value: unknown) => void;
    const providerPromise = new Promise((res) => {
      resolveProvider = res;
    });
    const providerFn = vi.fn().mockImplementation(() => providerPromise);

    const payload = { amount: 3000, recipient: 'RCP_concurrent' };

    // Launch two concurrent requests with identical key and payload
    const req1 = executeIdempotentPayout({
      idempotencyKey: 'concurrent_key',
      userId: 'user_concurrent',
      payload,
      execute: providerFn,
    });

    const req2 = executeIdempotentPayout({
      idempotencyKey: 'concurrent_key',
      userId: 'user_concurrent',
      payload,
      execute: providerFn,
    });

    // Resolve the single provider call
    resolveProvider({ reference: 'TRF_concurrent_ok', status: 'pending' });

    const [res1, res2] = await Promise.all([req1, req2]);

    expect(providerFn).toHaveBeenCalledTimes(1);
    expect(res1.data).toEqual({ reference: 'TRF_concurrent_ok', status: 'pending' });
    expect(res2.data).toEqual({ reference: 'TRF_concurrent_ok', status: 'pending' });
    expect(res1.isRetry || res2.isRetry).toBe(true);
  });

  it('handles timeout-after-provider-success so retry receives cached result', async () => {
    const providerResponse = {
      reference: 'TRF_timeout_success',
      status: 'pending',
    };

    const providerFn = vi.fn().mockResolvedValue(providerResponse);
    const payload = { amount: 4500, recipient: 'RCP_timeout' };

    // First request initiates and succeeds at provider
    const res1 = await executeIdempotentPayout({
      idempotencyKey: 'timeout_key',
      userId: 'user_timeout',
      payload,
      execute: providerFn,
    });
    expect(res1.data).toEqual(providerResponse);
    expect(providerFn).toHaveBeenCalledTimes(1);

    // Suppose browser experienced network timeout receiving response and retries
    const retryRes = await executeIdempotentPayout({
      idempotencyKey: 'timeout_key',
      userId: 'user_timeout',
      payload,
      execute: providerFn,
    });

    expect(retryRes.isRetry).toBe(true);
    expect(retryRes.data).toEqual(providerResponse);
    expect(providerFn).toHaveBeenCalledTimes(1);
  });
});
