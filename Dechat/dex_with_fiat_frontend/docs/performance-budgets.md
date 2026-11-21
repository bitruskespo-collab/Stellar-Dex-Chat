# Performance Budgets (Admin Audit + Chat History)

Issue #275 enforces bounded render time, request count, and memory use for representative large datasets.

## Budgets

Defined in `src/lib/performanceBudgets.ts`:

- **Audit table**
  - Page size: 20 rows rendered/requested.
  - Export: max 50 requests/pages, max 10,000 rows, paginated by `limit=20`.
  - Representative dataset: 10,000 rows.
- **Payout audit API/export**
  - API page limit: 100.
  - CSV export: bounded by `maxRows` (default 10,000, hard cap 10,000), paginated internally.
- **Chat history**
  - Default page: 20 messages.
  - Visible render window cap: 200 messages (`MAX_VISIBLE_MESSAGES`) to bound DOM/memory.
  - Session pagination: capped visible window (default 200).
  - Representative history: 5,000 messages; slice/render budget asserted in tests.

## Enforcement points

- `src/hooks/useChatPagination.ts` / `src/lib/chatPaginationUtils.ts` - caps visible message window.
- `src/hooks/useSessionPagination.ts` - caps visible session window.
- `src/components/AuditTable.tsx` - paginated bounded export (no 10k single request).
- `src/app/admin/page.tsx` - bounded admin audit CSV export requests/rows.
- `src/lib/payout/auditLedger.ts` / `src/app/api/admin/payout-audit/route.ts` - bounded CSV export.

## Tests

- `src/lib/performanceBudgets.test.ts` - budget evaluation, representative chat slice, bounded export request counts.
- Existing pagination/audit tests cover normal paths; failures/boundaries covered by budget tests.

## Operational notes

- Exports are intentionally bounded; for larger datasets, use filtered exports or backend streaming/job export (future work).
- No credentials or real user data in fixtures; synthetic fixtures remain subject to `pnpm test:fixtures:privacy`.
