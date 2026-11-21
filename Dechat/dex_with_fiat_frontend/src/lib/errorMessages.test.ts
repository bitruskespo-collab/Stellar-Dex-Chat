/**
 * Tests for errorMessages — Issue #294
 * Covers: typed contract/wallet codes, HTTP status codes, keyword fallbacks,
 * field-id association, safe-value preservation, and secret redaction.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyError,
  fieldAriaDescribedBy,
  buildErrorSummary,
  type AccessibleError,
} from './errorMessages';

// ---------------------------------------------------------------------------
// classifyError — contract error codes
// ---------------------------------------------------------------------------

describe('classifyError — contract error codes', () => {
  it('maps Error(401) to insufficient-balance entry', () => {
    const result = classifyError(new Error('Soroban: Error(401) on-chain'));
    expect(result.category).toBe('contract');
    expect(result.message).toMatch(/insufficient balance/i);
    expect(result.isRetryable).toBe(false);
  });

  it('maps "code 301" to amount-must-be-positive entry', () => {
    const result = classifyError(new Error('Contract rejected: code 301'));
    expect(result.category).toBe('validation');
    expect(result.message).toMatch(/greater than zero/i);
  });

  it('maps bare code 201 to auth entry', () => {
    const result = classifyError(new Error('Failure 201 unauthorized'));
    expect(result.category).toBe('auth');
    expect(result.isRetryable).toBe(false);
  });

  it('maps contract code 902 (nonce replay) correctly', () => {
    const result = classifyError(new Error('Error(902) nonce already used'));
    expect(result.message).toMatch(/nonce.*already been used/i);
    expect(result.isRetryable).toBe(false);
  });

  it('maps retryable contract code 306 correctly', () => {
    const result = classifyError(new Error('Error(306)'));
    expect(result.isRetryable).toBe(true);
    expect(result.action).toMatch(/cooldown/i);
  });
});

// ---------------------------------------------------------------------------
// classifyError — HTTP status codes
// ---------------------------------------------------------------------------

describe('classifyError — HTTP status codes', () => {
  it('maps 401 to auth category', () => {
    const result = classifyError(new Error('Unauthorized'), { httpStatus: 401 });
    expect(result.category).toBe('auth');
    expect(result.isRetryable).toBe(false);
  });

  it('maps 429 to rate_limit category and marks retryable', () => {
    const result = classifyError(new Error('Too many requests'), { httpStatus: 429 });
    expect(result.category).toBe('rate_limit');
    expect(result.isRetryable).toBe(true);
  });

  it('maps 500 to unknown category and marks retryable', () => {
    const result = classifyError(new Error('Internal server error'), { httpStatus: 500 });
    expect(result.category).toBe('unknown');
    expect(result.isRetryable).toBe(true);
  });

  it('maps 503 to network category', () => {
    const result = classifyError(new Error('Service unavailable'), { httpStatus: 503 });
    expect(result.category).toBe('network');
  });

  it('maps 422 to validation and not retryable', () => {
    const result = classifyError(new Error('Unprocessable'), { httpStatus: 422 });
    expect(result.category).toBe('validation');
    expect(result.isRetryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyError — wallet string codes
// ---------------------------------------------------------------------------

describe('classifyError — wallet string codes', () => {
  it('maps USER_DECLINED string to wallet category', () => {
    const result = classifyError(new Error('USER_DECLINED by signer'));
    expect(result.category).toBe('wallet');
    expect(result.isRetryable).toBe(true);
    expect(result.message).toMatch(/declined/i);
  });

  it('maps user rejected (lowercase) to wallet category', () => {
    const result = classifyError(new Error('user rejected the transaction'));
    expect(result.category).toBe('wallet');
  });

  it('maps NETWORK_TIMEOUT to network category', () => {
    const result = classifyError(new Error('NETWORK_TIMEOUT reached'));
    expect(result.category).toBe('network');
    expect(result.isRetryable).toBe(true);
  });

  it('maps WALLET_CONTEXT_CHANGED to wallet category', () => {
    const result = classifyError(new Error('WALLET_CONTEXT_CHANGED during signing'));
    expect(result.category).toBe('wallet');
    expect(result.isRetryable).toBe(true);
  });

  it('maps SESSION_EXPIRED to auth category', () => {
    const result = classifyError(new Error('SESSION_EXPIRED'));
    expect(result.category).toBe('auth');
    expect(result.isRetryable).toBe(false);
  });

  it('maps disconnected message to wallet category', () => {
    const result = classifyError(new Error('Wallet is not connected'));
    expect(result.category).toBe('wallet');
    expect(result.isRetryable).toBe(false);
  });

  it('maps timed out message to network category', () => {
    const result = classifyError(new Error('Request timed out after 30s'));
    expect(result.category).toBe('network');
    expect(result.isRetryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyError — field association and safe-value preservation
// ---------------------------------------------------------------------------

describe('classifyError — field association', () => {
  it('passes fieldId through to the result', () => {
    const result = classifyError(new Error('code 301'), { fieldId: 'sfm-amount' });
    expect(result.fieldId).toBe('sfm-amount');
  });

  it('passes safeValues through unchanged', () => {
    const result = classifyError(new Error('code 301'), {
      safeValues: { amount: '50', note: 'test note' },
    });
    expect(result.safeValues).toEqual({ amount: '50', note: 'test note' });
  });

  it('safeValues are absent when not provided', () => {
    const result = classifyError(new Error('code 301'));
    expect(result.safeValues).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// classifyError — secret redaction in fallback path
// ---------------------------------------------------------------------------

describe('classifyError — secret redaction in fallback', () => {
  it('does not surface a Stellar secret key in the displayed message', () => {
    // Build a 56-char Stellar secret key (S + 55 uppercase base32 chars).
    const secretKey = 'S' + 'C'.repeat(55);
    const result = classifyError(new Error(`Transaction error key=${secretKey} abort`));
    // sanitizeDiagnostics rewrites the string → sanitized !== raw →
    // the fallback emits the generic message rather than the tainted one.
    expect(result.message).not.toContain(secretKey);
    expect(result.message).toMatch(/unexpected error/i);
  });

  it('does not surface a bearer token in the message', () => {
    // "rejected" in the message triggers USER_DECLINED classification —
    // the token never reaches the user-visible message regardless.
    const result = classifyError(new Error('Bearer abc123token was rejected'));
    expect(result.message).not.toContain('abc123token');
    // Classified as USER_DECLINED via the "rejected" keyword.
    expect(result.category).toBe('wallet');
  });
});

// ---------------------------------------------------------------------------
// classifyError — unknown / generic fallback
// ---------------------------------------------------------------------------

describe('classifyError — generic fallback', () => {
  it('returns unknown category for unrecognised errors', () => {
    const result = classifyError(new Error('something completely unrecognised'));
    expect(result.category).toBe('unknown');
  });

  it('handles non-Error thrown values', () => {
    const result = classifyError('plain string error');
    expect(result).toBeDefined();
    expect(typeof result.message).toBe('string');
  });

  it('handles null/undefined gracefully', () => {
    const result = classifyError(null);
    expect(result).toBeDefined();
    expect(result.category).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// fieldAriaDescribedBy
// ---------------------------------------------------------------------------

describe('fieldAriaDescribedBy', () => {
  const err: AccessibleError = {
    message: 'test',
    action: '',
    category: 'validation',
    isRetryable: false,
    fieldId: 'sfm-amount',
  };

  it('returns the error element id when fieldId matches', () => {
    expect(fieldAriaDescribedBy('sfm-amount', err)).toBe('sfm-amount-error');
  });

  it('returns undefined when fieldId does not match', () => {
    expect(fieldAriaDescribedBy('sfm-note', err)).toBeUndefined();
  });

  it('returns undefined when error is null', () => {
    expect(fieldAriaDescribedBy('sfm-amount', null)).toBeUndefined();
  });

  it('returns undefined when error has no fieldId', () => {
    const noField: AccessibleError = { ...err, fieldId: undefined };
    expect(fieldAriaDescribedBy('sfm-amount', noField)).toBeUndefined();
  });

  it('honours custom suffix', () => {
    expect(fieldAriaDescribedBy('sfm-amount', err, '-desc')).toBe('sfm-amount-desc');
  });
});

// ---------------------------------------------------------------------------
// buildErrorSummary
// ---------------------------------------------------------------------------

describe('buildErrorSummary', () => {
  it('combines message and action', () => {
    const err: AccessibleError = {
      message: 'Insufficient balance.',
      action: 'Add more XLM.',
      category: 'contract',
      isRetryable: false,
    };
    expect(buildErrorSummary(err)).toBe('Insufficient balance. Add more XLM.');
  });

  it('returns just the message when action is empty', () => {
    const err: AccessibleError = {
      message: 'Session expired.',
      action: '',
      category: 'auth',
      isRetryable: false,
    };
    expect(buildErrorSummary(err)).toBe('Session expired.');
  });

  it('returns null for null input', () => {
    expect(buildErrorSummary(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(buildErrorSummary(undefined)).toBeNull();
  });
});
