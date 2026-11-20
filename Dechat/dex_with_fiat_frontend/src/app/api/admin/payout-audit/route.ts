import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { payoutAuditLedger, PayoutAuditAction } from '@/lib/payout/auditLedger';
import {
  payoutAuditArchive,
  PayoutAuditArchiveManifest,
} from '@/lib/payout/auditArchive';

export async function GET(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const format = searchParams.get('format') || 'json';
    const payoutId = searchParams.get('payoutId') || undefined;
    const action =
      (searchParams.get('action') as PayoutAuditAction) || undefined;
    const actor = searchParams.get('actor') || undefined;
    const providerReference =
      searchParams.get('providerReference') || undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    // Optional: restrict the query to a single retention partition
    // ('hot' | 'archive'). Omitted means query across both partitions.
    const partitionParam = searchParams.get('partition');
    const partition =
      partitionParam === 'hot' || partitionParam === 'archive'
        ? partitionParam
        : undefined;

    const filter = {
      payoutId,
      action,
      actor,
      providerReference,
      startDate,
      endDate,
    };

    const manifest: PayoutAuditArchiveManifest =
      payoutAuditArchive.getManifest();

    if (format === 'csv') {
      const csvData = payoutAuditLedger.exportCsv(filter, { partition });
      return new NextResponse(csvData, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="payout-audit-ledger.csv"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Audit-Archive-Version': manifest.version,
          'X-Audit-Archive-Hot-Count': String(manifest.hotCount),
          'X-Audit-Archive-Archived-Count': String(manifest.archivedCount),
        },
      });
    }

    const page = Math.max(Number(searchParams.get('page') || 1), 1);
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit') || 20), 1),
      100,
    );

    // Pagination is computed over the merged hot+archive view so cursors stay
    // stable across the archival boundary. The manifest version is surfaced so
    // clients can detect when a new archival run has shifted the boundary.
    const result = payoutAuditLedger.getEntries(filter, {
      page,
      limit,
      partition,
    });

    return NextResponse.json(
      { ...result, archiveManifest: manifest },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Audit-Archive-Version': manifest.version,
        },
      },
    );
  } catch (err: unknown) {
    console.error('Error in /api/admin/payout-audit:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve payout audit records' },
      { status: 500 },
    );
  }
}

// Append-only enforcement: Prevent mutating or deleting audit history
export async function POST() {
  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PUT() {
  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function DELETE() {
  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PATCH() {
  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}
