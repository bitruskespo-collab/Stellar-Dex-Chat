import fs from 'fs';
import path from 'path';

export type PayoutEvidenceSource =
  | 'signed_webhook'
  | 'provider_poll'
  | 'imported_statement';

export type PayoutEvidenceStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export interface PayoutEvidence {
  source: PayoutEvidenceSource;
  status: PayoutEvidenceStatus;
  observedAt: string;
  reference: string;
  evidenceId: string;
  signatureVerified?: boolean;
  amountMinor?: string;
  currency?: string;
  payload?: Record<string, unknown>;
}

export interface PayoutEvidenceConflictRecord {
  id: string;
  payoutReference: string;
  effectiveStatus: PayoutEvidenceStatus;
  precedenceSource: PayoutEvidenceSource;
  evidence: PayoutEvidence[];
  conflict: true;
  reason: string;
  recordedAt: string;
}

export interface PayoutEvidenceResolution {
  payoutReference: string;
  effectiveStatus: PayoutEvidenceStatus;
  precedenceSource: PayoutEvidenceSource;
  conflict: boolean;
  evidence: PayoutEvidence[];
  conflictId?: string;
  reason: string;
}

export const PAYOUT_EVIDENCE_PRECEDENCE: readonly PayoutEvidenceSource[] = [
  'signed_webhook',
  'provider_poll',
  'imported_statement',
];

function sourceRank(source: PayoutEvidenceSource): number {
  return PAYOUT_EVIDENCE_PRECEDENCE.indexOf(source);
}

export class PayoutEvidenceConflictResolver {
  private conflicts: PayoutEvidenceConflictRecord[] = [];
  private storageFilePath: string | null = null;

  constructor(storageDir?: string) {
    if (storageDir) this.initStorage(storageDir);
  }

  public initStorage(storageDir: string): void {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      this.storageFilePath = path.join(
        storageDir,
        'payout_evidence_conflicts.jsonl',
      );
      if (fs.existsSync(this.storageFilePath)) {
        this.conflicts = fs
          .readFileSync(this.storageFilePath, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as PayoutEvidenceConflictRecord);
      }
    } catch (error) {
      console.warn('Failed to initialize payout evidence conflict storage:', error);
    }
  }

  resolve(params: {
    payoutReference: string;
    evidence: PayoutEvidence[];
  }): PayoutEvidenceResolution {
    const normalized = params.evidence.map((item) => ({
      ...item,
      reference: item.reference || params.payoutReference,
    }));

    const unverifiedSigned = normalized.find(
      (item) =>
        item.source === 'signed_webhook' &&
        item.signatureVerified !== true,
    );
    if (unverifiedSigned) {
      throw new Error('Unverified signed webhook evidence is not admissible');
    }

    const signed = normalized;

    const ordered = [...signed].sort((a, b) => {
      const rankDifference = sourceRank(a.source) - sourceRank(b.source);
      if (rankDifference !== 0) return rankDifference;
      return (
        Date.parse(b.observedAt || '1970-01-01') -
        Date.parse(a.observedAt || '1970-01-01')
      );
    });

    const winner = ordered[0];
    const conflictingEvidence = signed.filter(
      (item) => item.status !== winner.status,
    );
    const conflict = conflictingEvidence.length > 0;

    if (!conflict) {
      return {
        payoutReference: params.payoutReference,
        effectiveStatus: winner.status,
        precedenceSource: winner.source,
        conflict: false,
        evidence: signed,
        reason: 'All available evidence agrees',
      };
    }

    const conflictRecord: PayoutEvidenceConflictRecord = {
      id: `evc_${Date.now()}_${params.payoutReference}`,
      payoutReference: params.payoutReference,
      effectiveStatus: winner.status,
      precedenceSource: winner.source,
      evidence: signed,
      conflict: true,
      reason: `Evidence conflicts; ${winner.source} takes precedence`,
      recordedAt: new Date().toISOString(),
    };

    this.conflicts.push(conflictRecord);
    if (this.storageFilePath) {
      fs.appendFileSync(
        this.storageFilePath,
        `${JSON.stringify(conflictRecord)}\n`,
        'utf8',
      );
    }

    return {
      payoutReference: params.payoutReference,
      effectiveStatus: winner.status,
      precedenceSource: winner.source,
      conflict: true,
      evidence: signed,
      conflictId: conflictRecord.id,
      reason: conflictRecord.reason,
    };
  }

  getConflicts(payoutReference?: string): PayoutEvidenceConflictRecord[] {
    if (!payoutReference) return [...this.conflicts];
    return this.conflicts.filter(
      (record) => record.payoutReference === payoutReference,
    );
  }

  resetForTest(): void {
    this.conflicts = [];
  }
}

export const payoutEvidenceConflictResolver =
  new PayoutEvidenceConflictResolver(
    process.env.PAYOUT_DATA_DIR ? process.env.PAYOUT_DATA_DIR : undefined,
  );

export function resolvePayoutEvidence(params: {
  payoutReference: string;
  evidence: PayoutEvidence[];
}): PayoutEvidenceResolution {
  return payoutEvidenceConflictResolver.resolve(params);
}
