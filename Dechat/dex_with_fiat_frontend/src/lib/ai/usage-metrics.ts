/**
 * Per-user AI assistant quota enforcement and aggregate usage metrics.
 *
 * Design goals (issue #111):
 * - Configurable request-rate and token/spend budgets keyed by an identity that
 *   cannot be spoofed by the client.
 * - Typed limit responses that carry retry timing so the UI can preserve the
 *   chat draft and surface a countdown.
 * - Anonymous sessions get a strict, privacy-preserving policy (no client
 *   supplied id is ever trusted for quota keying).
 * - Aggregate metrics only: we never store prompt or completion content.
 */

/** Identity used to key quotas. Derived server-side, never from client input. */
export type QuotaIdentity =
  | { kind: "user"; userId: string }
  | { kind: "anonymous"; sessionId: string };

/** Budget configuration for a single identity tier. */
export interface QuotaBudget {
  /** Max requests allowed within the rolling window. */
  maxRequests: number;
  /** Max tokens (prompt + completion) allowed within the rolling window. */
  maxTokens: number;
  /** Max estimated spend in USD cents within the rolling window. */
  maxSpendCents: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
}

/** Per-tier budgets. Anonymous sessions are intentionally the tightest. */
export interface QuotaConfig {
  user: QuotaBudget;
  anonymous: QuotaBudget;
  /** Estimated cost per 1k tokens, in USD cents, used for spend ceilings. */
  centsPer1kTokens: number;
}

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  user: {
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
  centsPer1kTokens: 2,
};

/** Reason a request was rejected. */
export type QuotaLimitReason = "requests" | "tokens" | "spend";

/** Typed limit response returned when a request is denied. */
export interface QuotaLimitResponse {
  limited: true;
  reason: QuotaLimitReason;
  /** Milliseconds until the window resets and the request may be retried. */
  retryAfterMs: number;
  /** ISO timestamp of the next reset, for display. */
  resetAt: string;
  /** Budget that was exceeded, for diagnostics. */
  budget: QuotaBudget;
}

/** Successful admission result. */
export interface QuotaAllowResponse {
  limited: false;
  /** Remaining requests in the current window after this admission. */
  remainingRequests: number;
  /** Remaining tokens in the current window after this admission. */
  remainingTokens: number;
}

export type QuotaDecision = QuotaAllowResponse | QuotaLimitResponse;

/** Aggregate, content-free usage counters. */
export interface UsageMetrics {
  requests: number;
  limitedRequests: number;
  tokens: number;
  spendCents: number;
}

interface WindowState {
  windowStart: number;
  requests: number;
  tokens: number;
  spendCents: number;
}

/**
 * Resolve the quota identity from a trusted server-side context.
 *
 * SECURITY: client-supplied ids are deliberately ignored. Only a verified
 * authenticated user id, or a server-issued anonymous session id, is accepted.
 * This prevents a client from spoofing an identity to obtain a higher quota.
 */
export function resolveQuotaIdentity(ctx: {
  authenticatedUserId?: string | null;
  anonymousSessionId?: string | null;
}): QuotaIdentity {
  const userId = ctx.authenticatedUserId?.trim();
  if (userId) {
    return { kind: "user", userId };
  }
  const sessionId = ctx.anonymousSessionId?.trim();
  if (sessionId) {
    return { kind: "anonymous", sessionId };
  }
  // Fail closed: an unidentified caller is treated as the most restricted tier.
  return { kind: "anonymous", sessionId: "unidentified" };
}

function identityKey(identity: QuotaIdentity): string {
  return identity.kind === "user" ? `user:${identity.userId}` : `anon:${identity.sessionId}`;
}

function budgetFor(identity: QuotaIdentity, config: QuotaConfig): QuotaBudget {
  return identity.kind === "user" ? config.user : config.anonymous;
}

function estimateSpendCents(tokens: number, config: QuotaConfig): number {
  return Math.ceil((tokens / 1000) * config.centsPer1kTokens);
}

/**
 * In-memory quota store. Swap the backing map for a shared store (Redis, DB) in
 * production; the interface and semantics stay identical.
 */
export class QuotaStore {
  private readonly windows = new Map<string, WindowState>();
  private readonly metrics = new Map<string, UsageMetrics>();

  constructor(private readonly config: QuotaConfig = DEFAULT_QUOTA_CONFIG) {}

  private currentWindow(key: string, now: number, windowMs: number): WindowState {
    const existing = this.windows.get(key);
    if (!existing || now - existing.windowStart >= windowMs) {
      const fresh: WindowState = { windowStart: now, requests: 0, tokens: 0, spendCents: 0 };
      this.windows.set(key, fresh);
      return fresh;
    }
    return existing;
  }

  private metricsFor(key: string): UsageMetrics {
    const existing = this.metrics.get(key);
    if (existing) return existing;
    const fresh: UsageMetrics = { requests: 0, limitedRequests: 0, tokens: 0, spendCents: 0 };
    this.metrics.set(key, fresh);
    return fresh;
  }

  /**
   * Check whether a request may proceed. `estimatedTokens` is the caller's
   * pre-flight estimate; actual usage is recorded via `recordUsage`.
   */
  check(identity: QuotaIdentity, estimatedTokens: number, now: number = Date.now()): QuotaDecision {
    const key = identityKey(identity);
    const budget = budgetFor(identity, this.config);
    const window = this.currentWindow(key, now, budget.windowMs);
    const resetAt = new Date(window.windowStart + budget.windowMs).toISOString();
    const retryAfterMs = Math.max(0, window.windowStart + budget.windowMs - now);

    const projectedTokens = window.tokens + Math.max(0, estimatedTokens);
    const projectedSpend = window.spendCents + estimateSpendCents(Math.max(0, estimatedTokens), this.config);

    let reason: QuotaLimitReason | null = null;
    if (window.requests + 1 > budget.maxRequests) {
      reason = "requests";
    } else if (projectedTokens > budget.maxTokens) {
      reason = "tokens";
    } else if (projectedSpend > budget.maxSpendCents) {
      reason = "spend";
    }

    if (reason) {
      this.metricsFor(key).limitedRequests += 1;
      return { limited: true, reason, retryAfterMs, resetAt, budget };
    }

    return {
      limited: false,
      remainingRequests: budget.maxRequests - (window.requests + 1),
      remainingTokens: budget.maxTokens - projectedTokens,
    };
  }

  /**
   * Record actual usage after a request completes. Only counts are stored —
   * never prompt or completion content.
   */
  recordUsage(identity: QuotaIdentity, tokens: number, now: number = Date.now()): void {
    const key = identityKey(identity);
    const budget = budgetFor(identity, this.config);
    const window = this.currentWindow(key, now, budget.windowMs);
    const safeTokens = Math.max(0, tokens);
    const spend = estimateSpendCents(safeTokens, this.config);

    window.requests += 1;
    window.tokens += safeTokens;
    window.spendCents += spend;

    const metrics = this.metricsFor(key);
    metrics.requests += 1;
    metrics.tokens += safeTokens;
    metrics.spendCents += spend;
  }

  /** Aggregate, content-free metrics for a single identity. */
  getMetrics(identity: QuotaIdentity): UsageMetrics {
    return { ...this.metricsFor(identityKey(identity)) };
  }

  /** Aggregate metrics across all identities, for dashboards. */
  getAggregateMetrics(): UsageMetrics {
    const total: UsageMetrics = { requests: 0, limitedRequests: 0, tokens: 0, spendCents: 0 };
    for (const m of this.metrics.values()) {
      total.requests += m.requests;
      total.limitedRequests += m.limitedRequests;
      total.tokens += m.tokens;
      total.spendCents += m.spendCents;
    }
    return total;
  }
}
