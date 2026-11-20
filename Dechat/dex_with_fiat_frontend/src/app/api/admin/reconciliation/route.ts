import { NextRequest, NextResponse } from 'next/server';
import { ReconciliationRecord } from '@/types';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceAdminIpAllowlist } from '@/lib/security';
import { reconcileStalePayouts } from '@/lib/payout/reconciliation';

/**
 * Reconciliation SLO metadata attached to each admin record (Issue #241).
 * Provides operators with age, amount at risk, next action, source evidence
 * and a runbook link for unresolved payouts.
 */
export interface ReconciliationSloFields {
  ageSeconds: number | null;
  amountAtRisk: string;
  nextAction: string;
  sourceEvidence: string;
  runbookUrl: string;
}

export type ReconciliationRecordWithSlo = ReconciliationRecord &
  ReconciliationSloFields;

export interface ReconciliationTotals {
  matched: number;
  unmatchedDeposits: number;
  unmatchedPayouts: number;
  amountMismatched: number;
  duplicated: number;
  totalRecords: number;
  unresolved: number;
  amountAtRiskTotal: string;
  dbVerified: boolean;
  mismatch: boolean;
  verification?: ReconciliationVerification;
}

export interface ReconciliationVerification {
  expected: {
    matched: number;
    unmatchedDeposits: number;
    unmatchedPayouts: number;
    amountMismatched: number;
    duplicated: number;
    totalRecords: number;
  };
  actual: {
    matched: number;
    unmatchedDeposits: number;
    unmatchedPayouts: number;
    amountMismatched: number;
    duplicated: number;
    totalRecords: number;
  };
  mismatch: boolean;
}

const RUNBOOK_BASE_URL =
  process.env.RECONCILIATION_RUNBOOK_BASE_URL ||
  'https://docs.dechat.example/runbooks/reconciliation';

const SLO_UNRESOLVED_AGE_SECONDS = Number(
  process.env.RECONCILIATION_SLO_UNRESOLVED_AGE_SECONDS || 3600,
);

function runbookUrl(anchor: string): string {
  return `${RUNBOOK_BASE_URL.replace(/\/$/, '')}#${anchor}`;
}

function computeAgeSeconds(timestamp: string | undefined | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  const ageSeconds = Math.floor((Date.now() - parsed) / 1000);
  return ageSeconds < 0 ? 0 : ageSeconds;
}

function nextActionForStatus(
  status: ReconciliationRecord['status'],
  hasDeposit: boolean,
  hasPayout: boolean,
): { nextAction: string; anchor: string } {
  if (status === 'matched') {
    return { nextAction: 'none', anchor: 'matched' };
  }
  if (status === 'error') {
    return {
      nextAction: 'investigate-amount-mismatch',
      anchor: 'amount-mismatch',
    };
  }
  if (hasDeposit && !hasPayout) {
    return { nextAction: 'investigate-missing-payout', anchor: 'missing-payout' };
  }
  if (!hasDeposit && hasPayout) {
    return {
      nextAction: 'investigate-missing-deposit',
      anchor: 'missing-deposit',
    };
  }
  return { nextAction: 'investigate-unmatched', anchor: 'unmatched' };
}

function attachSlo(
  record: ReconciliationRecord,
  amountAtRisk: string,
): ReconciliationRecordWithSlo {
  const hasDeposit = Boolean(record.depositTxHash);
  const hasPayout = Boolean(record.payoutId);
  const { nextAction, anchor } = nextActionForStatus(
    record.status,
    hasDeposit,
    hasPayout,
  );
  const ageSeconds = computeAgeSeconds(
    record.payoutDate || record.depositDate || null,
  );
  const sourceEvidence = [
    record.depositTxHash ? `deposit:${record.depositTxHash}` : null,
    record.payoutId ? `payout:${record.payoutId}` : null,
  ]
    .filter(Boolean)
    .join('|');

  return {
    ...record,
    ageSeconds,
    amountAtRisk,
    nextAction,
    sourceEvidence,
    runbookUrl: runbookUrl(anchor),
  };
}

function toMinorUnits(amount: string): number {
  if (!amount) return 0;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function fromMinorUnitsSafe(minor: number): string {
  return (minor / 100).toFixed(2);
}

function isUnresolved(record: ReconciliationRecord): boolean {
  return record.status !== 'matched';
}

function isPastSlo(record: ReconciliationRecordWithSlo): boolean {
  return (
    isUnresolved(record) &&
    record.ageSeconds !== null &&
    record.ageSeconds > SLO_UNRESOLVED_AGE_SECONDS
  );
}

function buildVerification(
  report: ReturnType<typeof reconcileRecords>,
  records: ReconciliationRecordWithSlo[],
): ReconciliationVerification {
  const expected = {
    matched: report.matched.length,
    unmatchedDeposits: report.unmatched.depositsWithoutPayout.length,
    unmatchedPayouts: report.unmatched.payoutsWithoutDeposit.length,
    amountMismatched: report.amountMismatched.length,
    duplicated: report.duplicated.length,
    totalRecords: records.length,
  };
  const actual = {
    matched: records.filter((r) => r.status === 'matched').length,
    unmatchedDeposits: records.filter(
      (r) => r.status === 'unmatched' && r.depositTxHash && !r.payoutId,
    ).length,
    unmatchedPayouts: records.filter(
      (r) => r.status === 'unmatched' && !r.depositTxHash && r.payoutId,
    ).length,
    amountMismatched: records.filter(
      (r) => r.status === 'error' && r.depositTxHash && r.payoutId,
    ).length,
    duplicated: report.duplicated.length,
    totalRecords: records.length,
  };
  const mismatch =
    expected.matched !== actual.matched ||
    expected.unmatchedDeposits !== actual.unmatchedDeposits ||
    expected.unmatchedPayouts !== actual.unmatchedPayouts ||
    expected.amountMismatched !== actual.amountMismatched ||
    expected.totalRecords !== actual.totalRecords;
  return { expected, actual, mismatch };
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

    // If caller requests structured report format
    const format = request.nextUrl.searchParams.get('format');
    if (format === 'report') {
      return NextResponse.json(serializeReconciliationReport(report));
    }

    // Default: map report to standard ReconciliationRecord[] for dashboard view
    const records: ReconciliationRecordWithSlo[] = [];
    let counter = 1;

    for (const m of report.matched) {
      records.push(
        attachSlo(
          {
            id: String(counter++),
            depositTxHash: m.deposit.txHash,
            depositAmount: fromMinorUnits(
              m.deposit.amountMinor,
              m.deposit.currency,
            ),
            depositUser: m.deposit.wallet,
            depositDate: m.deposit.timestamp,
            payoutId: m.payout.payoutId,
            payoutAmount: fromMinorUnits(
              m.payout.amountMinor,
              m.payout.currency,
            ),
            payoutRecipient: m.payout.recipient,
            payoutStatus: m.payout.payoutStatus,
            payoutDate: m.payout.payoutDate,
            status: 'matched',
          },
          '0.00',
        ),
      );
    }

    for (const d of report.unmatched.depositsWithoutPayout) {
      const amount = fromMinorUnits(d.amountMinor, d.currency);
      records.push(
        attachSlo(
          {
            id: String(counter++),
            depositTxHash: d.txHash,
            depositAmount: amount,
            depositUser: d.wallet,
            depositDate: d.timestamp,
            payoutId: '',
            payoutAmount: '',
            payoutRecipient: '',
            payoutStatus: 'pending',
            payoutDate: '',
            status: 'unmatched',
          },
          amount,
        ),
      );
    }

    for (const p of report.unmatched.payoutsWithoutDeposit) {
      const amount = fromMinorUnits(p.amountMinor, p.currency);
      records.push(
        attachSlo(
          {
            id: String(counter++),
            depositTxHash: '',
            depositAmount: '',
            depositUser: '',
            depositDate: '',
            payoutId: p.payoutId,
            payoutAmount: amount,
            payoutRecipient: p.recipient,
            payoutStatus: p.payoutStatus,
            payoutDate: p.payoutDate,
            status: 'unmatched',
          },
          amount,
        ),
      );
    }

    for (const mm of report.amountMismatched) {
      const depositMinor = mm.deposit.amountMinor;
      const payoutMinor = mm.payout.amountMinor;
      const atRiskMinor = Math.abs(depositMinor - payoutMinor);
      records.push(
        attachSlo(
          {
            id: String(counter++),
            depositTxHash: mm.deposit.txHash,
            depositAmount: fromMinorUnits(
              mm.deposit.amountMinor,
              mm.deposit.currency,
            ),
            depositUser: mm.deposit.wallet,
            depositDate: mm.deposit.timestamp,
            payoutId: mm.payout.payoutId,
            payoutAmount: fromMinorUnits(
              mm.payout.amountMinor,
              mm.payout.currency,
            ),
            payoutRecipient: mm.payout.recipient,
            payoutStatus: mm.payout.payoutStatus,
            payoutDate: mm.payout.payoutDate,
            status: 'error',
          },
          fromMinorUnitsSafe(atRiskMinor),
        ),
      );
    }

    for (const dup of report.duplicated) {
      for (const d of dup.deposits) {
        const amount = fromMinorUnits(d.amountMinor, d.currency);
        records.push(
          attachSlo(
            {
              id: String(counter++),
              depositTxHash: d.txHash,
              depositAmount: amount,
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
            },
            amount,
          ),
        );
      }
    }

    const verification = buildVerification(report, records);
    const amountAtRiskMinor = records.reduce(
      (sum, r) => sum + toMinorUnits(r.amountAtRisk),
      0,
    );
    const totals: ReconciliationTotals = {
      matched: verification.actual.matched,
      unmatchedDeposits: verification.actual.unmatchedDeposits,
      unmatchedPayouts: verification.actual.unmatchedPayouts,
      amountMismatched: verification.actual.amountMismatched,
      duplicated: verification.actual.duplicated,
      totalRecords: records.length,
      unresolved: records.filter(isUnresolved).length,
      amountAtRiskTotal: fromMinorUnitsSafe(amountAtRiskMinor),
      dbVerified: !verification.mismatch,
      mismatch: verification.mismatch,
    };

    const includeVerification =
      request.nextUrl.searchParams.get('includeVerification') === 'true';
    if (includeVerification) {
      totals.verification = verification;
    }

    return NextResponse.json({
      records,
      totals,
      slo: {
        unresolvedAgeSeconds: SLO_UNRESOLVED_AGE_SECONDS,
        breached: records.filter(isPastSlo).length,
      },
    });
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

    return NextResponse.json({
      success: true,
      data: summary,
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
