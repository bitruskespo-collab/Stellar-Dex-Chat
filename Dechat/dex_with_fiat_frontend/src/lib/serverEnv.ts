import 'server-only';
import { z } from 'zod';
import { clientEnv, formatErrors } from './clientEnv';

const parseBooleanFlag = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
};

/**
 * Parses a comma-separated list of origins into a normalized, de-duplicated
 * array. Each entry must be a bare origin (scheme + host + optional port) with
 * no path, query, fragment or trailing slash, e.g. `https://app.example.com`.
 */
export const parseAllowedOrigins = (value: unknown): string[] => {
  if (typeof value !== 'string') return [];
  const seen = new Set<string>();
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`Invalid CORS origin "${entry}": must be an absolute origin`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Invalid CORS origin "${entry}": only http(s) origins are allowed`);
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error(`Invalid CORS origin "${entry}": must not include path, query, fragment or credentials`);
    }
    seen.add(parsed.origin);
  }
  return Array.from(seen);
};

export const serverSchema = z.object({
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYOUT_PROVIDER: z.string().default('paystack'),
  ADMIN_IP_ALLOWLIST: z.string().optional(),
  ADMIN_IP_ALLOWLIST_BYPASS_LOCAL: z.preprocess(parseBooleanFlag, z.boolean().default(false)),
  ADMIN_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Comma-separated list of trusted browser origins allowed to call financial routes.
  CORS_ALLOWED_ORIGINS: z.preprocess(parseAllowedOrigins, z.array(z.string()).default([])),
  // Whether cross-origin responses may include credentials (cookies/auth headers).
  CORS_ALLOW_CREDENTIALS: z.preprocess(parseBooleanFlag, z.boolean().default(false)),
});

const processServerEnvVars = () => {
  const serverVars = {
    PAYSTACK_SECRET_KEY: typeof process !== 'undefined' ? process.env.PAYSTACK_SECRET_KEY : undefined,
    PAYOUT_PROVIDER: typeof process !== 'undefined' ? process.env.PAYOUT_PROVIDER : undefined,
    ADMIN_IP_ALLOWLIST: typeof process !== 'undefined' ? process.env.ADMIN_IP_ALLOWLIST : undefined,
    ADMIN_IP_ALLOWLIST_BYPASS_LOCAL: typeof process !== 'undefined' ? process.env.ADMIN_IP_ALLOWLIST_BYPASS_LOCAL : undefined,
    ADMIN_SECRET: typeof process !== 'undefined' ? process.env.ADMIN_SECRET : undefined,
    GEMINI_API_KEY: typeof process !== 'undefined' ? process.env.GEMINI_API_KEY : undefined,
    CORS_ALLOWED_ORIGINS: typeof process !== 'undefined' ? process.env.CORS_ALLOWED_ORIGINS : undefined,
    CORS_ALLOW_CREDENTIALS: typeof process !== 'undefined' ? process.env.CORS_ALLOW_CREDENTIALS : undefined,
  };

  const parsed = serverSchema.safeParse(serverVars);

  if (!parsed.success) {
    console.error(
      '❌ Invalid server environment variables:\n',
      formatErrors(parsed.error.format()),
    );
    throw new Error('Invalid server environment variables');
  }

  return { ...clientEnv, ...parsed.data };
};

export const serverEnv = processServerEnvVars();
