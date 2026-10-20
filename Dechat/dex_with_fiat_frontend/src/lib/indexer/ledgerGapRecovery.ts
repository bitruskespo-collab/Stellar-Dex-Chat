/**
 * Ledger Gap Detection and Recovery Manager
 * Addresses Issue #87: Detect and repair incomplete ledger ranges rather than
 * advancing checkpoints after partial RPC failures.
 */

export interface IngestionBoundary {
  lastContiguousLedger: number;
  inProgressCursor: string | null;
  detectedGaps: Array<{ fromLedger: number; toLedger: number; reason: string }>;
  updatedAt: number;
}

export class LedgerGapRecoveryManager {
  private boundary: IngestionBoundary = {
    lastContiguousLedger: 0,
    inProgressCursor: null,
    detectedGaps: [],
    updatedAt: 0,
  };

  constructor(initialBoundary?: IngestionBoundary) {
    if (initialBoundary) {
      this.boundary = { ...initialBoundary };
    }
  }

  public getBoundary(): IngestionBoundary {
    return { ...this.boundary };
  }

  /**
   * Evaluates an ingested range for gaps against the current checkpoint.
   * Does NOT advance checkpoint if a gap is detected.
   */
  public registerIngestedRange(fromLedger: number, toLedger: number): {
    contiguous: boolean;
    gapDetected?: { fromLedger: number; toLedger: number };
  } {
    const expected = this.boundary.lastContiguousLedger + 1;

    if (fromLedger > expected) {
      // Gap detected between expected and fromLedger - 1
      const gap = {
        fromLedger: expected,
        toLedger: fromLedger - 1,
        reason: 'RPC pagination interruption or dropped ledger batch',
      };
      this.boundary.detectedGaps.push(gap);
      this.boundary.updatedAt = Date.now();
      return { contiguous: false, gapDetected: gap };
    }

    // Contiguous progression
    if (toLedger >= this.boundary.lastContiguousLedger) {
      this.boundary.lastContiguousLedger = toLedger;
      this.boundary.updatedAt = Date.now();
    }

    return { contiguous: true };
  }

  /**
   * Records completed repair for a detected gap.
   */
  public recordGapRepaired(fromLedger: number, toLedger: number): void {
    this.boundary.detectedGaps = this.boundary.detectedGaps.filter(
      (g) => !(g.fromLedger === fromLedger && g.toLedger === toLedger)
    );
    this.boundary.updatedAt = Date.now();
  }
}
