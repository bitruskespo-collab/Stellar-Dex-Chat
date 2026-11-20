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

/**
 * Durable storage adapter used to persist ingestion boundaries so that a
 * restarted process resumes from the last committed checkpoint instead of
 * replaying (duplicating) or skipping contract events.
 */
export interface BoundaryStorageAdapter {
  load(): IngestionBoundary | null | Promise<IngestionBoundary | null>;
  save(boundary: IngestionBoundary): void | Promise<void>;
}

const BOUNDARY_STORAGE_KEY = 'dechat.indexer.ledgerBoundary.v1';

/**
 * Default adapter backed by `localStorage` when available, otherwise an
 * in-memory fallback (useful for tests and non-browser runtimes).
 */
export class LocalStorageBoundaryAdapter implements BoundaryStorageAdapter {
  private memory: IngestionBoundary | null = null;

  constructor(private readonly key: string = BOUNDARY_STORAGE_KEY) {}

  private get storage(): Storage | null {
    try {
      if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
        return (globalThis as any).localStorage as Storage;
      }
    } catch {
      // Access to storage can throw (e.g. disabled cookies); fall back to memory.
    }
    return null;
  }

  public load(): IngestionBoundary | null {
    const storage = this.storage;
    if (!storage) return this.memory ? { ...this.memory } : null;
    try {
      const raw = storage.getItem(this.key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as IngestionBoundary;
      return {
        lastContiguousLedger: Number(parsed.lastContiguousLedger) || 0,
        inProgressCursor: parsed.inProgressCursor ?? null,
        detectedGaps: Array.isArray(parsed.detectedGaps) ? parsed.detectedGaps : [],
        updatedAt: Number(parsed.updatedAt) || 0,
      };
    } catch {
      return null;
    }
  }

  public save(boundary: IngestionBoundary): void {
    this.memory = { ...boundary };
    const storage = this.storage;
    if (!storage) return;
    try {
      storage.setItem(this.key, JSON.stringify(boundary));
    } catch {
      // Persistence failures must not corrupt in-memory state.
    }
  }
}

export class LedgerGapRecoveryManager {
  private boundary: IngestionBoundary = {
    lastContiguousLedger: 0,
    inProgressCursor: null,
    detectedGaps: [],
    updatedAt: 0,
  };

  private readonly storage?: BoundaryStorageAdapter;

  constructor(initialBoundary?: IngestionBoundary, storage?: BoundaryStorageAdapter) {
    this.storage = storage;
    if (initialBoundary) {
      this.boundary = { ...initialBoundary };
    }
  }

  /**
   * Restores the boundary from the storage adapter (if any). Returns the
   * restored boundary. Safe to call multiple times; the most recent persisted
   * checkpoint wins.
   */
  public async restore(): Promise<IngestionBoundary> {
    if (this.storage) {
      const persisted = await this.storage.load();
      if (persisted) {
        this.boundary = { ...persisted };
      }
    }
    return this.getBoundary();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const result = this.storage.save({ ...this.boundary });
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Persistence is best-effort; in-memory state remains authoritative.
    }
  }

  public getBoundary(): IngestionBoundary {
    return { ...this.boundary, detectedGaps: this.boundary.detectedGaps.map((g) => ({ ...g })) };
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
      this.persist();
      return { contiguous: false, gapDetected: gap };
    }

    // Contiguous progression
    if (toLedger >= this.boundary.lastContiguousLedger) {
      this.boundary.lastContiguousLedger = toLedger;
      this.boundary.updatedAt = Date.now();
      this.persist();
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
    this.persist();
  }

  /**
   * Updates the in-progress cursor (used while a batch is being committed).
   */
  public setInProgressCursor(cursor: string | null): void {
    this.boundary.inProgressCursor = cursor;
    this.boundary.updatedAt = Date.now();
    this.persist();
  }
}

export type BackfillStatus = 'idle' | 'running' | 'paused' | 'cancelled' | 'completed';

export interface BackfillProgress {
  fromLedger: number;
  toLedger: number;
  completedLedger: number;
  status: BackfillStatus;
  batchesProcessed: number;
  updatedAt: number;
}

export interface BackfillStorageAdapter {
  load(): BackfillProgress | null | Promise<BackfillProgress | null>;
  save(progress: BackfillProgress): void | Promise<void>;
}

export interface BackfillJobOptions {
  /** Inclusive ledger range to backfill. */
  fromLedger: number;
  toLedger: number;
  /** Maximum ledgers fetched per RPC call. */
  batchSize?: number;
  /** Minimum milliseconds between RPC calls (throttle). */
  minIntervalMs?: number;
  /** Fetches a single bounded batch of ledgers. */
  fetchBatch: (fromLedger: number, toLedger: number) => Promise<void>;
  /** Optional durable progress storage. */
  storage?: BackfillStorageAdapter;
  /** Optional clock injection for deterministic tests. */
  now?: () => number;
  /** Optional sleep injection for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Coordination lock: returns the newest live-ingested ledger. */
  getLiveIngestedLedger?: () => number;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MIN_INTERVAL_MS = 250;

/**
 * Bounded, resumable backfill job manager.
 *
 * Guarantees:
 * - Batches are bounded by `batchSize` and throttled by `minIntervalMs`.
 * - Progress is persisted after every batch so restarts resume correctly.
 * - Cancellation stops the loop without losing completed progress.
 * - Backfill never advances past the live-ingested ledger, so it cannot
 *   overwrite newer canonical events.
 */
export class BackfillJobManager {
  private progress: BackfillProgress;
  private readonly batchSize: number;
  private readonly minIntervalMs: number;
  private readonly fetchBatch: BackfillJobOptions['fetchBatch'];
  private readonly storage?: BackfillStorageAdapter;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly getLiveIngestedLedger?: () => number;

  private cancelled = false;
  private paused = false;
  private running = false;
  private lastCallAt = 0;

  constructor(options: BackfillJobOptions) {
    const from = Math.max(0, Math.floor(options.fromLedger));
    const to = Math.max(from, Math.floor(options.toLedger));
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
    this.minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS));
    this.fetchBatch = options.fetchBatch;
    this.storage = options.storage;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.getLiveIngestedLedger = options.getLiveIngestedLedger;

    this.progress = {
      fromLedger: from,
      toLedger: to,
      completedLedger: from - 1,
      status: 'idle',
      batchesProcessed: 0,
      updatedAt: this.now(),
    };
  }

  public getProgress(): BackfillProgress {
    return { ...this.progress };
  }

  /**
   * Restores persisted progress. Completed ledgers are never moved backwards.
   */
  public async restore(): Promise<BackfillProgress> {
    if (this.storage) {
      const persisted = await this.storage.load();
      if (persisted && persisted.completedLedger > this.progress.completedLedger) {
        this.progress = {
          fromLedger: Math.max(this.progress.fromLedger, persisted.fromLedger),
          toLedger: Math.max(this.progress.toLedger, persisted.toLedger),
          completedLedger: persisted.completedLedger,
          status: persisted.status === 'completed' ? 'completed' : 'paused',
          batchesProcessed: persisted.batchesProcessed ?? 0,
          updatedAt: persisted.updatedAt ?? this.now(),
        };
      }
    }
    return this.getProgress();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      const result = this.storage.save({ ...this.progress });
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Best-effort persistence.
    }
  }

  private setStatus(status: BackfillStatus): void {
    this.progress.status = status;
    this.progress.updatedAt = this.now();
    this.persist();
  }

  /**
   * Upper bound for the next batch, clamped by the live-ingested ledger so a
   * backfill can never overwrite newer canonical events.
   */
  private nextBatchEnd(): number {
    const next = this.progress.completedLedger + 1;
    const bounded = Math.min(next + this.batchSize - 1, this.progress.toLedger);
    if (this.getLiveIngestedLedger) {
      const live = this.getLiveIngestedLedger();
      if (Number.isFinite(live) && live >= 0) {
        return Math.min(bounded, live);
      }
    }
    return bounded;
  }

  private async throttle(): Promise<void> {
    if (this.minIntervalMs <= 0) return;
    const elapsed = this.now() - this.lastCallAt;
    const wait = this.minIntervalMs - elapsed;
    if (wait > 0) {
      await this.sleep(wait);
    }
    this.lastCallAt = this.now();
  }

  /**
   * Runs the backfill to completion (or until paused/cancelled). Resolves with
   * the final progress snapshot.
   */
  public async start(): Promise<BackfillProgress> {
    if (this.running) return this.getProgress();
    if (this.progress.status === 'completed') return this.getProgress();

    this.running = true;
    this.cancelled = false;
    this.paused = false;
    this.setStatus('running');

    try {
      while (!this.cancelled && !this.paused) {
        const from = this.progress.completedLedger + 1;
        if (from > this.progress.toLedger) {
          this.setStatus('completed');
          break;
        }

        const to = this.nextBatchEnd();
        if (to < from) {
          // Live ingestion has not yet reached this range; stop and wait.
          this.setStatus('paused');
          break;
        }

        await this.throttle();
        if (this.cancelled || this.paused) break;

        await this.fetchBatch(from, to);

        // Only advance forward; never overwrite newer canonical events.
        if (to > this.progress.completedLedger) {
          this.progress.completedLedger = to;
        }
        this.progress.batchesProcessed += 1;
        this.progress.updatedAt = this.now();
        this.persist();
      }
    } finally {
      this.running = false;
    }

    if (this.cancelled) {
      this.setStatus('cancelled');
    } else if (this.paused) {
      this.setStatus('paused');
    }

    return this.getProgress();
  }

  /** Pauses the running backfill; progress is preserved for resume(). */
  public pause(): void {
    if (this.running) {
      this.paused = true;
    } else if (this.progress.status === 'running') {
      this.setStatus('paused');
    }
  }

  /** Cancels the backfill. Completed progress is retained. */
  public cancel(): void {
    this.cancelled = true;
    this.paused = false;
    if (!this.running) {
      this.setStatus('cancelled');
    }
  }

  /** Resumes a paused/cancelled backfill from persisted progress. */
  public async resume(): Promise<BackfillProgress> {
    if (this.progress.status === 'completed') return this.getProgress();
    this.cancelled = false;
    this.paused = false;
    return this.start();
  }
}
