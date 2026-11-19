import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withRetry,
  fetchWithRetry,
  RetryConfig,
  verifyAccountSchema,
  createRecipientSchema,
} from './apiSchemas';
import {
  loadOpenApiSchema,
  validateAgainstSchema,
  getSchemaOperation,
  listSchemaOperations,
} from './openApiContract';

describe('apiSchemas - Request Retry with Exponential Backoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on network errors', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue('success');

      const promise = withRetry(fn);

      // Fake timers are installed, so the backoff sleep between attempts only
      // resolves once the pending timers are drained.
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should respect maxRetries configuration', async () => {
      const fn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const config: RetryConfig = { maxRetries: 2 };

      // Attach the rejection handler before draining timers, otherwise the
      // rejection lands while nothing is listening and surfaces as an
      // unhandled rejection.
      const assertion = expect(withRetry(fn, config)).rejects.toThrow(
        'Failed to fetch',
      );
      await vi.runAllTimersAsync();
      await assertion;

      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should use exponential backoff', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue('success');

      const promise = withRetry(fn, { initialDelayMs: 100, maxRetries: 2 });
      
      // Advance timers for first retry
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      
      // Advance timers for second retry
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('Validation error'));
      
      await expect(withRetry(fn)).rejects.toThrow('Validation error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should not retry on AbortError', async () => {
      const fn = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      await expect(withRetry(fn)).rejects.toThrow(
        expect.objectContaining({ name: 'AbortError' }),
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should respect custom retryable error function', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Custom error'))
        .mockResolvedValue('success');

      const config: RetryConfig = {
        retryableErrors: (error: unknown) => 
          error instanceof Error && error.message === 'Custom error'
      };

      const promise = withRetry(fn, config);
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should cap delay at maxDelayMs', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue('success');

      const config: RetryConfig = {
        initialDelayMs: 1000,
        maxDelayMs: 1500,
        maxRetries: 2
      };

      const promise = withRetry(fn, config);
      
      // First retry should be ~1000ms
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();
      
      // Second retry should be capped at 1500ms (not 2000ms)
      vi.advanceTimersByTime(1500);
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
    });

    it('should add jitter to avoid thundering herd', async () => {
      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;

      const spy: typeof global.setTimeout = ((
        callback: Parameters<typeof global.setTimeout>[0],
        delay?: number,
      ) => {
        delays.push(delay as number);
        return originalSetTimeout(callback, delay);
      }) as typeof global.setTimeout;
      global.setTimeout = spy;

      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue('success');

      const promise = withRetry(fn, { initialDelayMs: 1000 });
      await vi.runAllTimersAsync();
      await promise;

      // Delay should be close to 1000ms but with jitter (±25%)
      expect(delays[0]).toBeGreaterThan(750);
      expect(delays[0]).toBeLessThan(1250);

      global.setTimeout = originalSetTimeout;
    });
  });

  describe('fetchWithRetry', () => {
    it('should succeed on successful fetch', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      } as Response);

      const result = await fetchWithRetry('https://api.example.com/test');
      expect(result.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on 500 status code', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'test' }) } as Response);

      const promise = fetchWithRetry('https://api.example.com/test');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 503 status code', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'test' }) } as Response);

      const promise = fetchWithRetry('https://api.example.com/test');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should retry on 429 status code (rate limit)', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'test' }) } as Response);

      const promise = fetchWithRetry('https://api.example.com/test');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('should not retry on 404 status code', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      await expect(fetchWithRetry('https://api.example.com/test')).rejects.toThrow('HTTP 404');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 400 status code', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      } as Response);

      await expect(fetchWithRetry('https://api.example.com/test')).rejects.toThrow('HTTP 400');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('should pass fetch options correctly', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      } as Response);

      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      };

      await fetchWithRetry('https://api.example.com/test', options);
      expect(fetch).toHaveBeenCalledWith('https://api.example.com/test', options);
    });

    it('should use custom retryable status codes', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 418, statusText: "I'm a teapot" } as Response)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: 'test' }) } as Response);

      const config: RetryConfig = {
        retryableStatusCodes: [418],
      };

      const promise = fetchWithRetry('https://api.example.com/test', {}, config);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('default configuration', () => {
    it('should use default maxRetries of 3', async () => {
      const fn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const assertion = expect(withRetry(fn)).rejects.toThrow(
        'Failed to fetch',
      );
      await vi.runAllTimersAsync();
      await assertion;

      expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
    });

    it('should use default initialDelayMs of 1000', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue('success');

      const promise = withRetry(fn);
      
      // Advance by default initial delay
      vi.advanceTimersByTime(1000);
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
    });

    it('should use default backoffMultiplier of 2', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValue('success');

      const promise = withRetry(fn, { initialDelayMs: 100 });
      
      // First retry: 100ms
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      
      // Second retry: 200ms (100 * 2)
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe('success');
    });
  });
});

describe('verifyAccountSchema', () => {
  it('accepts a valid 10-digit NUBAN account number and bank code', () => {
    const result = verifyAccountSchema.safeParse({
      accountNumber: '1234567890',
      bankCode: '058',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an account number that is not exactly 10 digits', () => {
    expect(
      verifyAccountSchema.safeParse({ accountNumber: '123', bankCode: '058' })
        .success,
    ).toBe(false);
    expect(
      verifyAccountSchema.safeParse({
        accountNumber: '12345678901',
        bankCode: '058',
      }).success,
    ).toBe(false);
  });

  it('rejects a bank code outside the 3-6 digit range', () => {
    expect(
      verifyAccountSchema.safeParse({
        accountNumber: '1234567890',
        bankCode: '1',
      }).success,
    ).toBe(false);
    expect(
      verifyAccountSchema.safeParse({
        accountNumber: '1234567890',
        bankCode: '1234567',
      }).success,
    ).toBe(false);
  });

  it('rejects a query-parameter injection attempt in accountNumber', () => {
    const result = verifyAccountSchema.safeParse({
      accountNumber: '0123456789&currency=USD',
      bankCode: '058',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric account numbers and bank codes', () => {
    expect(
      verifyAccountSchema.safeParse({
        accountNumber: 'abcdefghij',
        bankCode: '058',
      }).success,
    ).toBe(false);
    expect(
      verifyAccountSchema.safeParse({
        accountNumber: '1234567890',
        bankCode: 'abc',
      }).success,
    ).toBe(false);
  });
});

describe('createRecipientSchema', () => {
  const valid = {
    type: 'nuban',
    name: 'Test Account',
    account_number: '1234567890',
    bank_code: '058',
    currency: 'NGN',
  };

  it('accepts a valid payload', () => {
    expect(createRecipientSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a query-parameter injection attempt in account_number', () => {
    const result = createRecipientSchema.safeParse({
      ...valid,
      account_number: '0123456789¤cy=USD',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bank_code outside the 3-6 digit range', () => {
    expect(
      createRecipientSchema.safeParse({ ...valid, bank_code: '12' }).success,
    ).toBe(false);
  });

  it('rejects a currency other than NGN', () => {
    expect(
      createRecipientSchema.safeParse({ ...valid, currency: 'USD' }).success,
    ).toBe(false);
  });

  it('rejects an oversized name or type', () => {
    expect(
      createRecipientSchema.safeParse({ ...valid, name: 'a'.repeat(101) })
        .success,
    ).toBe(false);
    expect(
      createRecipientSchema.safeParse({ ...valid, type: 'a'.repeat(51) })
        .success,
    ).toBe(false);
  });
});

/**
 * Consumer contract tests (#278).
 *
 * Every response asserted here is validated against the versioned OpenAPI
 * schema so that undocumented response drift fails the build. All fixtures are
 * synthetic: no credentials, tokens or real user data are used.
 */
describe('API consumer contract - published OpenAPI schema', () => {
  const schema = loadOpenApiSchema();

  const syntheticAccount = {
    accountNumber: '0000000000',
    bankCode: '000',
  };

  const syntheticRecipient = {
    type: 'nuban',
    name: 'Synthetic Test Account',
    account_number: '0000000000',
    bank_code: '000',
    currency: 'NGN',
  };

  it('loads a versioned schema that documents the consumer routes', () => {
    expect(schema.openapi).toMatch(/^3\./);
    expect(typeof schema.info.version).toBe('string');
    expect(schema.info.version.length).toBeGreaterThan(0);

    const operations = listSchemaOperations();
    expect(operations).toEqual(
      expect.arrayContaining([
        'GET /health',
        'POST /api/verify-account',
        'POST /api/recipients',
        'GET /api/admin/recipients',
      ]),
    );
  });

  describe('POST /api/verify-account', () => {
    const operation = getSchemaOperation('POST /api/verify-account');

    it('documents a 200 success response', () => {
      expect(operation.responses['200']).toBeDefined();
    });

    it('accepts a valid request body', () => {
      const result = validateAgainstSchema(
        operation.requestBody,
        syntheticAccount,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects malformed request bodies with a documented 400', () => {
      expect(operation.responses['400']).toBeDefined();

      const malformed = [
        { accountNumber: '123', bankCode: '000' },
        { accountNumber: '0000000000', bankCode: '0' },
        { accountNumber: '0000000000&currency=USD', bankCode: '000' },
        { bankCode: '000' },
      ];

      for (const body of malformed) {
        const result = validateAgainstSchema(operation.requestBody, body);
        expect(result.valid).toBe(false);
      }
    });

    it('documents a provider-failure response', () => {
      expect(
        operation.responses['502'] ?? operation.responses['503'],
      ).toBeDefined();
    });

    it('validates a success response body against the schema', () => {
      const response = {
        accountName: 'SYNTHETIC TEST ACCOUNT',
        accountNumber: '0000000000',
        bankCode: '000',
      };
      const result = validateAgainstSchema(
        operation.responses['200'],
        response,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects an undocumented success response shape', () => {
      const drifted = { account_name: 'SYNTHETIC TEST ACCOUNT' };
      const result = validateAgainstSchema(operation.responses['200'], drifted);
      expect(result.valid).toBe(false);
    });
  });

  describe('POST /api/recipients', () => {
    const operation = getSchemaOperation('POST /api/recipients');

    it('accepts a valid request body', () => {
      const result = validateAgainstSchema(
        operation.requestBody,
        syntheticRecipient,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects malformed request bodies with a documented 400', () => {
      expect(operation.responses['400']).toBeDefined();

      const malformed = [
        { ...syntheticRecipient, account_number: '123' },
        { ...syntheticRecipient, bank_code: '1' },
        { ...syntheticRecipient, currency: 'USD' },
        { ...syntheticRecipient, name: '' },
      ];

      for (const body of malformed) {
        const result = validateAgainstSchema(operation.requestBody, body);
        expect(result.valid).toBe(false);
      }
    });

    it('documents a provider-failure response', () => {
      expect(
        operation.responses['502'] ?? operation.responses['503'],
      ).toBeDefined();
    });

    it('validates a success response body against the schema', () => {
      const response = {
        recipient_code: 'RCP_SYNTHETIC0001',
        type: 'nuban',
        name: 'Synthetic Test Account',
        account_number: '0000000000',
        bank_code: '000',
        currency: 'NGN',
        active: true,
      };
      const result = validateAgainstSchema(
        operation.responses['201'] ?? operation.responses['200'],
        response,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('GET /api/admin/recipients', () => {
    const operation = getSchemaOperation('GET /api/admin/recipients');

    it('documents authorization failures for admin routes', () => {
      expect(operation.responses['401']).toBeDefined();
      expect(operation.responses['403']).toBeDefined();
    });

    it('validates a documented error body for unauthorized access', () => {
      const unauthorized = { error: 'Unauthorized' };
      const result = validateAgainstSchema(
        operation.responses['401'],
        unauthorized,
      );
      expect(result.valid).toBe(true);
    });

    it('validates a success response body against the schema', () => {
      const response = {
        data: [
          {
            recipient_code: 'RCP_SYNTHETIC0001',
            type: 'nuban',
            name: 'Synthetic Test Account',
            account_number: '0000000000',
            bank_code: '000',
            currency: 'NGN',
            active: true,
          },
        ],
      };
      const result = validateAgainstSchema(
        operation.responses['200'],
        response,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('GET /health', () => {
    const operation = getSchemaOperation('GET /health');

    it('validates the health response body against the schema', () => {
      const result = validateAgainstSchema(operation.responses['200'], {
        status: 'ok',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects an undocumented health response shape', () => {
      const result = validateAgainstSchema(operation.responses['200'], {
        healthy: true,
      });
      expect(result.valid).toBe(false);
    });
  });
});
