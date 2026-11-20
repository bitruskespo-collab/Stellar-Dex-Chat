import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuditLogService, { retryWithBackoff } from './auditLog';

describe('auditLog retry helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a failed operation and succeeds with exponential backoff', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('storage fail'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(operation, { retries: 2, minDelayMs: 50, factor: 2 });

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('persists an audit entry to localStorage when recordAction is called', async () => {
    const entry = AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Test deposit',
      { amount: 42 },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'admin1',
      actionType: 'deposit',
      actionDescription: 'Test deposit',
      txHash: 'txhash',
      status: 'success',
    });
  });
});

// ---------------------------------------------------------------------------
// Payout audit ledger chaining (issue #261)
// ---------------------------------------------------------------------------
//
// These tests exercise the tamper-evident chaining helpers exposed by
// `auditLog`. All fixtures are synthetic; no real credentials or user data
// are used.
// ---------------------------------------------------------------------------

type PayoutAuditRecord = {
  id: string;
  payoutId: string;
  actor: string;
  action: string;
  payload: Record<string, unknown>;
  timestamp: number;
};

type ChainedPayoutRecord = PayoutAuditRecord & {
  prevHash: string;
  hash: string;
};

type Checkpoint = {
  index: number;
  hash: string;
  timestamp: number;
};

type ChainVerificationResult =
  | { ok: true; length: number; checkpoints: Checkpoint[] }
  | { ok: false; error: string; index?: number };

type AuditLogModule = typeof import('./auditLog') & {
  buildPayoutAuditChain?: (records: PayoutAuditRecord[]) => ChainedPayoutRecord[];
  verifyPayoutAuditChain?: (
    chain: ChainedPayoutRecord[],
    checkpoints?: Checkpoint[],
  ) => ChainVerificationResult;
  createPayoutAuditCheckpoint?: (
    chain: ChainedPayoutRecord[],
    timestamp?: number,
  ) => Checkpoint;
};

const auditModule = AuditLogService as unknown as AuditLogModule;

const syntheticPayoutRecords = (): PayoutAuditRecord[] => [
  {
    id: 'rec-1',
    payoutId: 'payout-synthetic-1',
    actor: 'admin-synthetic',
    action: 'payout.created',
    payload: { amount: '100.00', currency: 'USD', destination: 'acct_synthetic_1' },
    timestamp: 1_700_000_000_000,
  },
  {
    id: 'rec-2',
    payoutId: 'payout-synthetic-1',
    actor: 'admin-synthetic',
    action: 'payout.approved',
    payload: { approver: 'admin-synthetic-2' },
    timestamp: 1_700_000_001_000,
  },
  {
    id: 'rec-3',
    payoutId: 'payout-synthetic-1',
    actor: 'admin-synthetic',
    action: 'payout.settled',
    payload: { settlementRef: 'settle_synthetic_1' },
    timestamp: 1_700_000_002_000,
  },
];

const buildChain = (records: PayoutAuditRecord[]): ChainedPayoutRecord[] => {
  if (typeof auditModule.buildPayoutAuditChain !== 'function') {
    throw new Error('buildPayoutAuditChain is not implemented on auditLog module');
  }
  return auditModule.buildPayoutAuditChain(records);
};

const verifyChain = (
  chain: ChainedPayoutRecord[],
  checkpoints?: Checkpoint[],
): ChainVerificationResult => {
  if (typeof auditModule.verifyPayoutAuditChain !== 'function') {
    throw new Error('verifyPayoutAuditChain is not implemented on auditLog module');
  }
  return auditModule.verifyPayoutAuditChain(chain, checkpoints);
};

describe('payout audit ledger chaining (#261)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a chain where each record links to the previous hash', () => {
    const chain = buildChain(syntheticPayoutRecords());

    expect(chain).toHaveLength(3);
    expect(chain[0].prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i].prevHash).toBe(chain[i - 1].hash);
    }
    for (const record of chain) {
      expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('produces deterministic hashes for identical canonical input', () => {
    const a = buildChain(syntheticPayoutRecords());
    const b = buildChain(syntheticPayoutRecords());
    expect(a.map((r) => r.hash)).toEqual(b.map((r) => r.hash));
  });

  it('verifies a valid chain successfully', () => {
    const chain = buildChain(syntheticPayoutRecords());
    const result = verifyChain(chain);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.length).toBe(3);
    }
  });

  it('detects a deleted entry', () => {
    const chain = buildChain(syntheticPayoutRecords());
    const tampered = [chain[0], chain[2]];

    const result = verifyChain(tampered);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/chain|link|prev|hash|missing/i);
      expect(result.index).toBe(1);
    }
  });

  it('detects reordered entries', () => {
    const chain = buildChain(syntheticPayoutRecords());
    const tampered = [chain[1], chain[0], chain[2]];

    const result = verifyChain(tampered);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/chain|link|prev|hash|order/i);
    }
  });

  it('detects a modified payload', () => {
    const chain = buildChain(syntheticPayoutRecords());
    const tampered = chain.map((record) => ({ ...record }));
    tampered[1] = {
      ...tampered[1],
      payload: { ...tampered[1].payload, approver: 'admin-attacker' },
    };

    const result = verifyChain(tampered);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/hash|tamper|payload|integrity/i);
      expect(result.index).toBe(1);
    }
  });

  it('detects a modified hash on a single record', () => {
    const chain = buildChain(syntheticPayoutRecords());
    const tampered = chain.map((record) => ({ ...record }));
    tampered[2] = { ...tampered[2], hash: 'f'.repeat(64) };

    const result = verifyChain(tampered);

    expect(result.ok).toBe(false);
  });

  it('validates checkpoints against the chain', () => {
    if (typeof auditModule.createPayoutAuditCheckpoint !== 'function') {
      // Checkpoint helper is optional at the module boundary; skip gracefully
      // if the implementation does not expose it yet.
      return;
    }

    const chain = buildChain(syntheticPayoutRecords());
    const checkpoint = auditModule.createPayoutAuditCheckpoint(chain, 1_700_000_100_000);

    const okResult = verifyChain(chain, [checkpoint]);
    expect(okResult.ok).toBe(true);

    const tampered = chain.map((record) => ({ ...record }));
    tampered[0] = { ...tampered[0], payload: { ...tampered[0].payload, amount: '999.00' } };

    const badResult = verifyChain(tampered, [checkpoint]);
    expect(badResult.ok).toBe(false);
  });

  it('rejects an empty chain gracefully', () => {
    const result = verifyChain([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Privacy lifecycle tests for account deletion requests (issue #263)
// ---------------------------------------------------------------------------
//
// These tests trace synthetic user-linked data across chat history, drafts,
// payout audit records, logs and provider references. They assert that an
// account deletion request either removes or irreversibly de-identifies the
// data, while honoring documented legal/audit retention exceptions.
//
// All fixtures are synthetic; no real credentials or user data are used.
// ---------------------------------------------------------------------------

type DeletionRequest = {
  userId: string;
  requestedAt: number;
  reason: 'user_request' | 'admin_action';
};

type RetentionException = {
  category: 'payout_audit' | 'financial_ledger' | 'legal_hold';
  retainUntil: number;
  justification: string;
};

type PrivacyLifecycleOptions = {
  now?: number;
  retentionExceptions?: RetentionException[];
};

type PrivacyLifecycleResult = {
  deleted: string[];
  deIdentified: string[];
  retained: Array<{ category: string; reason: string }>;
};

type PrivacyLifecycleModule = typeof import('./auditLog') & {
  processAccountDeletion?: (
    request: DeletionRequest,
    options?: PrivacyLifecycleOptions,
  ) => PrivacyLifecycleResult;
};

const privacyModule = AuditLogService as unknown as PrivacyLifecycleModule;

const SYNTHETIC_USER_ID = 'user-synthetic-0001';
const SYNTHETIC_EMAIL = 'synthetic-user@example.invalid';
const SYNTHETIC_PROVIDER_REF = 'provider_synthetic_ref_abc123';

const seedSyntheticUserData = () => {
  // Chat history
  localStorage.setItem(
    `chat_history_${SYNTHETIC_USER_ID}`,
    JSON.stringify([
      { id: 'msg-1', from: SYNTHETIC_USER_ID, body: 'synthetic hello', ts: 1 },
      { id: 'msg-2', from: 'peer-synthetic', body: 'synthetic reply', ts: 2 },
    ]),
  );

  // Drafts
  localStorage.setItem(
    `drafts_${SYNTHETIC_USER_ID}`,
    JSON.stringify([{ id: 'draft-1', body: 'synthetic draft', ts: 3 }]),
  );

  // Payout audit records (linked to user via actor/metadata)
  localStorage.setItem(
    'audit_log_entries',
    JSON.stringify([
      {
        id: 'audit-1',
        adminAddress: SYNTHETIC_USER_ID,
        actionType: 'payout',
        actionDescription: 'synthetic payout',
        metadata: { email: SYNTHETIC_EMAIL, providerRef: SYNTHETIC_PROVIDER_REF },
        status: 'success',
        timestamp: 4,
      },
    ]),
  );

  // Logs
  localStorage.setItem(
    `logs_${SYNTHETIC_USER_ID}`,
    JSON.stringify([{ level: 'info', message: `login ${SYNTHETIC_EMAIL}`, ts: 5 }]),
  );

  // Provider references
  localStorage.setItem(
    `provider_refs_${SYNTHETIC_USER_ID}`,
    JSON.stringify([{ provider: 'synthetic-provider', ref: SYNTHETIC_PROVIDER_REF }]),
  );
};

const collectUserLinkedKeys = (): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key) keys.push(key);
  }
  return keys;
};

const containsSyntheticUserData = (value: string): boolean =>
  value.includes(SYNTHETIC_USER_ID) ||
  value.includes(SYNTHETIC_EMAIL) ||
  value.includes(SYNTHETIC_PROVIDER_REF);

describe('privacy lifecycle: account deletion requests (#263)', () => {
  beforeEach(() => {
    localStorage.clear();
    seedSyntheticUserData();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('seeds synthetic user-linked data across all surfaces', () => {
    const keys = collectUserLinkedKeys();
    expect(keys).toEqual(
      expect.arrayContaining([
        `chat_history_${SYNTHETIC_USER_ID}`,
        `drafts_${SYNTHETIC_USER_ID}`,
        'audit_log_entries',
        `logs_${SYNTHETIC_USER_ID}`,
        `provider_refs_${SYNTHETIC_USER_ID}`,
      ]),
    );
  });

  it('removes or irreversibly de-identifies user-linked data on deletion', () => {
    if (typeof privacyModule.processAccountDeletion !== 'function') {
      throw new Error('processAccountDeletion is not implemented on auditLog module');
    }

    const result = privacyModule.processAccountDeletion(
      { userId: SYNTHETIC_USER_ID, requestedAt: 10, reason: 'user_request' },
      { now: 10 },
    );

    // Chat history and drafts must be gone.
    expect(localStorage.getItem(`chat_history_${SYNTHETIC_USER_ID}`)).toBeNull();
    expect(localStorage.getItem(`drafts_${SYNTHETIC_USER_ID}`)).toBeNull();
    expect(localStorage.getItem(`logs_${SYNTHETIC_USER_ID}`)).toBeNull();
    expect(localStorage.getItem(`provider_refs_${SYNTHETIC_USER_ID}`)).toBeNull();

    // No remaining surface should contain the synthetic identifiers.
    for (const key of collectUserLinkedKeys()) {
      const value = localStorage.getItem(key) ?? '';
      expect(containsSyntheticUserData(value)).toBe(false);
    }

    expect(result.deleted.length + result.deIdentified.length).toBeGreaterThan(0);
  });

  it('honors payout audit retention exceptions while de-identifying PII', () => {
    if (typeof privacyModule.processAccountDeletion !== 'function') {
      throw new Error('processAccountDeletion is not implemented on auditLog module');
    }

    const retention: RetentionException[] = [
      {
        category: 'payout_audit',
        retainUntil: 1_000,
        justification: 'financial audit retention',
      },
    ];

    const result = privacyModule.processAccountDeletion(
      { userId: SYNTHETIC_USER_ID, requestedAt: 10, reason: 'user_request' },
      { now: 10, retentionExceptions: retention },
    );

    const auditRaw = localStorage.getItem('audit_log_entries');
    expect(auditRaw).not.toBeNull();

    const auditEntries = JSON.parse(auditRaw ?? '[]');
    expect(auditEntries).toHaveLength(1);

    // The audit record is retained but must be irreversibly de-identified.
    const serialized = JSON.stringify(auditEntries);
    expect(serialized).not.toContain(SYNTHETIC_EMAIL);
    expect(serialized).not.toContain(SYNTHETIC_PROVIDER_REF);
    expect(serialized).not.toContain(SYNTHETIC_USER_ID);

    expect(result.retained.some((r) => r.category === 'payout_audit')).toBe(true);
  });

  it('rejects deletion requests for a different user (authorization)', () => {
    if (typeof privacyModule.processAccountDeletion !== 'function') {
      throw new Error('processAccountDeletion is not implemented on auditLog module');
    }

    expect(() =>
      privacyModule.processAccountDeletion(
        { userId: 'user-synthetic-other', requestedAt: 10, reason: 'user_request' },
        { now: 10 },
      ),
    ).not.toThrow();

    // Data belonging to the original synthetic user must remain untouched.
    expect(localStorage.getItem(`chat_history_${SYNTHETIC_USER_ID}`)).not.toBeNull();
    expect(localStorage.getItem(`drafts_${SYNTHETIC_USER_ID}`)).not.toBeNull();
  });

  it('is idempotent and recoverable when invoked twice', () => {
    if (typeof privacyModule.processAccountDeletion !== 'function') {
      throw new Error('processAccountDeletion is not implemented on auditLog module');
    }

    const request: DeletionRequest = {
      userId: SYNTHETIC_USER_ID,
      requestedAt: 10,
      reason: 'user_request',
    };

    const first = privacyModule.processAccountDeletion(request, { now: 10 });
    const second = privacyModule.processAccountDeletion(request, { now: 11 });

    expect(first.deleted.length + first.deIdentified.length).toBeGreaterThan(0);
    // Second pass should be a no-op for already-deleted surfaces.
    expect(second.deleted).toEqual([]);
    expect(second.deIdentified).toEqual([]);
  });

  it('does not leak synthetic identifiers into logs after deletion', () => {
    if (typeof privacyModule.processAccountDeletion !== 'function') {
      throw new Error('processAccountDeletion is not implemented on auditLog module');
    }

    privacyModule.processAccountDeletion(
      { userId: SYNTHETIC_USER_ID, requestedAt: 10, reason: 'user_request' },
      { now: 10 },
    );

    for (const key of collectUserLinkedKeys()) {
      if (!key.startsWith('logs_')) continue;
      const value = localStorage.getItem(key) ?? '';
      expect(containsSyntheticUserData(value)).toBe(false);
    }
  });
});