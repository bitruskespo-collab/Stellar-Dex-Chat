/**
 * Privacy/safety guard for committed test fixtures.
 * Rejects real-looking credentials, production secret formats, and known live identifiers.
 */

export type PrivacyViolation = {
  path: string;
  reason: string;
  match: string;
};

const REDACTED = '[REDACTED]';

const FORBIDDEN_PATTERNS: Array<{ reason: string; regex: RegExp }> = [
  { reason: 'Live Paystack secret key', regex: /\bsk_live_[A-Za-z0-9]+\b/g },
  { reason: 'Live Paystack public key', regex: /\bpk_live_[A-Za-z0-9]+\b/g },
  { reason: 'Live Stripe secret key', regex: /\bsk_live_[A-Za-z0-9]+\b/g },
  { reason: 'Stripe live key', regex: /\b(?:rk_live|pk_live)_[A-Za-z0-9]+\b/g },
  { reason: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { reason: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { reason: 'Private key block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { reason: 'Mnemonic/seed phrase assignment', regex: /\b(seed_phrase|mnemonic|recovery_phrase)\b\s*[:=]\s*['"][^'"]{10,}['"]/gi },
];

const SENSITIVE_ASSIGNMENT =
  /\b(api[_-]?key|secret|password|token|credential|private[_-]?key)\b"?\s*[:=]\s*['"]([^'"\n]{8,})['"]/gi;
const ALLOWED_VALUE_PATTERNS = [
  /^test/i,
  /^fake/i,
  /^synthetic/i,
  /^dummy/i,
  /^example/i,
  /^placeholder/i,
  /^changeme/i,
  /^sk_test_/i,
  /^pk_test_/i,
  /^rk_test_/i,
  /^whsec_test_/i,
  /^xoxb-test/i,
  /^G[A-Z2-7]{55}$/, // Stellar public key format (public, not secret)
  /^C[A-Z2-7]{55}$/, // Stellar contract id format (public)
  /^\*+$/, // masked
  /^\[REDACTED\]$/,
];

function isAllowedSensitiveValue(value: string): boolean {
  if (value.length === 0) return true;
  return ALLOWED_VALUE_PATTERNS.some((p) => p.test(value));
}

function mask(match: string): string {
  if (match.length <= 8) return REDACTED;
  return `${match.slice(0, 4)}${REDACTED}${match.slice(-4)}`;
}

export function scanTextForPrivacyViolations(text: string, path = '<text>'): PrivacyViolation[] {
  const violations: PrivacyViolation[] = [];

  for (const { reason, regex } of FORBIDDEN_PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      violations.push({ path, reason, match: mask(m[0]) });
    }
  }

  SENSITIVE_ASSIGNMENT.lastIndex = 0;
  let assign: RegExpExecArray | null;
  while ((assign = SENSITIVE_ASSIGNMENT.exec(text)) !== null) {
    const key = assign[1];
    const value = assign[2];
    if (!isAllowedSensitiveValue(value)) {
      violations.push({
        path,
        reason: `Sensitive assignment looks non-synthetic: ${key}`,
        match: `${key}=${mask(value)}`,
      });
    }
  }

  return violations;
}

export function assertNoPrivacyViolations(text: string, path = '<text>'): void {
  const violations = scanTextForPrivacyViolations(text, path);
  if (violations.length > 0) {
    const details = violations
      .map((v) => `- ${v.path}: ${v.reason} (${v.match})`)
      .join('\n');
    throw new Error(`Privacy/credential guard failed:\n${details}`);
  }
}

export function scanJsonFixture(value: unknown, path = '<fixture>'): PrivacyViolation[] {
  const text = JSON.stringify(value, null, 2);
  return scanTextForPrivacyViolations(text, path);
}

export function assertJsonFixtureIsSafe(value: unknown, path = '<fixture>'): void {
  assertNoPrivacyViolations(JSON.stringify(value, null, 2), path);
}
