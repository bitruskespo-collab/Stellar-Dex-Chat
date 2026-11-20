import { NextRequest, NextResponse } from 'next/server';
import { ReconciliationRecord } from '@/types';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceAdminIpAllowlist } from '@/lib/security';
import { reconcileStalePayouts } from '@/lib/payout/reconciliation';
import {
  reconcileCrossSource,
  type CrossSourceReconciliationResult,
  type ReconciliationConfidence,
} from '@/lib/payout/crossSourceReconciliation';

const CONFIDENCE_STATES: ReconciliationConfidence[] = [
  'matched',
  'ambiguous',
  'unmatched',
  'conflict',
];

function countByConfidence(
  result: CrossSourceReconciliationResult,
): Record<ReconciliationConfidence, number> {
  const counts: Record<ReconciliationConfidence, number> = {
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    conflict: 0,
  };
  for (const entry of result.entries) {
    counts[entry.confidence] += 1;
  }
  return counts;
}

function buildReviewQueue(result: CrossSourceReconciliationResult) {
  return result.entries
    .filter((entry) => entry.confidence !== 'matched')
    .map((entry) => ({
      id: entry.id,
      confidence: entry.confidence,
      reason: entry.reason,
      contractEventId: entry.contractEventId,
      payoutRecordId: entry.payoutRecordId,
      providerEvidenceId: entry.providerEvidenceId,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      requiresReview: true,
    }));
}

export async function GET(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    // Read-only reconciliation job by default (Issue #39)
    const deposits = reconciliationStore.getDeposits();
    const payouts = reconciliationStore.getPayouts();
    const report = reconcileRecords(deposits, payouts);

    // Cross-source reconciliation (Issue #246): contract events, internal
    // payout records, and provider evidence. Read-only; never settles.
    const crossSource = reconcileCrossSource({
      contractEvents: reconciliationStore.getContractEvents?.() ?? [],
      payoutRecords: reconciliationStore.getPayoutRecords?.() ?? [],
      providerEvidence: reconciliationStore.getProviderEvidence?.() ?? [],
    });
    const confidenceCounts = countByConfidence(crossSource);
    const reviewQueue = buildReviewQueue(crossSource);

    // If caller requests structured report format
    const format = request.nextUrl.searchParams.get('format');
    if (format === 'report') {
      return NextResponse.json({
        ...serializeReconciliationReport(report),
        crossSource: {
          confidenceCounts,
          entries: crossSource.entries,
          reviewQueue,
        },
      });
    }

    // Review queue view for non-matched records
    if (format === 'review') {
      return NextResponse.json({
        confidenceCounts,
        reviewQueue,
      });
    }
======

    // Default: map report to standard ReconciliationRecord[] for dashboard view
    const records: ReconciliationRecord[] = [];
    let counter = 1;

    for (const m of report.matched) {
      records.push({
        id: String(counter++),
        depositTxHash: m.deposit.txHash,
        depositAmount: fromMinorUnits(
          m.deposit.amountMinor,
          m.deposit.currency,
        ),
        depositUser: m.deposit.wallet,
        depositDate: m.deposit.timestamp,
        payoutId: m.payout.payoutId,
        payoutAmount: fromMinorUnits(m.payout.amountMinor, m.payout.currency),
        payoutRecipient: m.payout.recipient,
        payoutStatus: m.payout.payoutStatus,
        payoutDate: m.payout.payoutDate,
        status: 'matched',
      });
    }

    for (const d of report.unmatched.depositsWithoutPayout) {
      records.push({
        id: String(counter++),
        depositTxHash: d.txHash,
        depositAmount: fromMinorUnits(d.amountMinor, d.currency),
        depositUser: d.wallet,
        depositDate: d.timestamp,
        payoutId: '',
        payoutAmount: '',
        payoutRecipient: '',
        payoutStatus: 'pending',
        payoutDate: '',
        status: 'unmatched',
      });
    }

    for (const p of report.unmatched.payoutsWithoutDeposit) {
      records.push({
        id: String(counter++),
        depositTxHash: '',
        depositAmount: '',
        depositUser: '',
        depositDate: '',
        payoutId: p.payoutId,
        payoutAmount: fromMinorUnits(p.amountMinor, p.currency),
        payoutRecipient: p.recipient,
        payoutStatus: p.payoutStatus,
        payoutDate: p.payoutDate,
        status: 'unmatched',
      });
    }

    for (const mm of report.amountMismatched) {
      records.push({
        id: String(counter++),
        depositTxHash: mm.deposit.txHash,
        depositAmount: fromMinorUnits(
          mm.deposit.amountMinor,
          mm.deposit.currency,
        ),
        depositUser: mm.deposit.wallet,
        depositDate: mm.deposit.timestamp,
        payoutId: mm.payout.payoutId,
        payoutAmount: fromMinorUnits(mm.payout.amountMinor, mm.payout.currency),
        payoutRecipient: mm.payout.recipient,
        payoutStatus: mm.payout.payoutStatus,
        payoutDate: mm.payout.payoutDate,
        status: 'error',
      });
    }

    for (const dup of report.duplicated) {
      for (const d of dup.deposits) {
        records.push({
          id: String(counter++),
          depositTxHash: d.txHash,
          depositAmount: fromMinorUnits(d.amountMinor, d.currency),
          depositUser: d.wallet,
          depositDate: d.timestamp,
          payoutId: dup.payouts[0]?.payoutId || '',
          payoutAmount: dup.payouts[0]
            ? fromMinorUnits(
                dup.payouts[0].amountMinor,
                dup.payouts[0].currency,
              )
            : '',
          payoutRecipient: dup.payouts[0]?.recipient || '',
          payoutStatus: dup.payouts[0]?.payoutStatus || 'pending',
          payoutDate: dup.payouts[0]?.payoutDate || '',
          status: 'error',
        });
      }
    }

    // Surface cross-source confidence states. Only 'matched' entries are
    // considered settled; ambiguous/unmatched/conflict entries are flagged
    // for review and never auto-settled.
    for (const entry of crossSource.entries) {
      records.push({
        id: String(counter++),
        depositTxHash: entry.contractEventId || '',
        depositAmount:
          entry.amountMinor != null
            ? fromMinorUnits(entry.amountMinor, entry.currency)
            : '',
        depositUser: entry.depositUser || '',
        depositDate: entry.contractEventTimestamp || '',
        payoutId: entry.payoutRecordId || '',
        payoutAmount:
          entry.amountMinor != null
            ? fromMinorUnits(entry.amountMinor, entry.currency)
            : '',
        payoutRecipient: entry.payoutRecipient || '',
        payoutStatus: entry.payoutStatus || 'pending',
        payoutDate: entry.payoutDate || '',
        status:
          entry.confidence === 'matched'
            ? 'matched'
            : entry.confidence === 'conflict'
              ? 'error'
              : 'unmatched',
        confidence: entry.confidence,
        requiresReview: entry.confidence !== 'matched',
      });
    }

    return NextResponse.json(records);
  } catch (error) {
    console.error('Error fetching reconciliation data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch reconciliation data' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // Body is optional; default to empty object
    }

    const staleAgeMs =
      typeof body.staleAgeMs === 'number' ? body.staleAgeMs : undefined;
    const batchSize =
      typeof body.batchSize === 'number' ? body.batchSize : undefined;

    const summary = await reconcileStalePayouts({
      staleAgeMs,
      batchSize,
    });

    // Cross-source reconciliation pass. This is classification only: it
    // never settles ambiguous/unmatched/conflict entries. Callers must
    // review the queue before any settlement action.
    const crossSource = reconcileCrossSource({
      contractEvents: reconciliationStore.getContractEvents?.() ?? [],
      payoutRecords: reconciliationStore.getPayoutRecords?.() ?? [],
      providerEvidence: reconciliationStore.getProviderEvidence?.() ?? [],
    });
    const confidenceCounts = countByConfidence(crossSource);
    const reviewQueue = buildReviewQueue(crossSource);

    return NextResponse.json({
      success: true,
      data: summary,
      crossSource: {
        confidenceCounts,
        reviewQueue,
        autoSettled: false,
      },
    });
  } catch (error) {
    console.error('Error running reconciliation:', error);
    return NextResponse.json(
      { error: 'Failed to run payout reconciliation' },
      { status: 500 },
    );
  }
}

// Mock data - in production, this would come from a database
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockReconciliationData: ReconciliationRecord[] = [
  {
    id: '1',
    depositTxHash: '0x123abc',
    depositAmount: '100.0',
    depositUser: 'GA123...',
    depositDate: '2026-03-20T10:00:00Z',
    payoutId: 'TRF_123456',
    payoutAmount: '100.0',
    payoutRecipient: 'John Doe - 1234567890',
    payoutStatus: 'completed',
    payoutDate: '2026-03-20T11:00:00Z',
    status: 'matched',
  },
  {
    id: '2',
    depositTxHash: '0x456def',
    depositAmount: '50.0',
    depositUser: 'GA456...',
    depositDate: '2026-03-21T14:30:00Z',
    payoutId: 'TRF_789012',
    payoutAmount: '50.0',
    payoutRecipient: 'Jane Smith - 0987654321',
    payoutStatus: 'pending',
    payoutDate: '2026-03-21T15:00:00Z',
    status: 'matched',
  },
  {
    id: '3',
    depositTxHash: '0x789ghi',
    depositAmount: '25.0',
    depositUser: 'GA789...',
    depositDate: '2026-03-22T09:15:00Z',
    payoutId: '',
    payoutAmount: '',
    payoutRecipient: '',
    payoutStatus: 'pending',
    payoutDate: '',
    status: 'unmatched',
  },
  {
    id: '4',
    depositTxHash: '0xabcpqr',
    depositAmount: '75.0',
    depositUser: 'GAABC...',
    depositDate: '2026-03-23T16:45:00Z',
    payoutId: 'TRF_345678',
    payoutAmount: '70.0',
    payoutRecipient: 'Bob Wilson - 1122334455',
    payoutStatus: 'failed',
    payoutDate: '2026-03-23T17:00:00Z',
    status: 'error',
  },
];

// Re-exported for consumers that need the confidence state list.
export { CONFIDENCE_STATES };
