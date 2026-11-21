import { rpc, scValToNative } from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';

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

// ---------------------------------------------------------------------------
// Client-side cache invalidation policy (issue #208)
//
// Maps wallet/network changes and contract events to the specific account,
// balance, quote, and transaction caches they invalidate. This is the single
// source of truth consumed by the frontend cache layer; it is intentionally
// pure (no I/O) so it can be unit-tested and reused in the browser.
//
// Reordering: every event carries a monotonic `ledger` (and optional
// `pagingToken`). The policy tracks the highest ledger it has applied per
// contract and ignores events at or below that watermark, so a late/duplicate
// event cannot re-invalidate caches or regress the watermark.
//
// Missed events: when a gap is detected (event ledger > watermark + 1) the
// policy emits a `resync` action that invalidates every cache for the affected
// scope, so caches converge even if intermediate events were dropped.
// ---------------------------------------------------------------------------

export type CacheScope =
  | 'account'
  | 'balance'
  | 'quote'
  | 'transaction';

export type WalletEventKind =
  | 'wallet:connected'
  | 'wallet:disconnected'
  | 'wallet:account-changed'
  | 'network:changed'
  | 'contract:deposit'
  | 'contract:withdraw';

export interface WalletEvent {
  kind: WalletEventKind;
  /** Monotonic ledger sequence for contract events; omitted for wallet events. */
  ledger?: number;
  /** Optional paging token for stable ordering within a ledger. */
  pagingToken?: string;
  /** Contract id the event belongs to (contract events only). */
  contractId?: string;
  /** Actor/account the event affects, when known. */
  actor?: string;
}

export interface InvalidationAction {
  scope: CacheScope;
  /** Account whose caches are affected; `*` means all accounts. */
  account: string;
  /** Human-readable reason for observability/debugging. */
  reason: string;
  /** True when the action is a full resync after a detected gap. */
  resync: boolean;
}

export interface InvalidationResult {
  actions: InvalidationAction[];
  /** True when the event was ignored (stale/duplicate/out-of-order). */
  ignored: boolean;
  /** True when a gap was detected and a resync was emitted. */
  gapDetected: boolean;
}

interface Watermark {
  ledger: number;
  pagingToken?: string;
}

const ALL_SCOPES: CacheScope[] = ['account', 'balance', 'quote', 'transaction'];

function actionsFor(
  scopes: CacheScope[],
  account: string,
  reason: string,
  resync: boolean
): InvalidationAction[] {
  return scopes.map((scope) => ({ scope, account, reason, resync }));
}

/**
 * Stateful cache invalidation policy. One instance per contract/network scope.
 * Feed it wallet and contract events in arrival order; it returns the cache
 * invalidations to apply and tracks a per-contract ledger watermark.
 */
export class CacheInvalidationPolicy {
  private watermarks = new Map<string, Watermark>();

  /** Reset all watermarks (e.g. on network change). */
  reset(): void {
    this.watermarks.clear();
  }

  /**
   * Apply a single event and return the invalidations it triggers.
   * Out-of-order/duplicate contract events are ignored; gaps trigger a resync.
   */
  apply(event: WalletEvent): InvalidationResult {
    switch (event.kind) {
      case 'wallet:connected':
        // Fresh session: account + balance may be stale from a prior wallet.
        return {
          actions: actionsFor(['account', 'balance'], '*', 'wallet connected', false),
          ignored: false,
          gapDetected: false,
        };

      case 'wallet:disconnected':
        // Drop everything tied to the previous account.
        return {
          actions: actionsFor(ALL_SCOPES, '*', 'wallet disconnected', false),
          ignored: false,
          gapDetected: false,
        };

      case 'wallet:account-changed':
        // New account: invalidate account/balance/transaction; quotes are
        // account-agnostic but may be priced for the old account's tier.
        return {
          actions: actionsFor(
            ['account', 'balance', 'quote', 'transaction'],
            event.actor ?? '*',
            'wallet account changed',
            false
          ),
          ignored: false,
          gapDetected: false,
        };

      case 'network:changed':
        // Network switch invalidates every cache and resets watermarks so the
        // new network's events are not compared against the old watermark.
        this.reset();
        return {
          actions: actionsFor(ALL_SCOPES, '*', 'network changed', true),
          ignored: false,
          gapDetected: false,
        };

      case 'contract:deposit':
      case 'contract:withdraw': {
        const contractId = event.contractId ?? 'default';
        const ledger = event.ledger ?? 0;
        const prev = this.watermarks.get(contractId);

        // Reordering: ignore stale/duplicate events at or below the watermark.
        if (prev && ledger <= prev.ledger) {
          return { actions: [], ignored: true, gapDetected: false };
        }

        // Missed-event recovery: a jump beyond the next ledger means events
        // were dropped, so resync every cache for the affected account.
        const gapDetected = prev !== undefined && ledger > prev.ledger + 1;
        this.watermarks.set(contractId, { ledger, pagingToken: event.pagingToken });

        const account = event.actor ?? '*';
        const reason = gapDetected
          ? `${event.kind} gap detected (ledger ${ledger})`
          : event.kind;

        // Deposits/withdrawals move balances and create transactions; quotes
        // depend on balances so they are invalidated too. A gap widens the
        // invalidation to the account cache as well.
        const scopes: CacheScope[] = gapDetected
          ? ALL_SCOPES
          : ['balance', 'quote', 'transaction'];

        return {
          actions: actionsFor(scopes, account, reason, gapDetected),
          ignored: false,
          gapDetected,
        };
      }

      default:
        return { actions: [], ignored: true, gapDetected: false };
    }
  }

  /** Current watermark for a contract, for tests/observability. */
  getWatermark(contractId: string): Watermark | undefined {
    return this.watermarks.get(contractId);
  }
}

// Config from env or defaults
const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = process.env.NEXT_PUBLIC_FIAT_BRIDGE_CONTRACT || 'CAWYXBN4PSVXD7NIYEWVFFIIIEUCC6PUN3IMG3J2WHKDB4NVIISMXBPR';
const server = new rpc.Server(RPC_URL);

const DATA_DIR = path.join(process.cwd(), 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'contract-events.json');
const STATE_FILE = path.join(DATA_DIR, 'indexer-state.json');
const ALERTS_FILE = path.join(DATA_DIR, 'observability-alerts.json');

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

async function indexEvents() {
  console.log('Starting event indexing for contract:', CONTRACT_ID);

  let state: IndexerState = {
    lastPagingToken: '0',
    lastLedger: 0,
    updatedAt: new Date().toISOString()
  };

  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }

  const latestLedger = await getLatestLedger();
  const startLedger = state.lastLedger || (latestLedger - 10000); // Index last 10k ledgers if fresh start

  console.log(`Polling events from ledger ${startLedger} to ${latestLedger}`);

  try {
    const response = await server.getEvents({
      startLedger: startLedger,
      filters: [
        {
          type: 'contract',
          contractIds: [CONTRACT_ID],
        },
      ],
      limit: 100,
    });

    const newEvents: ContractEvent[] = response.events.map((event) => {
      // Soroban events have topics and value
      // Topic 0: Version (u32)
      // Topic 1: Symbol (deposit/withdraw)
      // Topic 2: Address (actor)
      // Value: i128 (amount)
      
      const topics = event.topic.map(t => scValToNative(t));
      const value = scValToNative(event.value);
      
      const typeStr = topics[1] as string;
      const actor = topics[2] as string;
      const eventT

/* … truncated 6190 chars — edit only what you need near the top … */
