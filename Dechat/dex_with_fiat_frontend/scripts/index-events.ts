import { rpc, scValToNative } from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import {
  TransactionalIndexer,
  FileCheckpointStore,
  FileEventStore,
  RpcThrottle,
  BackfillManager,
  type RawContractEvent,
} from '../lib/indexer';

// Minimal interfaces to avoid import issues in script context
interface ContractEvent {
  id: string;
  type: 'deposit' | 'withdraw';
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  actor: string;
  amount: string;
  token?: string;
  version: number;
}

interface IndexerState {
  lastPagingToken: string;
  lastLedger: number;
  updatedAt: string;
}

// Config from env or defaults
const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.NEXT_PUBLIC_FIAT_BRIDGE_CONTRACT || 'CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR';
const server = new rpc.Server(RPC_URL);

const DATA_DIR = path.join(process.cwd(), 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'contract-events.json');
const STATE_FILE = path.join(DATA_DIR, 'indexer-state.json');
const BACKFILL_FILE = path.join(DATA_DIR, 'indexer-backfill.json');
const ALERTS_FILE = path.join(DATA_DIR, 'observability-alerts.json');

// Bounded ingestion batches and RPC throttling (issues #242 / #244).
const INGEST_BATCH_SIZE = num(process.env.INDEXER_BATCH_SIZE, 100);
const RPC_MIN_INTERVAL_MS = num(process.env.INDEXER_RPC_MIN_INTERVAL_MS, 250);
const RPC_MAX_RETRIES = num(process.env.INDEXER_RPC_MAX_RETRIES, 5);
const FRESH_START_LOOKBACK = num(process.env.INDEXER_FRESH_LOOKBACK_LEDGERS, 10000);
const BACKFILL_MAX_LEDGERS = num(process.env.INDEXER_BACKFILL_MAX_LEDGERS, 5000);

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Observability thresholds (issue #121)
// Warning/critical thresholds for queue age/depth, indexer lag, webhook
// backlog, and reconciliation age. Overridable via env for operators.
// ---------------------------------------------------------------------------
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const THRESHOLDS = {
  withdrawalQueueAgeSeconds: {
    warning: num(process.env.ALERT_WITHDRAWAL_QUEUE_AGE_WARN, 30 * 60),
    critical: num(process.env.ALERT_WITHDRAWAL_QUEUE_AGE_CRIT, 2 * 60 * 60),
  },
  withdrawalQueueDepth: {
    warning: num(process.env.ALERT_WITHDRAWAL_QUEUE_DEPTH_WARN, 25),
    critical: num(process.env.ALERT_WITHDRAWAL_QUEUE_DEPTH_CRIT, 100),
  },
  indexerLagLedgers: {
    warning: num(process.env.ALERT_INDEXER_LAG_WARN, 50),
    critical: num(process.env.ALERT_INDEXER_LAG_CRIT, 250),
  },
  webhookBacklog: {
    warning: num(process.env.ALERT_WEBHOOK_BACKLOG_WARN, 50),
    critical: num(process.env.ALERT_WEBHOOK_BACKLOG_CRIT, 250),
  },
  reconciliationAgeSeconds: {
    warning: num(process.env.ALERT_RECON_AGE_WARN, 6 * 60 * 60),
    critical: num(process.env.ALERT_RECON_AGE_CRIT, 24 * 60 * 60),
  },
};

type Severity = 'warning' | 'critical';

interface AlertRecord {
  key: string;
  severity: Severity;
  summary: string;
  operatorAction: string;
  // Safe, non-sensitive references only (ids/hashes/ledgers), never PII or secrets.
  safeRefs: Record<string, string | number>;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
}

interface AlertState {
  active: Record<string, AlertRecord>;
  resolved: Record<string, { resolvedAt: string; lastSeverity: Severity }>;
}

function loadAlertState(): AlertState {
  if (fs.existsSync(ALERTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
    } catch {
      // fall through to fresh state
    }
  }
  return { active: {}, resolved: {} };
}

function saveAlertState(state: AlertState) {
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(state, null, 2));
}

// Deduplicate flapping alerts: a condition is keyed by its stable identity, so
// repeated crossings update the existing record instead of emitting duplicates.
// When the condition recovers, the alert is cleared and moved to `resolved`.
function reconcileAlerts(
  state: AlertState,
  conditions: Array<{
    key: string;
    severity: Severity | null;
    summary: string;
    operatorAction: string;
    safeRefs: Record<string, string | number>;
  }>
) {
  const now = new Date().toISOString();
  const seen = new Set<string>();

  for (const cond of conditions) {
    seen.add(cond.key);
    if (cond.severity === null) {
      // Recovered: clear the active alert.
      if (state.active[cond.key]) {
        const prev = state.active[cond.key];
        delete state.active[cond.key];
        state.resolved[cond.key] = { resolvedAt: now, lastSeverity: prev.severity };
        console.log(`[alert:resolved] ${cond.key} recovered`);
      }
      continue;
    }

    const existing = state.active[cond.key];
    if (existing) {
      // Deduplicate: update in place, only log on severity escalation.
      existing.lastSeenAt = now;
      existing.occurrences += 1;
      existing.safeRefs = cond.safeRefs;
      if (existing.severity !== cond.severity) {
        console.log(`[alert:${cond.severity}] ${cond.key} escalated from ${existing.severity}`);
        existing.severity = cond.severity;
      }
    } else {
      state.active[cond.key] = {
        key: cond.key,
        severity: cond.severity,
        summary: cond.summary,
        operatorAction: cond.operatorAction,
        safeRefs: cond.safeRefs,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrences: 1,
      };
      console.log(`[alert:${cond.severity}] ${cond.key} :: ${cond.summary} -> ${cond.operatorAction}`);
    }
    delete state.resolved[cond.key];
  }

  // Clear any active alerts whose condition no longer appears.
  for (const key of Object.keys(state.active)) {
    if (!seen.has(key)) {
      const prev = state.active[key];
      delete state.active[key];
      state.resolved[key] = { resolvedAt: now, lastSeverity: prev.severity };
      console.log(`[alert:resolved] ${key} recovered`);
    }
  }
}

function severityFor(value: number, t: { warning: number; critical: number }): Severity | null {
  if (value >= t.critical) return 'critical';
  if (value >= t.warning) return 'warning';
  return null;
}

// Expected user approval delays are NOT provider failures. A withdrawal that is
// still within the approval window is classified as `awaiting_approval` and does
// not raise a provider-failure alert; only withdrawals past the approval window
// are treated as genuine provider failures.
const APPROVAL_WINDOW_SECONDS = num(process.env.WITHDRAWAL_APPROVAL_WINDOW_SECONDS, 15 * 60);

interface WithdrawalRecord {
  id: string;
  createdAt: string;
  status: 'awaiting_approval' | 'approved' | 'processing' | 'completed' | 'failed';
  providerRef?: string;
}

function classifyWithdrawal(w: WithdrawalRecord, nowMs: number) {
  const ageSeconds = Math.max(0, (nowMs - Date.parse(w.createdAt)) / 1000);
  const isApprovalDelay = w.status === 'awaiting_approval' && ageSeconds <= APPROVAL_WINDOW_SECONDS;
  return { ageSeconds, isApprovalDelay };
}

async function getLatestLedger() {
  const latestLedgerResp = await server.getLatestLedger();
  return latestLedgerResp.sequence;
}

// Map a raw Soroban event into the canonical ContractEvent shape.
// Topic 0: Version (u32), Topic 1: Symbol (deposit/withdraw),
// Topic 2: Address (actor), Value: i128 (amount).
function mapEvent(event: RawContractEvent): ContractEvent | null {
  const topics = event.topic.map((t) => scValToNative(t));
  const value = scValToNative(event.value);

  const typeStr = topics[1] as string;
  const actor = topics[2] as string;
  const eventType: 'deposit' | 'withdraw' = typeStr === 'withdraw' ? 'withdraw' : 'deposit';
  const contractId =
    typeof event.contractId === 'string'
      ? event.contractId
      : (event.contractId as any)?.id || CONTRACT_ID;

  if (eventType !== 'deposit' && eventType !== 'withdraw') return null;

  return {
    id: event.id,
    type: eventType,
    contractId: String(contractId),
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    txHash: event.txHash,
    actor,
    amount: String(value),
    version: Number(topics[0]) || 1,
  };
}

async function indexEvents() {
  console.log('Starting event indexing for contract:', CONTRACT_ID);

  // Durable checkpoint + event store. The checkpoint is the single source of
  // truth for resume position; events and cursor advance atomically together.
  const checkpointStore = new FileCheckpointStore(STATE_FILE);
  const eventStore = new FileEventStore(EVENTS_FILE);
  const throttle = new RpcThrottle({ minIntervalMs: RPC_MIN_INTERVAL_MS, maxRetries: RPC_MAX_RETRIES });

  const indexer = new TransactionalIndexer({
    contractId: CONTRACT_ID,
    checkpointStore,
    eventStore,
    fetchEvents: async ({ startLedger, limit }) => {
      const response = await throttle.run(() =>
        server.getEvents({
          startLedger,
          filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
          limit,
        })
      );
      return {
        events: response.events as unknown as RawContractEvent[],
        latestLedger: response.latestLedger,
      };
    },
    mapEvent,
    batchSize: INGEST_BATCH_SIZE,
    onCommit: (info) => {
      console.log(
        `[checkpoint] committed ${info.eventCount} events; cursor ledger=${info.lastLedger} pagingToken=${info.lastPagingToken}`
      );
    },
  });

  const backfill = new BackfillManager({
    indexer,
    checkpointStore,
    progressFile: BACKFILL_FILE,
    maxLedgersPerRun: BACKFILL_MAX_LEDGERS,
    throttle,
    onProgress: (p) => {
      console.log(
        `[backfill] ${p.status} ${p.processedLedgers}/${p.totalLedgers} ledgers (cursor=${p.lastLedger})`
      );
    },
  });

  // Honor SIGINT/SIGTERM: stop scheduling new batches and let the in-flight
  // batch commit atomically so we never leave a torn checkpoint.
  let cancelled = false;
  const requestCancel = (signal: string) => {
    if (cancelled) return;
    cancelled = true;
    console.log(`[indexer] received ${signal}; cancelling after current batch`);
    backfill.cancel();
    indexer.cancel();
  };
  process.on('SIGINT', () => requestCancel('SIGINT'));
  process.on('SIGTERM', () => requestCancel('SIGTERM'));

  const checkpoint = await checkpointStore.load();
  const latestLedger = await getLatestLedger();
  const startLedger = checkpoint?.lastLedger || latestLedger - FRESH_START_LOOKBACK;

  console.log(
    `Resuming from checkpoint ledger=${checkpoint?.lastLedger ?? 'none'} pagingToken=${checkpoint?.lastPagingToken ?? 'none'}`
  );
  console.log(`Polling events from ledger ${startLedger} to ${latestLedger}`);

  try {
    // Bounded, resumable backfill for any gap between the checkpoint and the
    // live tip. Backfill never overwrites newer canonical events.
    if (latestLedger - startLedger > 0) {
      await backfill.run({ fromLedger: startLedger, toLedger: latestLedger });
    }

    if (!cancelled) {
      await indexer.ingestOnce();
    }

    const state = (await checkpointStore.load()) ?? {
      lastPagingToken: '0',
      lastLedger: 0,
      updatedAt: new Date().toISOString(),
    };

    // -----------------------------------------------------------------------
    // Evaluate observability conditions and reconcile alerts (issue #121).
    // -----------------------------------------------------------------------
    const nowMs = Date.now();
    const alertState = loadAlertState();

    // Indexer lag: how far behind the chain tip we are.
    const indexerLag = Math.max(0, latestLedger - state.lastLedger);

    // Withdrawal queue: derived from indexed withdraw events that have not yet
    // been reconciled. Safe refs use event ids / tx hashes only.
    const withdrawals: WithdrawalRecord[] = [];
    if (fs.existsSync(EVENTS_FILE)) {
      const all: ContractEvent[] = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
      for (const e of all) {
        if (e.type !== 'withdraw') continue;
        withdrawals.push({
          id: e.id,
          createdAt: e.ledgerClosedAt,
          status: 'processing',
          providerRef: e.txHash,
        });
      }
    }

    const pendingWithdrawals = withdrawals.filter(w => w.status !== 'completed' && w.status !== 'failed');
    const queueDepth = pendingWithdrawals.length;

    let oldestAgeSeconds = 0;
    let oldestRef: string | undefined;
    let providerFailureCount = 0;
    let approvalDelayCount = 0;
    for (const w of pendingWithdrawals) {
      const { ageSeconds, isApprovalDelay } = classifyWithdrawal(w, nowMs);
      if (isApprovalDelay) {
        approvalDelayCount += 1;
        continue; // expected user approval delay, not a provider failure
      }
      providerFailureCount += 1;
      if (ageSeconds > oldestAgeSeconds) {
        oldestAgeSeconds = ageSeconds;
        oldestRef = w.id;
      }
    }

    // Webhook backlog + reconciliation age are read from optional sidecar files
    // produced by the payout worker; absent files mean no backlog.
    const webhookBacklog = readCountFile(path.join(DATA_DIR, 'webhook-backlog.json'));
    const reconciliationAgeSeconds = readAgeFile(path.join(DATA_DIR, 'reconciliation-state.json'));

    const conditions = [
      {
        key: 'withdrawal_queue_age',
        severity: severityFor(oldestAgeSeconds, THRESHOLDS.withdrawalQueueAgeSeconds),
        summary: `Oldest pending withdrawal is ${Math.round(oldestAgeSeconds)}s old`,
        operatorAction: 'Inspect the payout worker and retry the stuck withdrawal.',
        safeRefs: { oldestWithdrawalId: oldestRef ?? 'none', ageSeconds: Math.round(oldestAgeSeconds) },
      },
      {
        key: 'withdrawal_queue_depth',
        severity: severityFor(queueDepth, THRESHOLDS.withdrawalQueueDepth),
        summary: `Withdrawal queue depth is ${queueDepth}`,
        operatorAction: 'Scale payout workers or drain the queue via the operator console.',
        safeRefs: { queueDepth, providerFailures: providerFailureCount, approvalDelays: approvalDelayCount },
      },
      {
        key: 'indexer_lag',
        severity: severityFor(indexerLag, THRESHOLDS.indexerLagLedgers),
        summary: `Indexer is ${indexerLag} ledgers behind the chain tip`,
        operatorAction: 'Check RPC availability and restart the indexer if lag persists.',
        safeRefs: { indexerLag, lastLedger: state.lastLedger, latestLedger },
      },
      {
        key: 'webhook_backlog',
        severity: severityFor(webhookBacklog, THRESHOLDS.webhookBacklog),
        summary: `Webhook backlog is ${webhookBacklog}`,
        operatorAction: 'Verify provider webhook delivery and replay failed deliveries.',
        safeRefs: { webhookBacklog },
      },
      {
        key: 'reconciliation_age',
        severity: severityFor(reconciliationAgeSeconds, THRESHOLDS.reconciliationAgeSeconds),
        summary: `Last reconciliation was ${Math.round(reconciliationAgeSeconds)}s ago`,
        operatorAction: 'Run the payout reconciliation job and confirm ledger balances.',
        safeRefs: { reconciliationAgeSeconds: Math.round(reconciliationAgeSeconds) },
      },
    ];

    reconcileAlerts(alertState, conditions);
    saveAlertState(alertState);

    console.log(cancelled ? 'Indexing cancelled cleanly.' : 'Indexing complete.');
  } catch (error) {
    console.error('Error indexing events:', error);
    process.exitCode = 1;
  }
}

function readCountFile(file: string): number {
  if (!fs.existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number(parsed?.count) || 0;
  } catch {
    return 0;
  }
}

function readAgeFile(file: string): number {
  if (!fs.existsSync(file)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ts = parsed?.lastReconciledAt;
    if (!ts) return 0;
    return Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  } catch {
    return 0;
  }
}

// Run indexing
indexEvents().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
