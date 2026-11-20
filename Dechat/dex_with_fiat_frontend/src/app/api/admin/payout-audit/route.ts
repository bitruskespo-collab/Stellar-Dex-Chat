import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { payoutAuditLedger, PayoutAuditAction } from '@/lib/payout/auditLedger';
import {
  ADMIN_PAYOUT_AUDIT_CORS_POLICY,
  enforceCorsPolicy,
} from '@/lib/security/corsPolicy';

export async function GET(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

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

    const filter = {
      payoutId,
      action,
      actor,
      providerReference,
      startDate,
      endDate,
    };

    if (format === 'csv') {
      const csvData = payoutAuditLedger.exportCsv(filter);
      return new NextResponse(csvData, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="payout-audit-ledger.csv"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    const page = Math.max(Number(searchParams.get('page') || 1), 1);
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit') || 20), 1),
      100,
    );

    const result = payoutAuditLedger.getEntries(filter, { page, limit });

    return NextResponse.json(result, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    });
  } catch (err: unknown) {
    console.error('Error in /api/admin/payout-audit:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve payout audit records' },
      { status: 500 },
    );
  }
}

// Append-only enforcement: Prevent mutating or deleting audit history
export async function POST(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PUT(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function DELETE(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PATCH(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}
