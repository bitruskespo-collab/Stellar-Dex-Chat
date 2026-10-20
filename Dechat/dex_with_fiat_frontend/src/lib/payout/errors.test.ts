import { describe, it, expect, vi } from 'vitest';
import {
  API_VERSION,
  createPayoutErrorResponse,
  validationError,
  authorizationError,
  providerError,
  rateLimitError,
  internalError,
  extractOrGenerateCorrelationId,
  redactSecrets,
  logStructuredError,
} from './errors';

describe('Payout API Versioned Error Responses (#45)', () => {
  describe('Error Schema & Structure', () => {
    it('creates a compliant versioned error response', async () => {
      const res = createPayoutErrorResponse({
        status: 400,
        code: 'VALIDATION_ERROR',
        userMessage: 'Invalid input provided',
        category: 'validation',
        retryable: false,
        correlationId: 'test-correlation-123',
        details: [{ field: 'account_number', message: 'Must be 10 digits' }],
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('X-Correlation-Id')).toBe('test-correlation-123');

      const body = await res.json();
      expect(body.version).toBe(API_VERSION);
      expect(body.success).toBe(false);
      expect(body.message).toBe('Invalid input provided');
      expect(body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Invalid input provided',
        category: 'validation',
        retryable: false,
        correlationId: 'test-correlation-123',
        details: [{ field: 'account_number', message: 'Must be 10 digits' }],
      });
    });
  });

  describe('Category Mappings', () => {
    it('maps validation errors consistently', async () => {
      const res = validationError({
        message: 'Validation failed',
        correlationId: 'cid-val',
        issues: [{ path: ['bank_code'], message: 'Bank code required' }],
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.version).toBe('v1');
      expect(body.error.category).toBe('validation');
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.retryable).toBe(false);
      expect(body.error.details).toHaveLength(1);
      expect(body.error.details[0].field).toBe('bank_code');
      // Preserves top-level errors for backward compatibility
      expect(body.errors).toBeDefined();
    });

    it('maps authorization errors consistently (401 and 403)', async () => {
      const res401 = authorizationError({ status: 401, correlationId: 'cid-auth-1' });
      expect(res401.status).toBe(401);
      const body401 = await res401.json();
      expect(body401.error.category).toBe('authorization');
      expect(body401.error.code).toBe('UNAUTHORIZED');
      expect(body401.error.retryable).toBe(false);

      const res403 = authorizationError({ status: 403, correlationId: 'cid-auth-2' });
      expect(res403.status).toBe(403);
      const body403 = await res403.json();
      expect(body403.error.category).toBe('authorization');
      expect(body403.error.code).toBe('FORBIDDEN');
    });

    it('maps rate limit errors consistently with retry metadata', async () => {
      const res = rateLimitError({
        retryAfterSeconds: 30,
        correlationId: 'cid-rate',
        limitHeaders: { 'Retry-After': '30', 'X-RateLimit-Limit': '10' },
      });

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('30');
      expect(res.headers.get('X-RateLimit-Limit')).toBe('10');

      const body = await res.json();
      expect(body.error.category).toBe('rate_limit');
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(body.error.retryable).toBe(true);
      expect(body.retryAfter).toBe(30);
    });

    it('maps provider errors safely without leaking provider internals', async () => {
      const internalProviderError = {
        response: {
          status: 500,
          data: {
            message: 'Database connection failed at postgres://admin:secret@internal-db:5432',
          },
        },
      };

      const res = providerError({
        error: internalProviderError,
        correlationId: 'cid-prov',
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.category).toBe('provider');
      expect(body.error.code).toBe('PROVIDER_ERROR');
      expect(body.error.retryable).toBe(true);
      // Safe user message, secret database string is NOT leaked to user
      expect(body.error.message).not.toContain('postgres://');
      expect(body.message).not.toContain('secret');

      // Provider 422 mapped to safe 400
      const res422 = providerError({
        error: { response: { status: 422 } },
        correlationId: 'cid-prov-422',
      });
      expect(res422.status).toBe(400);
      const body422 = await res422.json();
      expect(body422.error.code).toBe('PROVIDER_REJECTED');
      expect(body422.error.retryable).toBe(false);
    });

    it('maps internal errors consistently', async () => {
      const res = internalError({
        correlationId: 'cid-int',
        message: 'Something went wrong',
      });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.category).toBe('internal');
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.retryable).toBe(true);
    });
  });

  describe('Diagnostics, Correlation ID & Secret Redaction', () => {
    it('extracts correlation ID from headers or generates one', () => {
      const headers = new Headers({ 'x-correlation-id': 'my-custom-cid' });
      expect(extractOrGenerateCorrelationId(headers)).toBe('my-custom-cid');

      const generated = extractOrGenerateCorrelationId(null);
      expect(typeof generated).toBe('string');
      expect(generated.length).toBeGreaterThan(10);
    });

    it('redacts sensitive fields from diagnostic logs', () => {
      const sensitiveData = {
        user: 'ada',
        accountNumber: '0123456789',
        secret_key: 'sk_live_1234567890',
        authorization: 'Bearer token-xyz',
        nested: {
          token: 'jwt-123',
          password: 'pass',
          safeField: 'visible',
        },
      };

      const redacted = redactSecrets(sensitiveData) as Record<string, unknown>;
      expect(redacted.accountNumber).toBe('[REDACTED]');
      expect(redacted.secret_key).toBe('[REDACTED]');
      expect(redacted.authorization).toBe('[REDACTED]');
      const nested = redacted.nested as Record<string, unknown>;
      expect(nested.token).toBe('[REDACTED]');
      expect(nested.password).toBe('[REDACTED]');
      expect(nested.safeField).toBe('visible');
    });

    it('logs structured errors without leaking secrets', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logStructuredError('test-ctx', new Error('Something failed'), {
        secret_key: 'sk_live_secret',
        endpoint: '/api/test',
      });

      expect(consoleSpy).toHaveBeenCalled();
      const loggedJson = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(loggedJson);
      expect(parsed.context).toBe('test-ctx');
      expect(parsed.secret_key).toBe('[REDACTED]');
      expect(parsed.endpoint).toBe('/api/test');

      consoleSpy.mockRestore();
    });
  });
});
