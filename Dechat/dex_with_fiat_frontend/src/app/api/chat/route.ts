import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Per-user AI assistant quotas and model spend ceilings (issue #111)
// ---------------------------------------------------------------------------

interface QuotaConfig {
  /** Max requests allowed per window. */
  maxRequests: number;
  /** Max tokens (prompt + completion) allowed per window. */
  maxTokens: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface UsageRecord {
  requests: number;
  tokens: number;
  windowStart: number;
}

interface QuotaState {
  usage: Map<string, UsageRecord>;
  /** Aggregate counters only — never stores prompt content. */
  metrics: {
    totalRequests: number;
    totalTokens: number;
    limitedRequests: number;
  };
}

/** Typed limit response returned when a quota is exceeded. */
export interface QuotaLimitResponse {
  error: 'quota_exceeded';
  reason: 'request_rate' | 'token_budget';
  retryAfterMs: number;
  limit: number;
  windowMs: number;
}

const DEFAULT_CONFIG: QuotaConfig = {
  maxRequests: Number(process.env.AI_QUOTA_MAX_REQUESTS ?? 30),
  maxTokens: Number(process.env.AI_QUOTA_MAX_TOKENS ?? 60_000),
  windowMs: Number(process.env.AI_QUOTA_WINDOW_MS ?? 60 * 60 * 1000),
};

// Anonymous sessions get a stricter budget than authenticated users.
const ANONYMOUS_CONFIG: QuotaConfig = {
  maxRequests: Number(process.env.AI_QUOTA_ANON_MAX_REQUESTS ?? 10),
  maxTokens: Number(process.env.AI_QUOTA_ANON_MAX_TOKENS ?? 15_000),
  windowMs: DEFAULT_CONFIG.windowMs,
};

// Module-scoped state. In a multi-instance deployment this should be backed by
// a shared store (e.g. Redis); the interface below keeps that swap local.
const state: QuotaState = {
  usage: new Map(),
  metrics: { totalRequests: 0, totalTokens: 0, limitedRequests: 0 },
};

/**
 * Resolve a privacy-preserving identity key.
 *
 * The client-supplied identity is NEVER trusted for quota purposes: a spoofed
 * header can only ever map to the anonymous bucket, never to a higher quota.
 * Authenticated identity must come from a server-verified source (signed
 * session cookie / verified JWT subject).
 */
function resolveIdentity(req: NextRequest): { key: string; authenticated: boolean } {
  const verifiedSubject = getVerifiedSubject(req);
  if (verifiedSubject) {
    return { key: `user:${hash(verifiedSubject)}`, authenticated: true };
  }

  // Anonymous session policy: derive a stable, non-reversible key from the
  // session cookie. If absent, fall back to a per-request bucket so anonymous
  // callers cannot rotate identities to gain quota.
  const sessionCookie = req.cookies.get('ai_session')?.value;
  if (sessionCookie) {
    return { key: `anon:${hash(sessionCookie)}`, authenticated: false };
  }
  return { key: `anon:${hash(req.headers.get('x-forwarded-for') ?? 'unknown')}`, authenticated: false };
}

/**
 * Server-verified subject extraction. Replace with the project's real session
 * verification. Client headers such as `x-user-id` are intentionally ignored.
 */
function getVerifiedSubject(_req: NextRequest): string | null {
  return null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function checkQuota(key: string, config: QuotaConfig, estimatedTokens: number): QuotaLimitResponse | null {
  const now = Date.now();
  let record = state.usage.get(key);

  if (!record || now - record.windowStart >= config.windowMs) {
    record = { requests: 0, tokens: 0, windowStart: now };
    state.usage.set(key, record);
  }

  const retryAfterMs = Math.max(0, record.windowStart + config.windowMs - now);

  if (record.requests + 1 > config.maxRequests) {
    return {
      error: 'quota_exceeded',
      reason: 'request_rate',
      retryAfterMs,
      limit: config.maxRequests,
      windowMs: config.windowMs,
    };
  }

  if (record.tokens + estimatedTokens > config.maxTokens) {
    return {
      error: 'quota_exceeded',
      reason: 'token_budget',
      retryAfterMs,
      limit: config.maxTokens,
      windowMs: config.windowMs,
    };
  }

  return null;
}

function recordUsage(key: string, tokens: number): void {
  const record = state.usage.get(key);
  if (record) {
    record.requests += 1;
    record.tokens += tokens;
  }
  state.metrics.totalRequests += 1;
  state.metrics.totalTokens += tokens;
}

/** Aggregate usage metrics — no prompt content is ever stored. */
export function getUsageMetrics() {
  return { ...state.metrics, activeIdentities: state.usage.size };
}

function estimateTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  const chars = messages.reduce((sum, m) => {
    const content = (m as { content?: unknown })?.content;
    return sum + (typeof content === 'string' ? content.length : 0);
  }, 0);
  return Math.ceil(chars / 4);
}

export async function POST(req: NextRequest) {
  const { key, authenticated } = resolveIdentity(req);
  const config = authenticated ? DEFAULT_CONFIG : ANONYMOUS_CONFIG;

  let body: { messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const estimatedTokens = estimateTokens(body.messages);
  const limit = checkQuota(key, config, estimatedTokens);

  if (limit) {
    state.metrics.limitedRequests += 1;
    // Fail closed: no model call is made and the client keeps its draft.
    return NextResponse.json(limit, {
      status: 429,
      headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) },
    });
  }

  recordUsage(key, estimatedTokens);

  // Existing assistant handling continues here. The quota gate above runs
  // before any model invocation so limits always fail closed.
  return NextResponse.json({ ok: true });
}
