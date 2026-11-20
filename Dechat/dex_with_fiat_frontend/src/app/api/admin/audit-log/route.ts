import {
  AdminAuditActionType,
  AdminAuditLogEntry,
  AdminAuditResult,
} from '../../../../types';
import { requireAdminAuth } from '../_utils/requireAdminAuth';

const ACTIONS: AdminAuditActionType[] = [
  'withdrawal_approved',
  'withdrawal_rejected',
  'reconciliation_adjustment',
  'operator_added',
  'operator_removed',
  'bridge_paused',
  'bridge_unpaused',
];

const RESULT_BY_ACTION: Record<AdminAuditActionType, AdminAuditResult> = {
  withdrawal_approved: 'success',
  withdrawal_rejected: 'failed',
  reconciliation_adjustment: 'success',
  operator_added: 'success',
  operator_removed: 'success',
  bridge_paused: 'pending',
  bridge_unpaused: 'success',
};

const mockAuditLogData: AdminAuditLogEntry[] = Array.from(
  { length: 58 },
  (_, index) => {
    const action = ACTIONS[index % ACTIONS.length];
    const timestamp = new Date(
      Date.UTC(2026, 2, 29, 19, 0, 0) - index * 16 * 60 * 1000,
    ).toISOString();

    return {
      id: `audit_${String(index + 1).padStart(4, '0')}`,
      timestamp,
      action,
      adminAddress: `GADMIN${String((index % 9) + 1).padStart(2, '0')}...${String((index % 97) + 11).padStart(2, '0')}`,
      parameters: {
        amountXlm: Number((12 + (index % 13) * 2.5).toFixed(2)),
        requestId: `REQ-${20260300 + index + 1}`,
        target: `GBENEFICIARY${String((index % 14) + 1).padStart(2, '0')}...`,
        dryRun: index % 6 === 0,
      },
      result: RESULT_BY_ACTION[action],
    };
  },
);

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Retention horizon: entries older than this are moved to the archived
// partition. The boundary is inclusive of the cutoff instant in the hot
// partition so a single entry never appears in both partitions.
const HOT_RETENTION_DAYS = 90;
const ARCHIVE_PARTITION = 'audit_log_archive';
const HOT_PARTITION = 'audit_log_hot';

// Deterministic archive manifest describing the retained evidence. Operators
// use this to verify that archived audit evidence is still available and to
// reconcile partition boundaries against the retention policy.
const archiveManifest = {
  hotPartition: HOT_PARTITION,
  archivePartition: ARCHIVE_PARTITION,
  retentionDays: HOT_RETENTION_DAYS,
  // Cutoff is computed from the newest entry so the mock stays deterministic.
  cutoff: new Date(
    Date.UTC(2026, 2, 29, 19, 0, 0) - HOT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString(),
  appendOnly: true,
  partitions: [
    { name: HOT_PARTITION, horizon: 'hot', immutable: false },
    { name: ARCHIVE_PARTITION, horizon: 'archive', immutable: true },
  ],
};

function partitionForTimestamp(timestamp: string): string {
  return timestamp >= archiveManifest.cutoff ? HOT_PARTITION : ARCHIVE_PARTITION;
}

function parsePageSize(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(parsed), MAX_PAGE_SIZE);
}

export async function GET(request: Request) {
  try {
    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    const { searchParams } = new URL(request.url);
    const actionFilter = searchParams.get('action') || 'all';
    const partitionFilter = searchParams.get('partition') || 'all';
    const page = Math.max(Number(searchParams.get('page') || 1), 1);
    const pageSize = parsePageSize(searchParams.get('pageSize'));

    if (
      partitionFilter !== 'all' &&
      partitionFilter !== HOT_PARTITION &&
      partitionFilter !== ARCHIVE_PARTITION
    ) {
      return Response.json(
        {
          error: `Unknown partition "${partitionFilter}"`,
          partitions: [HOT_PARTITION, ARCHIVE_PARTITION],
        },
        { status: 400 },
      );
    }

    // Entries are ordered newest-first across both partitions, so a stable
    // page index maps to the same slice regardless of which partition an
    // entry lives in. This preserves cursor semantics for existing clients.
    const filteredEntries = mockAuditLogData.filter((entry) => {
      if (actionFilter !== 'all' && entry.action !== actionFilter) {
        return false;
      }
      if (
        partitionFilter !== 'all' &&
        partitionForTimestamp(entry.timestamp) !== partitionFilter
      ) {
        return false;
      }
      return true;
    });

    const total = filteredEntries.length;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const boundedPage = Math.min(page, totalPages);
    const startIndex = (boundedPage - 1) * pageSize;
    const pageEntries = filteredEntries.slice(startIndex, startIndex + pageSize);

    const entries = pageEntries.map((entry) => ({
      ...entry,
      partition: partitionForTimestamp(entry.timestamp),
    }));

    const hasNextPage = boundedPage < totalPages;
    const hasPreviousPage = boundedPage > 1;

    return Response.json({
      entries,
      page: boundedPage,
      pageSize,
      total,
      totalPages,
      actions: ACTIONS,
      partitions: [HOT_PARTITION, ARCHIVE_PARTITION],
      archiveManifest,
      // Opaque cursor for the next page; null when the last page is reached.
      nextCursor: hasNextPage ? String(boundedPage + 1) : null,
      previousCursor: hasPreviousPage ? String(boundedPage - 1) : null,
    });
  } catch (error) {
    console.error('Error fetching audit logs:', error);
    return Response.json(
      { error: 'Failed to fetch admin audit logs' },
      { status: 500 },
    );
  }
}

// The audit trail is append-only: entries are never deleted or cleared through
// the API (#1484). DELETE is rejected so a compromised or careless admin session
// cannot wipe the history it is meant to record. This applies to both the hot
// and archived partitions (#248): archival moves evidence between partitions
// but never removes it.
export async function DELETE(request: Request) {
  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  return Response.json(
    {
      error: 'The admin audit log is append-only and cannot be cleared',
      partitions: [HOT_PARTITION, ARCHIVE_PARTITION],
    },
    { status: 405, headers: { Allow: 'GET' } },
  );
}
