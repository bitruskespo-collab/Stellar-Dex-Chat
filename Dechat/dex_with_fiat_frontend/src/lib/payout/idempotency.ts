import crypto from 'crypto';

export interface IdempotencyEntry {
  scopedKey: string;
  userId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: 'in_progress' | 'completed' | 'failed';
  result?: unknown;
  error?: { message: string; status: number };
  createdAt: number;
  updatedAt: number;
  inFlightPromise?: Promise<unknown>;
}

export class IdempotencyPayloadMismatchError extends Error {
  constructor(message = 'Idempotency key reuse with different payload') {
    super(message);
    this.name = 'IdempotencyPayloadMismatchError';
  }
}

export class ConcurrentRequestInProgressError extends Error {
  constructor(
    message = 'A request with this idempotency key is currently in progress',
  ) {
    super(message);
    this.name = 'ConcurrentRequestInProgressError';
  }
}

export const idempotencyStore = new Map<string, IdempotencyEntry>();

export function computePayloadHash(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return crypto.createHash('sha256').update(String(payload)).digest('hex');
  }
  const record = payload as Record<string, unknown>;
  const intent: Record<string, unknown> = {
    amount: record.amount,
    recipient: record.recipient,
    source: record.source,
    reason: record.reason,
  };
  const sortedKeys = Object.keys(intent).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    if (intent[k] !== undefined) {
      canonical[k] = intent[k];
    }
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

export function getScopedIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): string {
  return `${userId}:${idempotencyKey}`;
}

export async function executeIdempotentPayout<T>({
  idempotencyKey,
  userId,
  payload,
  execute,
}: {
  idempotencyKey: string;
  userId: string;
  payload: unknown;
  execute: () => Promise<T>;
}): Promise<{ isRetry: boolean; data: T }> {
  const scopedKey = getScopedIdempotencyKey(userId, idempotencyKey);
  const payloadHash = computePayloadHash(payload);
  const now = Date.now();

  const existing = idempotencyStore.get(scopedKey);

  if (existing) {
    // Reject key reuse with a different payload
    if (existing.payloadHash !== payloadHash) {
      throw new IdempotencyPayloadMismatchError();
    }

    // Return original result for identical retry
    if (existing.status === 'completed') {
      return { isRetry: true, data: existing.result as T };
    }

    // Concurrent duplicate request in progress: wait for the in-flight operation
    if (existing.status === 'in_progress') {
      if (existing.inFlightPromise) {
        const result = (await existing.inFlightPromise) as T;
        return { isRetry: true, data: result };
      }
      throw new ConcurrentRequestInProgressError();
    }

    if (existing.status === 'failed' && existing.error) {
      const err = new Error(existing.error.message);
      (err as { status?: number }).status = existing.error.status;
      throw err;
    }
  }

  // Create new in-progress entry with promise for concurrency handling
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const inFlightPromise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const entry: IdempotencyEntry = {
    scopedKey,
    userId,
    idempotencyKey,
    payloadHash,
    status: 'in_progress',
    createdAt: now,
    updatedAt: now,
    inFlightPromise,
  };
  idempotencyStore.set(scopedKey, entry);

  try {
    const data = await execute();
    entry.status = 'completed';
    entry.result = data;
    entry.updatedAt = Date.now();
    entry.inFlightPromise = undefined;
    idempotencyStore.set(scopedKey, entry);
    resolvePromise(data);
    return { isRetry: false, data };
  } catch (error: unknown) {
    entry.status = 'failed';
    entry.error = {
      message: error instanceof Error ? error.message : 'Unknown error',
      status: (error as { status?: number })?.status ?? 500,
    };
    entry.updatedAt = Date.now();
    entry.inFlightPromise = undefined;
    idempotencyStore.set(scopedKey, entry);
    rejectPromise(error);
    throw error;
  }
}

export function clearIdempotencyStore(): void {
  idempotencyStore.clear();
}
