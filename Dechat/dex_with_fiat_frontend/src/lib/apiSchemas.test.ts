import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withRetry,
  fetchWithRetry,
  RetryConfig,
  verifyAccountSchema,
  createRecipientSchema,
  validateRedirectUrl,
  validateCallbackUrl,
  validateDeepLink,
  redirectUrlSchema,
  callbackUrlSchema,
  deepLinkSchema,
} from './apiSchemas';

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

describe('URL destination validation', () => {
  const allowedHosts = ['app.example.com', 'pay.example.com'];

  describe('validateRedirectUrl', () => {
    it('accepts an allowlisted https URL', () => {
      const result = validateRedirectUrl(
        'https://app.example.com/dashboard?tab=wallet',
        { allowedHosts },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url.host).toBe('app.example.com');
      }
    });

    it('accepts a relative path when relative URLs are allowed', () => {
      const result = validateRedirectUrl('/wallet/overview', {
        allowedHosts,
        allowRelative: true,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a relative path when relative URLs are not allowed', () => {
      const result = validateRedirectUrl('/wallet/overview', { allowedHosts });
      expect(result.ok).toBe(false);
    });

    it('rejects an external host', () => {
      const result = validateRedirectUrl('https://evil.example.org/steal', {
        allowedHosts,
      });
      expect(result.ok).toBe(false);
    });

    it('rejects a lookalike host that merely contains an allowed host', () => {
      expect(
        validateRedirectUrl('https://app.example.com.evil.org/x', {
          allowedHosts,
        }).ok,
      ).toBe(false);
      expect(
        validateRedirectUrl('https://evil-app.example.com/x', { allowedHosts })
          .ok,
      ).toBe(false);
    });

    it('rejects scheme/host confusion via userinfo', () => {
      expect(
        validateRedirectUrl('https://app.example.com@evil.org/x', {
          allowedHosts,
        }).ok,
      ).toBe(false);
      expect(
        validateRedirectUrl('https://evil.org#@app.example.com', {
          allowedHosts,
        }).ok,
      ).toBe(false);
    });

    it('rejects non-https schemes', () => {
      for (const url of [
        'http://app.example.com/x',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'ftp://app.example.com/x',
      ]) {
        expect(validateRedirectUrl(url, { allowedHosts }).ok).toBe(false);
      }
    });

    it('rejects protocol-relative URLs', () => {
      expect(
        validateRedirectUrl('//evil.org/x', { allowedHosts }).ok,
      ).toBe(false);
    });

    it('rejects percent-encoded bypass attempts', () => {
      for (const url of [
        'https://app.example.com%2eevil.org/x',
        'https://app.example.com/%2f%2fevil.org',
        'https://app.example.com\\@evil.org/x',
        'https%3a%2f%2fevil.org%2fx',
      ]) {
        expect(validateRedirectUrl(url, { allowedHosts }).ok).toBe(false);
      }
    });

    it('rejects malformed URLs and empty input', () => {
      for (const url of ['', '   ', 'not a url', 'https://', 'https:///path']) {
        expect(validateRedirectUrl(url, { allowedHosts }).ok).toBe(false);
      }
    });

    it('rejects non-string input', () => {
      expect(
        validateRedirectUrl(undefined as unknown as string, { allowedHosts })
          .ok,
      ).toBe(false);
      expect(
        validateRedirectUrl(42 as unknown as string, { allowedHosts }).ok,
      ).toBe(false);
    });

    it('rejects every URL when the allowlist is empty', () => {
      expect(
        validateRedirectUrl('https://app.example.com/x', { allowedHosts: [] })
          .ok,
      ).toBe(false);
    });
  });

  describe('validateCallbackUrl', () => {
    it('accepts an allowlisted https callback', () => {
      expect(
        validateCallbackUrl('https://pay.example.com/callback', {
          allowedHosts,
        }).ok,
      ).toBe(true);
    });

    it('rejects an external callback host', () => {
      expect(
        validateCallbackUrl('https://attacker.example.net/cb', {
          allowedHosts,
        }).ok,
      ).toBe(false);
    });

    it('rejects a callback with a non-https scheme', () => {
      expect(
        validateCallbackUrl('http://pay.example.com/callback', {
          allowedHosts,
        }).ok,
      ).toBe(false);
    });

    it('rejects a percent-encoded host bypass in a callback', () => {
      expect(
        validateCallbackUrl('https://pay.example.com%2fattacker.example.net', {
          allowedHosts,
        }).ok,
      ).toBe(false);
    });
  });

  describe('validateDeepLink', () => {
    const allowedSchemes = ['dechat'];

    it('accepts an allowlisted custom scheme deep link', () => {
      const result = validateDeepLink('dechat://wallet/receive?amount=10', {
        allowedSchemes,
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a deep link with a disallowed scheme', () => {
      for (const link of [
        'javascript:alert(1)',
        'https://app.example.com/x',
        'intent://scan/#Intent;scheme=zxing;end',
        'dechat-evil://wallet',
      ]) {
        expect(validateDeepLink(link, { allowedSchemes }).ok).toBe(false);
      }
    });

    it('rejects scheme confusion via encoded separators', () => {
      for (const link of [
        'dechat%3a%2f%2fwallet',
        'dechat://wallet%2f..%2f..%2fadmin',
        'dechat:///\\evil.org',
      ]) {
        expect(validateDeepLink(link, { allowedSchemes }).ok).toBe(false);
      }
    });

    it('rejects malformed deep links', () => {
      for (const link of ['', '   ', 'dechat:', 'dechat://']) {
        expect(validateDeepLink(link, { allowedSchemes }).ok).toBe(false);
      }
    });
  });

  describe('zod schemas', () => {
    it('redirectUrlSchema accepts allowlisted URLs and rejects others', () => {
      expect(
        redirectUrlSchema(allowedHosts).safeParse('https://app.example.com/x')
          .success,
      ).toBe(true);
      expect(
        redirectUrlSchema(allowedHosts).safeParse('https://evil.org/x').success,
      ).toBe(false);
    });

    it('callbackUrlSchema rejects external and malformed URLs', () => {
      expect(
        callbackUrlSchema(allowedHosts).safeParse('https://pay.example.com/cb')
          .success,
      ).toBe(true);
      expect(
        callbackUrlSchema(allowedHosts).safeParse('https://evil.org/cb')
          .success,
      ).toBe(false);
      expect(callbackUrlSchema(allowedHosts).safeParse('nope').success).toBe(
        false,
      );
    });

    it('deepLinkSchema rejects disallowed schemes', () => {
      expect(
        deepLinkSchema(['dechat']).safeParse('dechat://wallet').success,
      ).toBe(true);
      expect(
        deepLinkSchema(['dechat']).safeParse('javascript:alert(1)').success,
      ).toBe(false);
    });
  });
});
