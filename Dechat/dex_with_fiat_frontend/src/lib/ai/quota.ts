/**
 * Per-user AI assistant quota enforcement.
 *
 * Provides configurable request-rate and token/spend budgets keyed by an
 * authenticated or privacy-preserving user identity, a typed limit response
 * with retry timing, spoofing-resistant identity resolution, and aggregate
 * usage metrics that never store prompt content.
 */

export type QuotaIdentityKind = "authenticated" | "anonymous";

export interface QuotaIdentity {
  /** Stable, server-derived key. Never trust a client-supplied value. */
  key: string;
  kind: QuotaIdentityKind;
}

export interface QuotaBudget {
  /** Max requests allowed within the window. */
  maxRequests: number;
  /** Max tokens allowed within the window. */
  maxTokens: number;
  /** Max spend (in minor currency units, e.g. cents) within the window. */
  maxSpendCents: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
}

export interface QuotaConfig {
  authenticated: QuotaBudget;
  anonymous: QuotaBudget;
}

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  authenticated: {
    maxRequests: 60,
    maxTokens: 120_000,
    maxSpendCents: 500,
    windowMs: 60 * 60 * 1000,
  },
  anonymous: {
    maxRequests: 10,
    maxTokens: 15_000,
    maxSpendCents: 50,
    windowMs: 60 * 60 * 1000,
  },
};

export type QuotaLimitReason = "requests" | "tokens" | "spend";

export interface QuotaLimitResponse {
  limited: true;
  reason: QuotaLimitReason;
  /** Milliseconds until the caller may retry. */
  retryAfterMs: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
  /** Budget that was exceeded, for client display. */
  budget: QuotaBudget;
}

export interface QuotaAllowedResponse {
  limited: false;
  remaining: {
    requests: number;
    tokens: number;
    spendCents: number;
  };
  resetAt: number;
}

export type QuotaDecision = QuotaAllowedResponse | QuotaLimitResponse;

export interface QuotaUsage {
  requests: number;
  tokens: number;
  spendCents: number;
  windowStart: number;
}

/**
 * Aggregate, content-free usage metrics. Counts only; never prompt text.
 */
export interface QuotaMetrics {
  totalRequests: number;
  totalTokens: number;
  totalSpendCents: number;
  limitedRequests: number;
  limitedByReason: Record<QuotaLimitReason, number>;
  activeIdentities: number;
}

/**
 * Resolve the quota identity from server-trusted inputs only.
 *
 * Client-supplied identity hints are ignored so a caller cannot spoof a
 * higher quota. Authenticated users are keyed by their verified user id;
 * everyone else falls back to a privacy-preserving anonymous session key.
 */
export function resolveQuotaIdentity(input: {
  /** Verified user id from the server session, if any. */
  userId?: string | null;
  /** Server-issued anonymous session id (opaque, not client-chosen). */
  anonymousSessionId?: string | null;
}): QuotaIdentity {
  const userId = input.userId?.trim();
  if (userId) {
    return { key: `user:${userId}`, kind: "authenticated" };
  }
  const sessionId = input.anonymousSessionId?.trim();
  if (sessionId) {
    return { key: `anon:${sessionId}`, kind: "anonymous" };
  }
  // Fail closed: unknown callers share the strictest anonymous bucket.
  return { key: "anon:unidentified", kind: "anonymous" };
}

function emptyUsage(now: number): QuotaUsage {
  return { requests: 0, tokens: 0, spendCents: 0, windowStart: now };
}

function rollWindow(usage: QuotaUsage, budget: QuotaBudget, now: number): QuotaUsage {
  if (now - usage.windowStart >= budget.windowMs) {
    return emptyUsage(now);
  }
  return usage;
}

function budgetFor(config: QuotaConfig, kind: QuotaIdentityKind): QuotaBudget {
  return kind === "authenticated" ? config.authenticated : config.anonymous;
}

/**
 * In-memory quota store. Swap the backing map for a shared store in
 * production; the decision logic below stays the same.
 */
export class QuotaStore {
  private readonly usage = new Map<string, QuotaUsage>();
  private readonly metrics: QuotaMetrics = {
    totalRequests: 0,
    totalTokens: 0,
    totalSpendCents: 0,
    limitedRequests: 0,
    limitedByReason: { requests: 0, tokens: 0, spend: 0 },
    activeIdentities: 0,
  };

  constructor(private readonly config: QuotaConfig = DEFAULT_QUOTA_CONFIG) {}

  /**
   * Check whether a request may proceed. Does not consume budget; call
   * `record` after the model responds with actual token/spend usage.
   */
  check(identity: QuotaIdentity, now: number = Date.now()): QuotaDecision {
    const budget = budgetFor(this.config, identity.kind);
    const current = rollWindow(
      this.usage.get(identity.key) ?? emptyUsage(now),
      budget,
      now,
    );
    const resetAt = current.windowStart + budget.windowMs;

    const reason = this.exceededReason(current, budget);
    if (reason) {
      this.metrics.limitedRequests += 1;
      this.metrics.limitedByReason[reason] += 1;
      return {
        limited: true,
        reason,
        retryAfterMs: Math.max(0, resetAt - now),
        resetAt,
        budget,
      };
    }

    return {
      limited: false,
      remaining: {
        requests: Math.max(0, budget.maxRequests - current.requests),
        tokens: Math.max(0, budget.maxTokens - current.tokens),
        spendCents: Math.max(0, budget.maxSpendCents - current.spendCents),
      },
      resetAt,
    };
  }

  /**
   * Record consumed budget after a completed request. Only counts are kept;
   * prompt content is never stored.
   */
  record(
    identity: QuotaIdentity,
    usage: { tokens: number; spendCents: number },
    now: number = Date.now(),
  ): void {
    const budget = budgetFor(this.config, identity.kind);
    const current = rollWindow(
      this.usage.get(identity.key) ?? emptyUsage(now),
      budget,
      now,
    );
    const next: QuotaUsage = {
      requests: current.requests + 1,
      tokens: current.tokens + Math.max(0, usage.tokens),
      spendCents: current.spendCents + Math.max(0, usage.spendCents),
      windowStart: current.windowStart,
    };
    if (!this.usage.has(identity.key)) {
      this.metrics.activeIdentities += 1;
    }
    this.usage.set(identity.key, next);

    this.metrics.totalRequests += 1;
    this.metrics.totalTokens += Math.max(0, usage.tokens);
    this.metrics.totalSpendCents += Math.max(0, usage.spendCents);
  }

  /** Aggregate, content-free usage metrics. */
  getMetrics(): QuotaMetrics {
    return {
      ...this.metrics,
      limitedByReason: { ...this.metrics.limitedByReason },
    };
  }

  private exceededReason(usage: QuotaUsage, budget: QuotaBudget): QuotaLimitReason | null {
    if (usage.requests >= budget.maxRequests) return "requests";
    if (usage.tokens >= budget.maxTokens) return "tokens";
    if (usage.spendCents >= budget.maxSpendCents) return "spend";
    return null;
  }
}

/**
 * Preserve the chat draft when a request is limited so the user does not
 * lose their message. Returns the draft unchanged alongside the limit info.
 */
export function preserveDraftOnLimit<TDraft>(
  draft: TDraft,
  limit: QuotaLimitResponse,
): { draft: TDraft; limit: QuotaLimitResponse } {
  return { draft, limit };
}
