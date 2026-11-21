import { describe, expect, it } from 'vitest';
import { ChatMessage } from '@/types';
import { getNextMessageCount, getVisibleMessages } from './chatPaginationUtils';
import {
  PERFORMANCE_BUDGETS,
  assertBudget,
  boundedPageCount,
  clampInt,
  evaluateBudget,
  measureSyncMs,
  withinBudget,
} from './performanceBudgets';

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Synthetic message ${i}`,
    timestamp: new Date(1700000000000 + i * 1000),
  }));
}

describe('performance budgets (#275)', () => {
  it('evaluates budgets for normal and boundary values', () => {
    expect(withinBudget(99, 100)).toBe(true);
    expect(withinBudget(100, 100)).toBe(true);
    expect(withinBudget(101, 100)).toBe(false);
    expect(withinBudget(Number.NaN, 100)).toBe(false);
  });

  it('clamps and computes bounded page counts', () => {
    expect(clampInt(5.9, 1, 10)).toBe(5);
    expect(clampInt(-1, 1, 10)).toBe(1);
    expect(clampInt(999, 1, 10)).toBe(10);
    expect(boundedPageCount(10001, 20, PERFORMANCE_BUDGETS.audit.maxExportPages)).toBe(50);
    expect(boundedPageCount(0, 20, 50)).toBe(0);
  });

  it('assertBudget throws on budget violation', () => {
    const ok = evaluateBudget('ok', 10, 10, 'ms');
    expect(() => assertBudget(ok)).not.toThrow();
    const bad = evaluateBudget('bad', 11, 10, 'ms');
    expect(() => assertBudget(bad)).toThrow(/Performance budget exceeded/);
  });

  it('keeps chat visible slicing within render budget for representative history', () => {
    const messages = makeMessages(PERFORMANCE_BUDGETS.chat.representativeHistorySize);
    const { ms, value } = measureSyncMs(() =>
      getVisibleMessages(messages, PERFORMANCE_BUDGETS.chat.maxVisibleMessages),
    );
    expect(value).toHaveLength(PERFORMANCE_BUDGETS.chat.maxVisibleMessages);
    expect(value[0].id).toBe(`msg_${messages.length - PERFORMANCE_BUDGETS.chat.maxVisibleMessages}`);
    assertBudget(evaluateBudget('chat.visibleSlice', ms, PERFORMANCE_BUDGETS.chat.maxRenderMs, 'ms'));
  });

  it('bounds chat pagination growth to max visible messages', () => {
    const total = PERFORMANCE_BUDGETS.chat.representativeHistorySize;
    let visible = PERFORMANCE_BUDGETS.chat.pageSize;
    let steps = 0;
    while (visible < total && steps < 10000) {
      const next = getNextMessageCount(total, visible, PERFORMANCE_BUDGETS.chat.pageSize);
      expect(next).toBeGreaterThan(visible);
      visible = Math.min(next, PERFORMANCE_BUDGETS.chat.maxVisibleMessages);
      steps++;
      if (visible >= PERFORMANCE_BUDGETS.chat.maxVisibleMessages) break;
    }
    expect(visible).toBeLessThanOrEqual(PERFORMANCE_BUDGETS.chat.maxVisibleMessages);
    expect(steps).toBeLessThanOrEqual(
      Math.ceil(PERFORMANCE_BUDGETS.chat.maxVisibleMessages / PERFORMANCE_BUDGETS.chat.pageSize),
    );
  });

  it('bounds audit export request count and row count for representative dataset', () => {
    const total = PERFORMANCE_BUDGETS.audit.representativeDatasetSize;
    const pageSize = PERFORMANCE_BUDGETS.audit.pageSize;
    const maxPages = PERFORMANCE_BUDGETS.audit.maxExportPages;
    const pages = boundedPageCount(total, pageSize, maxPages);
    const maxRows = pages * pageSize;
    assertBudget(evaluateBudget('audit.exportRequests', pages, PERFORMANCE_BUDGETS.audit.maxExportRequestCount, 'count'));
    expect(maxRows).toBeLessThanOrEqual(PERFORMANCE_BUDGETS.audit.maxExportRows);
  });
});
