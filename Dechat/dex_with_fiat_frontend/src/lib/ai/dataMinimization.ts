/**
 * Prompt & Response Data Minimization Controls
 * Addresses Issue #80: Limit financial and personal information sent to model providers
 * and avoid retaining sensitive chat content longer than necessary.
 */

export interface RetentionPolicy {
  maxChatHistoryAgeHours: number;
  autoPurgeSensitivePayloads: boolean;
  providerDataRetentionDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxChatHistoryAgeHours: 72, // 3 days local retention
  autoPurgeSensitivePayloads: true,
  providerDataRetentionDays: 0, // Zero-retention enterprise tier
};

/**
 * Classifies and redacts financial PII, account numbers, and credentials
 * prior to dispatching prompts to LLM providers.
 */
export function minimizePromptData(text: string): { sanitized: string; redactedFields: string[] } {
  if (!text) return { sanitized: '', redactedFields: [] };

  const redactedFields: string[] = [];
  let sanitized = text;

  // 1. Bank account numbers (10 digits)
  if (/\b\d{10}\b/.test(sanitized)) {
    sanitized = sanitized.replace(/\b\d{10}\b/g, '[REDACTED_BANK_ACCOUNT]');
    redactedFields.push('bank_account');
  }

  // 2. Stellar Secret Keys (S...)
  if (/S[A-Z0-9]{55}/.test(sanitized)) {
    sanitized = sanitized.replace(/S[A-Z0-9]{55}/g, '[REDACTED_SECRET_KEY]');
    redactedFields.push('stellar_secret_key');
  }

  // 3. API Tokens / PATs
  if (/ghp_[A-Za-z0-9]+/.test(sanitized)) {
    sanitized = sanitized.replace(/ghp_[A-Za-z0-9]+/g, '[REDACTED_PAT]');
    redactedFields.push('personal_access_token');
  }

  // 4. Passwords / PINs
  if (/(?:pin|password|passcode)\s*[:=]\s*\d{4,8}/i.test(sanitized)) {
    sanitized = sanitized.replace(/(?:pin|password|passcode)\s*[:=]\s*\d{4,8}/gi, '[REDACTED_CREDENTIAL]');
    redactedFields.push('credential');
  }

  return { sanitized, redactedFields };
}

/**
 * Configurable local history scrubber for expired data.
 */
export function purgeExpiredChatData(
  entries: Array<{ id: string; timestamp: number; content: string }>,
  maxAgeHours: number = DEFAULT_RETENTION_POLICY.maxChatHistoryAgeHours
): Array<{ id: string; timestamp: number; content: string }> {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  return entries.filter((e) => e.timestamp >= cutoff);
}
