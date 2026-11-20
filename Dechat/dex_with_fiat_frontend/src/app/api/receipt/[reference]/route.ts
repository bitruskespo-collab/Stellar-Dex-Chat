import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeTransferAccess,
  uniformReceiptNotFoundResponse,
} from '@/lib/auth/authorizationMatrix';

/**
 * Read-model freshness metadata.
 *
 * `dbUpdatedAt` is the database update time of the underlying record and
 * `sourceLedgerCursor` is the indexer cursor that produced the projection.
 * Consumers must treat a projection as potentially stale until the cursor
 * has caught up with the ledger; it must not be presented as confirmed
 * settlement state on its own.
 */
export interface ReadModelFreshness {
  dbUpdatedAt: string;
  sourceLedgerCursor: string | null;
}

/**
 * Persisted calculation lineage for FX and settlement amounts.
 *
 * Allows an auditor to recompute every displayed and paid amount by
 * replaying the calculation version against the recorded input source IDs,
 * currency metadata version and rounding decisions.
 */
export interface CalculationLineage {
  calculationVersion: string;
  inputSourceIds: string[];
  currencyMetadataVersion: string;
  roundingDecisions: Array<{
    field: string;
    mode: string;
    scale: number;
    inputValue: string;
    outputValue: string;
  }>;
  computedAt: string;
}

interface ReceiptRecord {
  reference: string;
  amount: number | string;
  status: string;
  updatedAt: string;
  sourceLedgerCursor?: string | null;
  calculationLineage?: CalculationLineage | null;
}

function buildFreshness(record: ReceiptRecord): ReadModelFreshness {
  return {
    dbUpdatedAt: record.updatedAt,
    sourceLedgerCursor: record.sourceLedgerCursor ?? null,
  };
}

function buildLineage(record: ReceiptRecord): CalculationLineage | null {
  const lineage = record.calculationLineage;
  if (!lineage) {
    return null;
  }
  return {
    calculationVersion: lineage.calculationVersion,
    inputSourceIds: Array.isArray(lineage.inputSourceIds)
      ? [...lineage.inputSourceIds]
      : [],
    currencyMetadataVersion: lineage.currencyMetadataVersion,
    roundingDecisions: Array.isArray(lineage.roundingDecisions)
      ? lineage.roundingDecisions.map((decision) => ({ ...decision }))
      : [],
    computedAt: lineage.computedAt,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ reference: string }> },
) {
  try {
    const p = await params;
    const { reference } = p;

    if (!reference) {
      return NextResponse.json(
        { success: false, message: 'Reference is required' },
        { status: 400 },
      );
    }

    // IDOR check: Authorize caller before returning sensitive receipt data.
    // Denials return uniform 404 to avoid leaking record existence.
    const auth = authorizeTransferAccess(request, reference);
    if (!auth.authorized || !auth.record) {
      return uniformReceiptNotFoundResponse();
    }

    const record = auth.record as ReceiptRecord;
    const freshness = buildFreshness(record);
    const lineage = buildLineage(record);

    const receiptData = {
      reference: record.reference,
      amount: record.amount,
      status: record.status,
      timestamp: record.updatedAt,
      type: 'Payout',
      currency: 'NGN',
    };

    return NextResponse.json({
      success: true,
      data: receiptData,
      freshness,
      // Lineage is optional: only present when the projection persisted it.
      ...(lineage ? { lineage } : {}),
    });
  } catch (error: unknown) {
    console.error('Get receipt error:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to retrieve receipt' },
      { status: 500 },
    );
  }
}