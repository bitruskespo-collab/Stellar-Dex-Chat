import { describe, expect, it } from 'vitest';
import {
  actionForDiagnosticCode,
  classifyLocalizedError,
  detectTransactionErrorCode,
  localizeDiagnostics,
  messageForDiagnosticCode,
} from './localizedErrors';
import { classifyTransactionError } from './transactionErrorRecovery';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';

const SYNTHETIC_SECRET = `S${'A'.repeat(55)}`;

describe('detectTransactionErrorCode', () => {
  it('prefers explicit machine codes over translated or incidental text', () => {
    expect(detectTransactionErrorCode(new Error('Soroban: Error(401)'))).toBe(
      'CONTRACT_401',
    );
    expect(
      detectTransactionErrorCode(new Error('HTTP failure'), {
        httpStatus: 429,
      }),
    ).toBe('HTTP_429');
    expect(
      detectTransactionErrorCode(new Error('USER_DECLINED by signer')),
    ).toBe('USER_DECLINED');
  });

  it('does not derive a code from a sanitized secret or unrelated text', () => {
    expect(
      detectTransactionErrorCode(
        new Error(`Transaction error key=${SYNTHETIC_SECRET} abort`),
      ),
    ).toBe('UNKNOWN');
  });

  it('treats HTTP statuses in text as HTTP, never as Soroban codes', () => {
    expect(
      detectTransactionErrorCode(new Error('HTTP 504 gateway timeout')),
    ).toBe('HTTP_504');
    expect(
      detectTransactionErrorCode(new Error('status: 401 from payout API')),
    ).toBe('HTTP_401');
  });

  it('ignores incidental digit runs such as amounts and ledgers', () => {
    expect(
      detectTransactionErrorCode(new Error('amount 301 stroops at ledger 1201')),
    ).toBe('UNKNOWN');
    expect(
      detectTransactionErrorCode({ code: 402, message: 'wallet debit' }),
    ).toBe('CONTRACT_402');
    expect(
      detectTransactionErrorCode(new Error('Simulation failed [ExceedsLimit #302]')),
    ).toBe('CONTRACT_302');
  });
});

describe('classifyLocalizedError', () => {
  it('localizes a contract failure while preserving its machine code and safety metadata', () => {
    const result = classifyLocalizedError(new Error('Soroban: Error(401)'), {
      locale: 'fr',
      fieldId: 'sfm-amount',
      safeValues: { amount: '50' },
    });

    expect(result.code).toBe('CONTRACT_401');
    expect(result.category).toBe('contract');
    expect(result.isRetryable).toBe(false);
    expect(result.message).toBe(fr.errors['401']);
    expect(result.action).toBe(fr.transaction.errors.actions.fund_wallet);
    expect(result.fieldId).toBe('sfm-amount');
    expect(result.safeValues).toEqual({ amount: '50' });
  });

  it('localizes authorization failures without changing retryability', () => {
    const result = classifyLocalizedError(
      new Error('USER_DECLINED by signer'),
      {
        locale: 'es',
      },
    );

    expect(result.code).toBe('USER_DECLINED');
    expect(result.category).toBe('wallet');
    expect(result.isRetryable).toBe(true);
    expect(result.message).toBe(es.transaction.errors.wallet.user_declined);
    expect(result.action).toBe(es.transaction.errors.actions.retry);
  });

  it('localizes HTTP rate limiting from the status code', () => {
    const result = classifyLocalizedError(new Error('anything'), {
      httpStatus: 429,
      locale: 'fr',
    });

    expect(result.code).toBe('HTTP_429');
    expect(result.category).toBe('rate_limit');
    expect(result.isRetryable).toBe(true);
    expect(result.message).toBe(fr.transaction.errors.api.rate_limited);
    expect(result.action).toBe(fr.transaction.errors.actions.retry_later);
  });

  it('never leaks raw diagnostics for an unknown failure', () => {
    const result = classifyLocalizedError(
      new Error(`Transaction error key=${SYNTHETIC_SECRET} abort`),
      { locale: 'ar' },
    );

    expect(result.code).toBe('UNKNOWN');
    expect(result.category).toBe('unknown');
    expect(result.message).toBe(ar.transaction.errors.unknown.message);
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_SECRET);
  });

  it('keeps machine codes identical across locales', () => {
    const codes = (['en', 'fr', 'es', 'ar'] as const).map(
      (locale) =>
        classifyLocalizedError(new Error('code 301'), { locale }).code,
    );
    expect(codes).toEqual([
      'CONTRACT_301',
      'CONTRACT_301',
      'CONTRACT_301',
      'CONTRACT_301',
    ]);
    expect(
      classifyLocalizedError(new Error('code 301'), { locale: 'fr' }).message,
    ).toBe(fr.errors['301']);
  });

  it('uses the localized generic message for codes without a translation', () => {
    const result = classifyLocalizedError(new Error('Error(9999)'), {
      locale: 'en',
    });
    expect(result.code).toBe('CONTRACT_9999');
    expect(result.message).toBe(en.transaction.errors.unknown.message);
    expect(result.action).toBe(en.transaction.errors.actions.contact_support);
    // Unlisted and unknown failures must not be retried blindly.
    expect(result.isRetryable).toBe(false);
    expect(classifyLocalizedError(new Error('mystery')).isRetryable).toBe(false);
  });

  it('derives safety metadata from the code, not from raw wording', () => {
    const translated = classifyLocalizedError(new Error('code 301'), {
      locale: 'ar',
    });
    const verbose = classifyLocalizedError(
      new Error('code 301 timeout network unauthorized'),
      { locale: 'ar' },
    );
    expect(verbose.code).toBe('CONTRACT_301');
    expect(verbose.category).toBe(translated.category);
    expect(verbose.isRetryable).toBe(translated.isRetryable);
    expect(verbose.message).toBe(ar.errors['301']);
  });

  it('uses the localized conflict message for HTTP 409', () => {
    const result = classifyLocalizedError(new Error('conflict'), {
      httpStatus: 409,
      locale: 'fr',
    });
    expect(result.code).toBe('HTTP_409');
    expect(result.message).toBe(fr.transaction.errors.api.conflict);
    expect(result.isRetryable).toBe(true);
  });
});

describe('localizeDiagnostics', () => {
  it('localizes recovery text without changing the code or correlation metadata', () => {
    const diagnostics = classifyTransactionError(
      new Error('Error(1001)'),
      'corr-123',
    );

    const localized = localizeDiagnostics(diagnostics, 'fr');

    expect(localized.errorCode).toBe('1001');
    expect(localized.correlationId).toBe('corr-123');
    expect(localized.category).toBe(diagnostics.category);
    expect(localized.isRetryable).toBe(diagnostics.isRetryable);
    expect(localized.timestamp).toBe(diagnostics.timestamp);
    expect(localized.rawDetailsSanitized).toBe(diagnostics.rawDetailsSanitized);
    expect(localized.safeMessage).toBe(
      fr.transaction.errors.recovery['1001'].message,
    );
    expect(localized.actionGuidance).toBe(
      fr.transaction.errors.actions.fund_wallet,
    );
  });

  it('keeps legacy 1001 distinct from the current on-chain 1001 code', () => {
    expect(messageForDiagnosticCode('1001', 'en')).toBe(
      en.transaction.errors.recovery['1001'].message,
    );
    expect(messageForDiagnosticCode('CONTRACT_1001', 'en')).toBe(
      en.errors['1001'],
    );
  });

  it('uses a localized generic for unknown diagnostic codes', () => {
    expect(messageForDiagnosticCode('UNKNOWN_ERROR', 'ar')).toBe(
      ar.transaction.errors.recovery.UNKNOWN_ERROR.message,
    );
    expect(actionForDiagnosticCode('UNKNOWN_ERROR', 'ar')).toBe(
      ar.transaction.errors.actions.contact_support_with_correlation,
    );
  });
});
