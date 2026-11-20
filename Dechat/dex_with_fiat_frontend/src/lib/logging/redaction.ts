/**
 * Centralized redaction for telemetry boundaries.
 *
 * Every log / trace / metric emission that may carry user or provider data MUST
 * pass through `redact()` (or one of the helpers below) before being serialized.
 * This module is the single source of truth for what counts as "sensitive".
 *
 * ---------------------------------------------------------------------------
 * CONTRACT
 * ---------------------------------------------------------------------------
 *
 * 1. Key-based redaction
 *    Any object key whose normalized form (lowercased, non-alphanumerics
 *    stripped) matches an entry in `SENSITIVE_KEY_PATTERNS` is replaced with
 *    `REDACTED`. Matching is substring-based so `userPassword`, `x-api-key`,
 *    `walletAddress`, `providerPayload`, etc. are all caught.
 *
 * 2. Value-based redaction
 *    String values are scanned for `SENSITIVE_VALUE_PATTERNS` (IBANs, account
 *    numbers, sort codes, JWTs, bearer tokens, PEM private keys, common API key
 *    shapes). Matches are replaced with `REDACTED`. This runs even when the key
 *    is not sensitive (e.g. a free-text `message` field).
 *
 * 3. Encoded values
 *    Before value matching, strings are decoded (up to `MAX_DECODE_DEPTH`):
 *      - URL / percent encoding (`decodeURIComponent`)
 *      - Base64 (standard and URL-safe, with or without padding)
 *    If a decoded form matches a sensitive pattern, the *entire original string*
 *    is redacted (we never emit partially-decoded secrets). Decoding is
 *    best-effort and never throws.
 *
 * 4. Structure
 *    Objects and arrays are traversed recursively. Depth is bounded by
 *    `MAX_DEPTH`; beyond that the value is replaced with `REDACTED` to avoid
 *    pathological payloads. Circular references are handled via a `WeakSet`.
 *    `Error` instances are reduced to `{ name, message, stack }` with the
 *    message and stack scrubbed. `Map`/`Set` are converted to arrays.
 *
 * 5. Prompt content & provider payloads
 *    Keys matching `prompt*`, `messages`, `completion*`, `provider*`,
 *    `requestBody`, `responseBody`, etc. are redacted wholesale because their
 *    contents are user- or provider-supplied and cannot be safely classified.
 *
 * ---------------------------------------------------------------------------
 * ADDING NEW SENSITIVE KEYS / PATTERNS
 * ---------------------------------------------------------------------------
 *  - Add a lowercase, punctuation-free substring to `SENSITIVE_KEY_PATTERNS`.
 *  - Add a `RegExp` (with the `g` flag) to `SENSITIVE_VALUE_PATTERNS`.
 *  - Add a fixture under `__fixtures__/redaction/` and a case in
 *    `redaction.test.ts` (see existing adversarial fixtures for nested and
 *    encoded values).
 *  - Never add real credentials or user data to fixtures.
 */

export const REDACTED = '[REDACTED]';

/** Maximum object/array traversal depth before we bail out. */
export const MAX_DEPTH = 12;

/** Maximum number of decode passes applied to a string. */
export const MAX_DECODE_DEPTH = 3;

/**
 * Lowercase, punctuation-free substrings. A key is sensitive if its
 * normalized form contains any of these.
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  // Bank details
  'accountnumber',
  'accountno',
  'acctno',
  'bankaccount',
  'iban',
  'sortcode',
  'routingnumber',
  'bic',
  'swift',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  'expiry',
  // Credentials
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'api_key',
  'accesskey',
  'privatekey',
  'clientsecret',
  'credential',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'mnemonic',
  'seedphrase',
  // Wallet / session tokens
  'token',
  'jwt',
  'bearer',
  'sessionid',
  'session',
  'walletaddress',
  'wallet',
  'privatekeyhex',
  'signature',
  'nonce',
  'otp',
  // Prompt content
  'prompt',
  'messages',
  'completion',
  'systemmessage',
  'usermessage',
  'assistantmessage',
  'conversation',
  // Provider payloads
  'providerpayload',
  'providerrequest',
  'providerresponse',
  'requestbody',
  'responsebody',
  'rawpayload',
  'rawrequest',
  'rawresponse',
];

/**
 * Value patterns. Each MUST have the `g` flag. Matches are replaced with
 * `REDACTED`. Keep these conservative to avoid over-redacting benign text.
 */
export const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // IBAN: 2 letters, 2 digits, 11-30 alphanumerics (spaces allowed)
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g,
  // Sort code: 12-34-56 or 123456
  /\b\d{2}[- ]?\d{2}[- ]?\d{2}\b/g,
  // Long digit runs (account / card numbers)
  /\b\d{8,19}\b/g,
  // JWT: three base64url segments
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Common API key shapes (sk-, pk-, ak-, ghp_, xoxb-, etc.)
  /\b(?:sk|pk|ak|rk)[-_][A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export interface RedactOptions {
  /** Extra key substrings to treat as sensitive (merged with defaults). */
  extraKeys?: readonly string[];
  /** Extra value patterns (must have `g` flag). */
  extraPatterns?: readonly RegExp[];
  /** Replacement marker. Defaults to `REDACTED`. */
  replacement?: string;
  /** Max traversal depth. Defaults to `MAX_DEPTH`. */
  maxDepth?: number;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string, extraKeys: readonly string[]): boolean {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (normalized.includes(pattern)) return true;
  }
  for (const pattern of extraKeys) {
    if (normalized.includes(normalizeKey(pattern))) return true;
  }
  return false;
}

function safeDecodeURI(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded !== value ? decoded : null;
  } catch {
    return null;
  }
}

function safeDecodeBase64(value: string): string | null {
  // Only attempt on plausible base64 tokens to avoid mangling normal text.
  const trimmed = value.trim();
  if (trimmed.length < 8) return null;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return null;
  // Reject strings that are clearly plain words (no digits / symbols).
  if (!/[0-9+/=_-]/.test(trimmed)) return null;
  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    // atob is available in browsers and Node >= 16.
    const decoded = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    // Heuristic: decoded content should be mostly printable.
    if (!decoded || !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function matchesAnyPattern(value: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    // Reset lastIndex for global regexes reused across calls.
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

function decodeCandidates(value: string): string[] {
  const results: string[] = [];
  let frontier: string[] = [value];
  for (let depth = 0; depth < MAX_DECODE_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const candidate of frontier) {
      const uri = safeDecodeURI(candidate);
      if (uri) next.push(uri);
      const b64 = safeDecodeBase64(candidate);
      if (b64) next.push(b64);
    }
    results.push(...next);
    frontier = next;
  }
  return results;
}

function redactString(
  value: string,
  patterns: readonly RegExp[],
  replacement: string,
): string {
  // 1. If any decoded form is sensitive, redact the whole string.
  const decoded = decodeCandidates(value);
  for (const candidate of decoded) {
    if (matchesAnyPattern(candidate, patterns)) {
      return replacement;
    }
  }

  // 2. Otherwise scrub inline matches in the original string.
  let result = value;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
    pattern.lastIndex = 0;
  }
  return result;
}

function redactError(
  error: Error,
  patterns: readonly RegExp[],
  replacement: string,
): Record<string, unknown> {
  return {
    name: error.name,
    message: redactString(error.message, patterns, replacement),
    stack: error.stack ? redactString(error.stack, patterns, replacement) : undefined,
  };
}

/**
 * Recursively redact sensitive data from an arbitrary value.
 *
 * The returned value is a new structure; the input is never mutated.
 * Functions and symbols are dropped (replaced with `undefined`).
 */
export function redact<T = unknown>(value: unknown, options: RedactOptions = {}): T {
  const replacement = options.replacement ?? REDACTED;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const extraKeys = options.extraKeys ?? [];
  const patterns: readonly RegExp[] = options.extraPatterns
    ? [...SENSITIVE_VALUE_PATTERNS, ...options.extraPatterns]
    : SENSITIVE_VALUE_PATTERNS;

  const seen = new WeakSet<object>();

  function walk(input: unknown, depth: number, keyHint?: string): unknown {
    if (input === null || input === undefined) return input;

    if (keyHint !== undefined && isSensitiveKey(keyHint, extraKeys)) {
      return replacement;
    }

    if (depth > maxDepth) {
      return replacement;
    }

    switch (typeof input) {
      case 'string':
        return redactString(input, patterns, replacement);
      case 'number':
      case 'boolean':
      case 'bigint':
        return input;
      case 'function':
      case 'symbol':
        return undefined;
      default:
        break;
    }

    if (input instanceof Date) return input.toISOString();

    if (input instanceof Error) {
      return redactError(input, patterns, replacement);
    }

    if (typeof input === 'object') {
      const obj = input as object;
      if (seen.has(obj)) return replacement;
      seen.add(obj);

      if (Array.isArray(input)) {
        return input.map((item) => walk(item, depth + 1));
      }

      if (input instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of input.entries()) {
          const key = String(k);
          out[key] = walk(v, depth + 1, key);
        }
        return out;
      }

      if (input instanceof Set) {
        return Array.from(input.values()).map((item) => walk(item, depth + 1));
      }

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = walk(v, depth + 1, k);
      }
      return out;
    }

    return input;
  }

  return walk(value, 0) as T;
}

/**
 * Minimal logger interface compatible with `console` and common loggers.
 */
export interface RedactedLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface RedactedLoggerOptions extends RedactOptions {
  /** Underlying sink. Defaults to `console`. */
  sink?: RedactedLogger;
}

/**
 * Wrap a logger so that every message and metadata payload is redacted at the
 * boundary. All telemetry code paths should use this instead of raw `console`.
 */
export function createRedactedLogger(options: RedactedLoggerOptions = {}): RedactedLogger {
  const sink: RedactedLogger = options.sink ?? console;
  const redactOptions: RedactOptions = {
    extraKeys: options.extraKeys,
    extraPatterns: options.extraPatterns,
    replacement: options.replacement,
    maxDepth: options.maxDepth,
  };

  const emit = (
    level: keyof RedactedLogger,
    message: string,
    meta?: unknown,
  ): void => {
    const safeMessage = redact<string>(message, redactOptions);
    const safeMeta = meta === undefined ? undefined : redact(meta, redactOptions);
    if (safeMeta === undefined) {
      sink[level](safeMessage);
    } else {
      sink[level](safeMessage, safeMeta);
    }
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}

/**
 * Redact a trace/span payload before it is handed to a tracing backend.
 * Returns a new object safe to serialize.
 */
export function redactTrace<T = Record<string, unknown>>(
  attributes: unknown,
  options: RedactOptions = {},
): T {
  return redact<T>(attributes, options);
}

/** Default process-wide redacted logger. */
export const logger: RedactedLogger = createRedactedLogger();