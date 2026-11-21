/**
 * Performance budgets for large admin audit and long chat history views.
 *
 * Budgets are enforced in code paths that load, paginate, export, or render
 * representative large datasets. Tests measure synthetic representative
 * datasets against these limits.
 */

export const PERFORMANCE_BUDGETS = {
  audit: {
    /** Default rows rendered in audit table page. */
    pageSize: 20,
    /** Max rows the audit table may request per API call. */
    maxRequestLimit: 100,
    /** Max pages exported by UI to bound request count. */
    maxExportPages: 50,
    /** Max rows exported by UI in one export action. */
    maxExportRows: 10_000,
    /** Representative dataset size for measurements. */
    representativeDatasetSize: 10_000,
    /** Max render/processing time for representative page derivation (ms). */
    maxRenderMs: 100,
    /** Max request count for a full bounded export. */
    maxExportRequestCount: 50,
  },
  chat: {
    /** Default messages rendered per page. */
    pageSize: 20,
    /** Max messages kept in visible render window to bound DOM/memory. */
    maxVisibleMessages: 200,
    /** Max sessions kept in local storage. */
    maxStoredSessions: 50,
    /** Max messages per session retained in memory for render budgeting. */
    representativeHistorySize: 5_000,
    /** Max render/processing time for representative visible slice (ms). */
    maxRenderMs: 100,
    /** Max request count for initial chat history hydration (local-only). */
    maxInitialRequestCount: 0,
  },
} as const;

export type PerformanceBudgetResult = {
  name: string;
  withinBudget: boolean;
  measured: number;
  budget: number;
  unit: 'ms' | 'count' | 'bytes' | 'items';
};

export function withinBudget(measured: number, budget: number): boolean {
  return Number.isFinite(measured) && Number.isFinite(budget) && measured <= budget;
}

export function measureSyncMs<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  const ms = performance.now() - start;
  return { ms, value };
}

export function evaluateBudget(
  name: string,
  measured: number,
  budget: number,
  unit: PerformanceBudgetResult['unit'],
): PerformanceBudgetResult {
  return {
    name,
    withinBudget: withinBudget(measured, budget),
    measured,
    budget,
    unit,
  };
}

export function assertBudget(result: PerformanceBudgetResult): void {
  if (!result.withinBudget) {
    throw new Error(
      `Performance budget exceeded: ${result.name} measured ${result.measured}${result.unit} > budget ${result.budget}${result.unit}`,
    );
  }
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function boundedPageCount(totalItems: number, pageSize: number, maxPages: number): number {
  const safePageSize = clampInt(pageSize, 1, Number.MAX_SAFE_INTEGER);
  const safeTotal = Math.max(0, Math.trunc(totalItems));
  const pages = Math.ceil(safeTotal / safePageSize);
  return clampInt(pages, 0, maxPages);
}
