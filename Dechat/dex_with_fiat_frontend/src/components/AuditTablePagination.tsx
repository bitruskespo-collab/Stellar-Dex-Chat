'use client';

import React from 'react';

/**
 * Server-Backed Filtering and Pagination Controls for Audit Views
 * Addresses Issue #95: Keep payout/audit tables usable at production volume
 * without downloading all records to the browser.
 */

export interface AuditPaginationCursor {
  nextCursor: string | null;
  prevCursor: string | null;
  pageSize: number;
  totalCount?: number;
}

export interface AuditFilterParams {
  status?: string;
  currency?: string;
  startDate?: string;
  endDate?: string;
}

interface AuditTablePaginationProps {
  cursor: AuditPaginationCursor;
  filters: AuditFilterParams;
  isLoading: boolean;
  onPageChange: (cursor: string | null, direction: 'next' | 'prev') => void;
  onFilterChange: (filters: AuditFilterParams) => void;
  onPageSizeChange: (size: number) => void;
}

export const AuditTablePagination: React.FC<AuditTablePaginationProps> = ({
  cursor,
  filters,
  isLoading,
  onPageChange,
  onFilterChange,
  onPageSizeChange,
}) => {
  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-4 px-2 border-t border-gray-200 dark:border-gray-800 text-sm">
      {/* Filters (kept out of public query params for privacy) */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Status:</label>
        <select
          value={filters.status || 'ALL'}
          onChange={(e) => onFilterChange({ ...filters, status: e.target.value === 'ALL' ? undefined : e.target.value })}
          className="px-2 py-1 bg-white dark:bg-gray-800 border rounded text-xs"
        >
          <option value="ALL">All Statuses</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="FAILED">Failed</option>
          <option value="DISPUTED">Disputed</option>
        </select>

        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Page Size:</label>
        <select
          value={cursor.pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="px-2 py-1 bg-white dark:bg-gray-800 border rounded text-xs"
        >
          <option value="10">10</option>
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </div>

      {/* Cursor Pagination Navigation */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!cursor.prevCursor || isLoading}
          onClick={() => onPageChange(cursor.prevCursor, 'prev')}
          className="px-3 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 rounded text-xs font-medium"
        >
          Previous
        </button>
        <span className="text-xs text-muted-foreground px-2">
          {isLoading ? 'Loading records...' : 'Cursor Page'}
        </span>
        <button
          type="button"
          disabled={!cursor.nextCursor || isLoading}
          onClick={() => onPageChange(cursor.nextCursor, 'next')}
          className="px-3 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 rounded text-xs font-medium"
        >
          Next
        </button>
      </div>
    </div>
  );
};
