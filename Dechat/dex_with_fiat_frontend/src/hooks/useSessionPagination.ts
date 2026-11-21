import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { DEFAULT_PAGE_SIZE } from '@/lib/chatPaginationUtils';

function dispatchSessionPaginationTelemetry(event: string, detail?: Record<string, unknown>) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('session_pagination_telemetry', { detail: { event, ...detail } }),
    );
  }
}

/**
 * Generic list pagination hook following the same virtualisation pattern
 * used by `useChatPagination` but for arbitrary item lists (sessions).
 */
export const useSessionPagination = <T,>(allItems: T[], pageSize: number = DEFAULT_PAGE_SIZE, maxVisible: number = 200) => {
  const boundedInitial = Math.min(pageSize, maxVisible);
  const [visibleCount, setVisibleCount] = useState(boundedInitial);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const cap = Math.min(maxVisible, allItems.length);
    setVisibleCount((prev) => {
      if (allItems.length <= pageSize) return Math.min(pageSize, maxVisible);
      return Math.min(Math.max(prev, pageSize), cap);
    });
  }, [allItems.length, pageSize, maxVisible]);

  useEffect(() => {
    dispatchSessionPaginationTelemetry('session_pagination_initialized', {
      pageSize,
      totalItems: allItems.length,
      visibleCount,
    });
  }, [allItems.length, pageSize, visibleCount]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const visibleItems = useMemo(() => {
    if (!allItems || allItems.length === 0) return [] as T[];
    return allItems.slice(-visibleCount);
  }, [allItems, visibleCount]);

  const hasMore = useMemo(() => {
    return visibleCount < Math.min(allItems.length, maxVisible);
  }, [allItems.length, visibleCount, maxVisible]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoadingMore) return;
    setIsLoadingMore(true);

    // small delay for smoother UX, mirrors useChatPagination
    timeoutRef.current = setTimeout(() => {
      setVisibleCount((prev: number) => {
        const next = Math.min(prev + pageSize, allItems.length, maxVisible);
        dispatchSessionPaginationTelemetry('session_pagination_loaded_more', {
          previousVisibleCount: prev,
          nextVisibleCount: next,
          pageSize,
          totalItems: allItems.length,
        });
        return next;
      });
      setIsLoadingMore(false);
    }, 300);
  }, [hasMore, isLoadingMore, allItems.length, pageSize]);

  return {
    visibleItems,
    hasMore,
    isLoadingMore,
    loadMore,
    setVisibleCount,
  } as const;
};
