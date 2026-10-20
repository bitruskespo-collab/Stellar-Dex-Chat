/**
 * Stable Correlation ID Management
 * Addresses Issue #71: Make it possible to trace a user-visible operation
 * across browser telemetry, API routes, provider callbacks, and contract events.
 */

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Generate a non-sensitive, unique operation correlation ID.
 * Format: op_<timestamp_base36>_<random_hex>
 */
export function generateCorrelationId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `op_${timestamp}_${randomPart}`;
}

/**
 * Attaches the correlation ID to Fetch RequestInit headers.
 */
export function withCorrelationId(
  init: RequestInit = {},
  existingCorrelationId?: string
): { init: RequestInit; correlationId: string } {
  const correlationId = existingCorrelationId || generateCorrelationId();
  const headers = new Headers(init.headers || {});
  
  if (!headers.has(CORRELATION_HEADER)) {
    headers.set(CORRELATION_HEADER, correlationId);
  }

  return {
    init: {
      ...init,
      headers,
    },
    correlationId: headers.get(CORRELATION_HEADER) || correlationId,
  };
}

/**
 * Structured logger entry with correlation context.
 */
export function logWithCorrelation(
  correlationId: string,
  event: string,
  data?: Record<string, unknown>
): void {
  // Redact any potential PII or keys before logging
  const safeData = data ? JSON.parse(JSON.stringify(data)) : {};
  if (safeData.privateKey) delete safeData.privateKey;
  if (safeData.secret) delete safeData.secret;

  console.info(JSON.stringify({
    correlationId,
    event,
    timestamp: new Date().toISOString(),
    ...safeData,
  }));
}
