import { z } from 'zod';
import {
  countrySchema,
  bankCodeSchema,
  paystackBankCodeSchema,
  accountNumberSchema,
  nubanAccountNumberSchema,
  beneficiaryNameSchema,
  beneficiaryTypeSchema,
  beneficiaryCurrencySchema,
  strictCreateRecipientSchema,
  strictVerifyAccountSchema,
} from './bankAccountSchemas';

export {
  countrySchema,
  bankCodeSchema,
  paystackBankCodeSchema,
  accountNumberSchema,
  nubanAccountNumberSchema,
  beneficiaryNameSchema,
  beneficiaryTypeSchema,
  beneficiaryCurrencySchema,
  strictCreateRecipientSchema,
  strictVerifyAccountSchema,
};

// Nigerian NUBAN account numbers are always exactly 10 digits; Paystack bank
// codes are 3-6 digits. Anchoring both to a strict digit pattern (rather than
// just `min(1)`) also rules out injecting extra query parameters through
// these fields into the Paystack request URL.
const nubanAccountNumber = nubanAccountNumberSchema;
const paystackBankCode = paystackBankCodeSchema;

// Schema for create-recipient endpoint (strict validation, unknown keys rejected)
export const createRecipientSchema = strictCreateRecipientSchema;

export type CreateRecipientInput = z.infer<typeof createRecipientSchema>;

// Schema for initiate-transfer endpoint
export const MAX_TRANSFER_AMOUNT_NGN = 10_000_000;

export const initiateTransferSchema = z
  .object({
    source: z.string().min(1, 'Source is required'),
    reason: z.string().optional(),
    amount: z
      .number()
      .positive('Amount must be positive')
      .max(MAX_TRANSFER_AMOUNT_NGN, 'Amount exceeds the transfer limit')
      .refine(
        (amount) =>
          Math.abs(amount * 100 - Math.round(amount * 100)) <=
          Number.EPSILON * Math.max(1, Math.abs(amount * 100)) * 4,
        'Amount must have at most 2 decimal places',
      ),
    recipient: z.string().min(1, 'Recipient is required'),
    reference: z.string().optional(),
    clientSessionId: z.string().max(200).optional(),
  })
  .strict();

export type InitiateTransferInput = z.infer<typeof initiateTransferSchema>;

// Schema for verify-account endpoint (strict validation, unknown keys rejected)
export const verifyAccountSchema = strictVerifyAccountSchema;

export type VerifyAccountInput = z.infer<typeof verifyAccountSchema>;

// Schema for the banks endpoint query string. The endpoint currently serves
// Nigerian NUBAN banks only, so rejecting unsupported query parameters keeps
// the public contract explicit rather than silently ignoring user input.
export const banksQuerySchema = z
  .object({
    country: z.literal('nigeria').default('nigeria'),
  })
  .strict();

export type BanksQuery = z.infer<typeof banksQuerySchema>;

// Schema for transfer-status endpoint
export const transferStatusSchema = z.object({
  reference: z.string().min(1, 'Reference is required'),
});

export type TransferStatusInput = z.infer<typeof transferStatusSchema>;

// Schema for the payment-status/stream endpoint query string. The stream is
// keyed by the client session id minted in `clientSession.ts` (a UUID), so a
// non-empty, bounded string is all that is required — rejecting a missing or
// oversized value keeps the SSE endpoint from opening a subscription for
// garbage input.
export const paymentStatusStreamQuerySchema = z.object({
  sessionId: z
    .string()
    .min(1, 'sessionId is required')
    .max(200, 'sessionId is too long'),
});

export type PaymentStatusStreamQuery = z.infer<
  typeof paymentStatusStreamQuerySchema
>;

// Schema for the events endpoint query string
export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type EventsQuery = z.infer<typeof eventsQuerySchema>;

/**
 * Read-model freshness metadata attached to indexed results.
 *
 * Indexed projections can lag the source ledger, so every response that
 * exposes indexed state must also carry the cursor / update time it was
 * derived from. Consumers use this to avoid presenting a stale projection as
 * confirmed settlement state.
 */
export const freshnessSchema = z
  .object({
    /** Source ledger cursor the projection was built from, if known. */
    sourceLedgerCursor: z.number().int().nonnegative().nullable(),
    /** ISO-8601 timestamp of when the projection was indexed. */
    indexedAt: z.string().datetime().nullable(),
    /** ISO-8601 timestamp of the last database update for the projection. */
    dbUpdatedAt: z.string().datetime().nullable(),
    /** True when the projection is known to lag the source ledger. */
    isStale: z.boolean(),
    /** Age (in ms) beyond which the projection is considered stale. */
    stalenessThresholdMs: z.number().int().nonnegative(),
  })
  .strict();

export type FreshnessMetadata = z.infer<typeof freshnessSchema>;

export interface BuildFreshnessMetadataInput {
  /** Cursor of the source ledger the projection was built from. */
  cursor: number | null | undefined;
  /** Latest cursor observed on the source ledger, if known. */
  latestLedger?: number | null;
  /** ISO-8601 timestamp of the last database update, if known. */
  dbUpdatedAt?: string | null;
  /** Current time in epoch milliseconds (defaults to `Date.now()`). */
  now?: number;
  /** Age (in ms) beyond which the projection is considered stale. */
  thresholdMs?: number;
}

export const DEFAULT_STALENESS_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Build freshness metadata for an indexed result.
 *
 * A projection is stale when either:
 * - its cursor lags the latest known ledger cursor, or
 * - its last database update is older than `thresholdMs`.
 *
 * A missing cursor is treated as stale: without a cursor we cannot prove the
 * projection is current, so it must not be presented as confirmed state.
 */
export function buildFreshnessMetadata({
  cursor,
  latestLedger,
  dbUpdatedAt,
  now = Date.now(),
  thresholdMs = DEFAULT_STALENESS_THRESHOLD_MS,
}: BuildFreshnessMetadataInput): FreshnessMetadata {
  const sourceLedgerCursor =
    typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null;

  const cursorLags =
    sourceLedgerCursor === null ||
    (typeof latestLedger === 'number' &&
      Number.isFinite(latestLedger) &&
      sourceLedgerCursor < latestLedger);

  let dbTooOld = false;
  if (dbUpdatedAt) {
    const updatedAtMs = Date.parse(dbUpdatedAt);
    if (Number.isNaN(updatedAtMs)) {
      dbTooOld = true;
    } else {
      dbTooOld = now - updatedAtMs > thresholdMs;
    }
  }

  return {
    sourceLedgerCursor,
    indexedAt: new Date(now).toISOString(),
    dbUpdatedAt: dbUpdatedAt ?? null,
    isStale: cursorLags || dbTooOld,
    stalenessThresholdMs: thresholdMs,
  };
}

/**
 * Data lineage for FX and settlement calculations (issue #252).
 *
 * Persisted alongside every displayed and paid amount so an auditor can
 * recompute it: which calculation version produced it, which inputs were
 * consumed, which currency metadata version was used, and how rounding was
 * applied.
 */
export const calculationLineageSchema = z
  .object({
    /** Version identifier of the calculation implementation. */
    calculationVersion: z.string().min(1, 'calculationVersion is required'),
    /** Identifiers of the inputs consumed by the calculation. */
    inputSourceIds: z.array(z.string().min(1)).min(1),
    /** Version identifier of the currency metadata used. */
    currencyMetadataVersion: z.string().min(1, 'currencyMetadataVersion is required'),
    /** Rounding mode applied to the result (e.g. 'half-up', 'half-even'). */
    roundingMode: z.string().min(1, 'roundingMode is required'),
    /** Signed difference introduced by rounding, in the result's minor unit. */
    roundingDelta: z.number(),
  })
  .strict();

export type CalculationLineage = z.infer<typeof calculationLineageSchema>;

/**
 * Error thrown by {@link fetchWithRetry} when the server answers with a
 * non-OK status.
 *
 * Carries the status and the original `Response` as typed fields so
 * {@link withRetry} can decide whether the status is retryable without
 * casting. Previously these were stapled onto a plain `Error` through `any`,
 * which left the status invisible to the retry check.
 */
export class HttpResponseError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** The original response, for callers that need headers or a body. */
  readonly response: Response;

  constructor(response: Response) {
    super(`HTTP ${response.status}: ${response.statusText}`);
    this.name = 'HttpResponseError';
    this.status = response.status;
    this.response = response;
  }
}

/**
 * Retry configuration for API requests with exponential backoff
 */
export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
  retryableErrors?: (error: unknown) => boolean;
}

interface HttpError extends Error {
  status?: number;
  response?: Response;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  retryableErrors: (error: unknown) => {
    if (error instanceof TypeError) {
      // Network errors (e.g., "Failed to fetch")
      return true;
    }
    if (error instanceof DOMException && error.name === 'NetworkError') {
      return true;
    }
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('failed to fetch') ||
        message.includes('network') ||
        message.includes('load failed') ||
        message.includes('timeout')
      );
    }
    return false;
  },
};

/**
 * Calculate delay with exponential backoff and jitter
 * @param attempt - Current attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(
  attempt: number,
  config: Required<RetryConfig>,
): number {
  // Exponential backoff: initialDelay * (multiplier ^ attempt)
  const exponentialDelay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);

  // Add jitter (±25%) to avoid thundering herd
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);

  // Cap at max delay
  return Math.min(config.maxDelayMs, exponentialDelay + jitter);
}

/**
 * Sleep for a specified duration
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic and exponential backoff
 * @param fn - Async function to execute
 * @param config - Retry configuration
 * @returns Result of the function
 * @throws Last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const mergedConfig: Required<RetryConfig> = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
    retryableStatusCodes:
      config.retryableStatusCodes ?? DEFAULT_RETRY_CONFIG.retryableStatusCodes,
    retryableErrors:
      config.retryableErrors ?? DEFAULT_RETRY_CONFIG.retryableErrors,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= mergedConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // An aborted request must never be retried, whatever the caller's
      // `retryableErrors` says — the caller asked us to stop.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }

      // Check if error is retryable
      const isRetryableError = mergedConfig.retryableErrors(error);
      const isRetryableStatus =
        error instanceof Response
          ? mergedConfig.retryableStatusCodes.includes(error.status)
          : error instanceof Error &&
            mergedConfig.retryableStatusCodes.includes(
              (error as HttpError).status ?? 0,
            );

      if (!isRetryableError && !isRetryableStatus) {
        throw error; // Non-retryable error, throw immediately
      }

      // Don't wait after the last attempt
      if (attempt < mergedConfig.maxRetries) {
        const delay = calculateBackoffDelay(attempt, mergedConfig);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Execute a fetch request with retry logic and exponential backoff
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param config - Retry configuration
 * @returns Fetch response
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  config: RetryConfig = {},
): Promise<Response> {
  return withRetry(async () => {
    const response = await fetch(url, options);

    if (!response.ok) {
      // Throw error to trigger retry for non-OK responses
      const error: HttpError = Object.assign(
        new Error(`HTTP ${response.status}: ${response.statusText}`),
        { status: response.status, response },
      );
      throw error;
    }

    return response;
  }, config);
}
