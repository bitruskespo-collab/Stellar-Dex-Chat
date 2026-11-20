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

describe('auditLog redaction boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const readStoredEntries = (): any[] =>
    JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');

  it('redacts sensitive fields in nested objects while preserving audit metadata', async () => {
    const entry = AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Test deposit',
      {
        amount: 42,
        bank: {
          accountNumber: '0000000000',
          routingNumber: '000000000',
          iban: 'DE00000000000000000000',
        },
        nested: {
          deeper: {
            password: 'fixture-password',
            walletToken: 'fixture-wallet-token',
          },
        },
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const stored = readStoredEntries();
    expect(stored).toHaveLength(1);
    const persisted = stored[0];

    // Audit metadata is preserved.
    expect(persisted).toMatchObject({
      id: entry.id,
      adminAddress: 'admin1',
      actionType: 'deposit',
      actionDescription: 'Test deposit',
      txHash: 'txhash',
      status: 'success',
    });
    expect(persisted.timestamp).toBeDefined();

    // Sensitive values are redacted at every nesting level.
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('0000000000');
    expect(serialized).not.toContain('000000000');
    expect(serialized).not.toContain('DE00000000000000000000');
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('fixture-wallet-token');

    // Non-sensitive values remain intact.
    expect(persisted.details?.amount ?? persisted.metadata?.amount).toBe(42);
  });

  it('redacts mixed-case sensitive keys', async () => {
    AuditLogService.recordAction(
      'admin1',
      'withdrawal',
      'Mixed case keys',
      {
        Password: 'fixture-password',
        API_KEY: 'fixture-api-key',
        SessionToken: 'fixture-session-token',
        BankAccountNumber: '0000000000',
        amount: 7,
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const serialized = JSON.stringify(readStoredEntries());
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('fixture-api-key');
    expect(serialized).not.toContain('fixture-session-token');
    expect(serialized).not.toContain('0000000000');
    expect(serialized).toContain('7');
  });

  it('redacts encoded sensitive values (base64 and URL-encoded)', async () => {
    const base64Secret = btoa('fixture-password');
    const urlEncodedSecret = encodeURIComponent('fixture-wallet-token');

    AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Encoded values',
      {
        encodedPassword: base64Secret,
        encodedToken: urlEncodedSecret,
        amount: 11,
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const serialized = JSON.stringify(readStoredEntries());
    expect(serialized).not.toContain(base64Secret);
    expect(serialized).not.toContain(urlEncodedSecret);
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('fixture-wallet-token');
    expect(serialized).toContain('11');
  });

  it('redacts provider payloads and prompt content', async () => {
    AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Provider payload',
      {
        providerPayload: { raw: 'fixture-provider-raw-payload' },
        prompt: 'fixture-prompt-content',
        amount: 3,
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const serialized = JSON.stringify(readStoredEntries());
    expect(serialized).not.toContain('fixture-provider-raw-payload');
    expect(serialized).not.toContain('fixture-prompt-content');
    expect(serialized).toContain('3');
  });
});