import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

export const API_VERSION = 'v1' as const;

export type PayoutErrorCategory =
  | 'validation'
  | 'authorization'
  | 'provider'
  | 'rate_limit'
  | 'internal';

export type PayoutErrorCode =
  // Validation errors (400)
  | 'VALIDATION_ERROR'
  | 'MALFORMED_REQUEST'
  | 'INVALID_INPUT'
  // Authorization errors (401, 403)
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  // Rate limiting (429)
  | 'RATE_LIMIT_EXCEEDED'
  // Provider errors (400, 422, 502, 504)
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_REJECTED'
  // Business logic / state errors (404, 409)
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSFER_SETTLED'
  | 'CANCELLATION_REJECTED'
  // Internal errors (500)
  | 'INTERNAL_ERROR';

export interface PayoutErrorDetail {
  field?: string;
  message: string;
  code?: string;
}

export interface PayoutApiErrorShape {
  code: PayoutErrorCode;
  message: string;
  category: PayoutErrorCategory;
  retryable: boolean;
  correlationId: string;
  details?: PayoutErrorDetail[];
}

/**
 * Standard typed versioned error response body.
 * Preserves backwards compatibility with legacy client fields:
 * - `message`
 * - `errors`
 * - `retryAfter`
 */
export interface PayoutApiErrorResponse {
  version: typeof API_VERSION;
  success: false;
  message: string;
  retryAfter?: number;
  errors?: unknown[];
  error: PayoutApiErrorShape;
}

/**
 * Extracts correlation ID from incoming request headers or generates a new UUID.
 */
export function extractOrGenerateCorrelationId(
  headers?: Headers | Record<string, string | string[] | undefined> | null,
): string {
  if (!headers) {
    return randomUUID();
  }

  if (typeof (headers as Headers).get === 'function') {
    const fromHeaders =
      (headers as Headers).get('x-correlation-id') ||
      (headers as Headers).get('x-request-id');
    if (fromHeaders) return fromHeaders;

    const traceparent = (headers as Headers).get('traceparent');
    if (traceparent) {
      const parts = traceparent.split('-');
      return parts[1] || traceparent;
    }
  } else {
    const raw = headers as Record<string, string | string[] | undefined>;
    const fromObj = raw['x-correlation-id'] || raw['x-request-id'];
    if (typeof fromObj === 'string' && fromObj) return fromObj;
    if (Array.isArray(fromObj) && fromObj[0]) return fromObj[0];

    const traceparent = raw['traceparent'];
    if (typeof traceparent === 'string' && traceparent) {
      const parts = traceparent.split('-');
      return parts[1] || traceparent;
    }
  }

  return randomUUID();
}

/**
 * Redacts sensitive fields (API keys, account numbers, tokens, authorization headers)
 * from structured log contexts.
 */
const SENSITIVE_KEY_REGEX =
  /(authorization|secret|key|token|password|account_number|accountnumber|cookie|credential)/i;

export function redactSecrets(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    if (data.length > 500) {
      return `${data.slice(0, 500)}...[TRUNCATED]`;
    }
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((item) => redactSecrets(item));
  }
  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = redactSecrets(v);
      }
    }
    return sanitized;
  }
  return data;
}

/**
 * Structured diagnostics logger that preserves server context without leaking secrets.
 */
export function logStructuredError(
  context: string,
  error: unknown,
  metadata?: Record<string, unknown>,
): void {
  const sanitizedMeta = redactSecrets(metadata || {}) as Record<string, unknown>;
  const errMessage = error instanceof Error ? error.message : String(error);
  const errStack = error instanceof Error ? error.stack : undefined;

  console.error(
    JSON.stringify({
      level: 'error',
      context,
      message: errMessage,
      stack: errStack,
      ...sanitizedMeta,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Builds a typed, versioned NextResponse for payout API errors.
 */
export function createPayoutErrorResponse(options: {
  status: number;
  code: PayoutErrorCode;
  userMessage: string;
  category: PayoutErrorCategory;
  retryable: boolean;
  correlationId?: string;
  details?: PayoutErrorDetail[];
  retryAfter?: number;
  rawErrors?: unknown[];
  headers?: HeadersInit;
}): NextResponse {
  const correlationId = options.correlationId || randomUUID();

  const responseBody: PayoutApiErrorResponse = {
    version: API_VERSION,
    success: false,
    message: options.userMessage,
    error: {
      code: options.code,
      message: options.userMessage,
      category: options.category,
      retryable: options.retryable,
      correlationId,
      ...(options.details && options.details.length > 0
        ? { details: options.details }
        : {}),
    },
    ...(options.rawErrors ? { errors: options.rawErrors } : {}),
    ...(typeof options.retryAfter === 'number'
      ? { retryAfter: options.retryAfter }
      : {}),
  };

  const responseHeaders = new Headers(options.headers || {});
  responseHeaders.set('X-Correlation-Id', correlationId);
  responseHeaders.set('Content-Type', 'application/json');

  if (typeof options.retryAfter === 'number') {
    responseHeaders.set('Retry-After', String(options.retryAfter));
  }

  return NextResponse.json(responseBody, {
    status: options.status,
    headers: responseHeaders,
  });
}

/**
 * Standard factory helpers for consistent category mapping.
 */

export function validationError(options: {
  message?: string;
  correlationId?: string;
  issues?: Array<{ path?: (string | number)[]; message: string; code?: string }>;
  code?: PayoutErrorCode;
}): NextResponse {
  const details: PayoutErrorDetail[] = (options.issues || []).map((issue) => ({
    field: issue.path ? issue.path.join('.') : undefined,
    message: issue.message,
    code: issue.code,
  }));

  return createPayoutErrorResponse({
    status: 400,
    code: options.code || 'VALIDATION_ERROR',
    userMessage: options.message || 'Validation failed',
    category: 'validation',
    retryable: false,
    correlationId: options.correlationId,
    details,
    rawErrors: options.issues,
  });
}

export function authorizationError(options: {
  status?: 401 | 403;
  message?: string;
  correlationId?: string;
  code?: 'UNAUTHORIZED' | 'FORBIDDEN';
}): NextResponse {
  const status = options.status || 401;
  const defaultCode = status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED';
  const defaultMsg =
    status === 403 ? 'Access forbidden' : 'Authentication required';

  return createPayoutErrorResponse({
    status,
    code: options.code || defaultCode,
    userMessage: options.message || defaultMsg,
    category: 'authorization',
    retryable: false,
    correlationId: options.correlationId,
  });
}

export function rateLimitError(options: {
  retryAfterSeconds: number;
  correlationId?: string;
  maxRequests?: number;
  limitHeaders?: Record<string, string>;
}): NextResponse {
  const userMessage = `Rate limit exceeded. Please try again in ${options.retryAfterSeconds} seconds.`;

  return createPayoutErrorResponse({
    status: 429,
    code: 'RATE_LIMIT_EXCEEDED',
    userMessage,
    category: 'rate_limit',
    retryable: true,
    retryAfter: options.retryAfterSeconds,
    correlationId: options.correlationId,
    details: [
      {
        field: 'rate_limit',
        message: `Quota exceeded. Retry after ${options.retryAfterSeconds}s.`,
      },
    ],
    headers: options.limitHeaders,
  });
}

export function providerError(options: {
  error: unknown;
  correlationId?: string;
  safeMessage?: string;
  status?: number;
}): NextResponse {
  // Check if it's an HTTP 422 from provider (invalid account/bank code)
  const httpError =
    options.error !== null &&
    typeof options.error === 'object' &&
    'response' in options.error
      ? (options.error as {
          response?: { status?: number; data?: { message?: string } };
        })
      : null;

  const providerStatus = httpError?.response?.status;
  const isTimeout =
    options.error instanceof Error &&
    /timeout|timed out|econnreset|etimedout/i.test(options.error.message);

  let status = options.status || 502;
  let code: PayoutErrorCode = 'PROVIDER_ERROR';
  let retryable = true;
  let userMessage =
    options.safeMessage || 'Payment provider encountered an error. Please try again.';

  if (providerStatus === 422) {
    status = 400;
    code = 'PROVIDER_REJECTED';
    retryable = false;
    userMessage = 'Invalid account number or bank code';
  } else if (isTimeout || providerStatus === 504) {
    status = 504;
    code = 'PROVIDER_TIMEOUT';
    retryable = true;
    userMessage = 'Payment provider request timed out. Please retry shortly.';
  } else if (providerStatus === 503) {
    status = 503;
    code = 'PROVIDER_UNAVAILABLE';
    retryable = true;
    userMessage = 'Payment provider is currently unavailable. Please try again later.';
  }

  return createPayoutErrorResponse({
    status,
    code,
    userMessage,
    category: 'provider',
    retryable,
    correlationId: options.correlationId,
    details: [{ message: userMessage }],
  });
}

export function internalError(options: {
  error?: unknown;
  correlationId?: string;
  message?: string;
}): NextResponse {
  return createPayoutErrorResponse({
    status: 500,
    code: 'INTERNAL_ERROR',
    userMessage:
      options.message || 'An internal error occurred. Please contact support.',
    category: 'internal',
    retryable: true,
    correlationId: options.correlationId,
  });
}
