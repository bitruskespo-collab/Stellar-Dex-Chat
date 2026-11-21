'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ChatInput from '@/components/ChatInput';

/**
 * Structured financial fact attached to an AI answer.
 *
 * Source, observed-at time, pair, and validity window are passed as
 * application data so citations are rendered from trusted values and the
 * model can never invent source URLs.
 */
type FactStatus = 'fresh' | 'stale' | 'missing' | 'conflicting';

interface FinancialFact {
  pair: string;
  source: string;
  sourceUrl: string;
  observedAt: string;
  validUntil: string;
  status: FactStatus;
  /** Rate is authoritative; payout is an estimate, never a guarantee. */
  rate?: number;
  estimatedPayout?: number;
}

interface SentMessage {
  text: string;
  fact?: FinancialFact;
}

const STATUS_LABEL: Record<FactStatus, string> = {
  fresh: 'Fresh data',
  stale: 'Stale data — verify before acting',
  missing: 'Data missing — no authoritative rate available',
  conflicting: 'Conflicting sources — treat as unverified',
};

/**
 * Validated transaction intent proposal.
 *
 * Produced by the intent validator (never by conversational prose). The
 * confirmation summary is rendered exclusively from these typed fields so the
 * model cannot smuggle a different asset, amount, recipient, or network into
 * the wallet action.
 */
interface IntentProposal {
  /** True only when the proposal passed server-side validation. */
  validated: boolean;
  asset: string;
  amount: string;
  recipient: string;
  network: string;
}

/** Fields the user must explicitly acknowledge before a wallet action. */
type IntentField = 'asset' | 'amount' | 'recipient' | 'network';
const INTENT_FIELDS: IntentField[] = ['asset', 'amount', 'recipient', 'network'];

const INTENT_FIELD_LABEL: Record<IntentField, string> = {
  asset: 'Asset',
  amount: 'Amount',
  recipient: 'Recipient',
  network: 'Network',
};

/**
 * Validate a raw intent proposal. Returns null when any required field is
 * missing/blank or the proposal was not validated upstream — in that case no
 * confirmation summary is rendered and no wallet action may be dispatched.
 */
function validateIntentProposal(raw: Partial<IntentProposal> | null | undefined): IntentProposal | null {
  if (!raw || raw.validated !== true) return null;
  const asset = typeof raw.asset === 'string' ? raw.asset.trim() : '';
  const amount = typeof raw.amount === 'string' ? raw.amount.trim() : '';
  const recipient = typeof raw.recipient === 'string' ? raw.recipient.trim() : '';
  const network = typeof raw.network === 'string' ? raw.network.trim() : '';
  if (!asset || !amount || !recipient || !network) return null;
  return { validated: true, asset, amount, recipient, network };
}

/**
 * Bounded latency budgets for model requests.
 *
 * `requestMs` bounds a single model round-trip; `totalMs` bounds the whole
 * turn (including retries/streaming). Both are enforced via AbortController so
 * a slow or abandoned call can never block chat or authorize a late action.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 30_000;

/**
 * Typed recoverable state for a model request.
 *
 * `timeout` and `cancelled` are recoverable: the user's text is preserved and
 * no transaction intent is retried without renewed confirmation.
 */
type ModelRequestState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; text: string }
  | { status: 'timeout'; message: string }
  | { status: 'cancelled'; message: string }
  | { status: 'error'; message: string };

/** Latency metrics recorded without prompts or responses. */
interface LatencyMetric {
  outcome: 'ok' | 'timeout' | 'cancelled' | 'error';
  durationMs: number;
}

/**
 * Supported locales for locale-aware intent evaluation.
 *
 * Each entry declares representative examples for amounts, decimal/grouping
 * separators, currencies, and ambiguity cases. Language interpretation is kept
 * separate from canonical parsing and contract unit conversion so transaction
 * arithmetic stays deterministic and unchanged.
 */
type LocaleCode = 'en-US' | 'de-DE' | 'fr-FR' | 'ja-JP';

interface LocaleExample {
  /** Raw user utterance in this locale. */
  utterance: string;
  /** Canonical amount after deterministic parsing, or null if withheld. */
  canonicalAmount: number | null;
  /** ISO 4217 currency code resolved from the utterance, or null if ambiguous. */
  currency: string | null;
  /** True when the input must be withheld for clarification. */
  ambiguous: boolean;
}

interface LocaleSpec {
  code: LocaleCode;
  label: string;
  decimalSeparator: '.' | ',';
  groupingSeparator: ',' | '.' | ' ';
  examples: LocaleExample[];
}

const SUPPORTED_LOCALES: LocaleSpec[] = [
  {
    code: 'en-US',
    label: 'English (United States)',
    decimalSeparator: '.',
    groupingSeparator: ',',
    examples: [
      { utterance: 'swap 1,234.56 USDC to ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'send 100 dollars', canonicalAmount: 100, currency: 'USD', ambiguous: false },
      { utterance: 'swap 50 $ to ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'de-DE',
    label: 'German (Germany)',
    decimalSeparator: ',',
    groupingSeparator: '.',
    examples: [
      { utterance: 'tausche 1.234,56 USDC in ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'sende 100 Euro', canonicalAmount: 100, currency: 'EUR', ambiguous: false },
      { utterance: 'tausche 50 $ in ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'fr-FR',
    label: 'French (France)',
    decimalSeparator: ',',
    groupingSeparator: ' ',
    examples: [
      { utterance: 'échanger 1 234,56 USDC contre ETH', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: 'envoyer 100 euros', canonicalAmount: 100, currency: 'EUR', ambiguous: false },
      { utterance: 'échanger 50 $ contre ETH', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
  {
    code: 'ja-JP',
    label: 'Japanese (Japan)',
    decimalSeparator: '.',
    groupingSeparator: ',',
    examples: [
      { utterance: '1,234.56 USDC を ETH に交換', canonicalAmount: 1234.56, currency: 'USDC', ambiguous: false },
      { utterance: '100 円 を送金', canonicalAmount: 100, currency: 'JPY', ambiguous: false },
      { utterance: '50 $ を ETH に交換', canonicalAmount: 50, currency: null, ambiguous: true },
    ],
  },
];

/**
 * Deterministic conversation replay for incident debugging.
 *
 * A trace records versioned state transitions, tool names, normalized
 * arguments, policy decisions, and outcome codes with sensitive values
 * redacted. Replay compares a recorded trace against a pinned model/policy
 * fixture and reports divergence without executing any external or write
 * tool. Traces are retained in memory only and never persisted client-side.
 */
type PolicyDecision = 'allow' | 'deny' | 'clarify';
type OutcomeCode = 'ok' | 'denied' | 'error' | 'withheld';

interface TraceStep {
  /** Monotonic step index within the trace. */
  index: number;
  /** Versioned state transition label, e.g. "intent.parsed@v1". */
  transition: string;
  /** Tool name, or null when the step is a pure state transition. */
  tool: string | null;
  /** Normalized (redacted) tool arguments. */
  args: Record<string, string>;
  policy: PolicyDecision;
  outcome: OutcomeCode;
}

interface ConversationTrace {
  /** Trace schema version for forward-compatible replay. */
  version: 1;
  /** Pinned model/policy fixture the trace was recorded against. */
  fixture: string;
  steps: TraceStep[];
}

interface ReplayDivergence {
  index: number;
  field: 'transition' | 'tool' | 'args' | 'policy' | 'outcome';
  recorded: string;
  replayed: string;
}

const SENSITIVE_KEY = /(secret|token|key|password|seed|private|auth|signature)/i;

/** Redact sensitive argument values before they enter a trace. */
function redactArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : String(v);
  }
  return out;
}

/** Tools that must never execute during replay. */
const WRITE_TOOLS = new Set(['swap', 'send', 'approve', 'transfer', 'sign']);

/**
 * Replay a recorded trace against a pinned fixture. Pure and deterministic:
 * no network, no model calls, and no tool execution. Returns divergences.
 */
function replayTrace(
  recorded: ConversationTrace,
  fixture: ConversationTrace,
): ReplayDivergence[] {
  const divergences: ReplayDivergence[] = [];
  if (recorded.fixture !== fixture.fixture) {
    divergences.push({
      index: -1,
      field: 'transition',
      recorded: recorded.fixture,
      replayed: fixture.fixture,
    });
    return divergences;
  }
  const len = Math.max(recorded.steps.length, fixture.steps.length);
  for (let i = 0; i < len; i++) {
    const a = recorded.steps[i];
    const b = fixture.steps[i];
    if (!a || !b) {
      divergences.push({
        index: i,
        field: 'transition',
        recorded: a ? a.transition : '(missing)',
        replayed: b ? b.transition : '(missing)',
      });
      continue;
    }
    if (a.transition !== b.transition) {
      divergences.push({ index: i, field: 'transition', recorded: a.transition, replayed: b.transition });
    }
    if (a.tool !== b.tool) {
      divergences.push({ index: i, field: 'tool', recorded: String(a.tool), replayed: String(b.tool) });
    }
    if (JSON.stringify(a.args) !== JSON.stringify(b.args)) {
      divergences.push({ index: i, field: 'args', recorded: JSON.stringify(a.args), replayed: JSON.stringify(b.args) });
    }
    if (a.policy !== b.policy) {
      divergences.push({ index: i, field: 'policy', recorded: a.policy, replayed: b.policy });
    }
    if (a.outcome !== b.outcome) {
      divergences.push({ index: i, field: 'outcome', recorded: a.outcome, replayed: b.outcome });
    }
  }
  return divergences;
}

/**
 * Explicit transaction intent confirmation for AI handoff.
 *
 * Renders a typed summary sourced from the validated intent proposal and
 * requires the user to acknowledge asset, amount, recipient, and network
 * before any wallet action is dispatched. If the proposal is missing or
 * unvalidated, no summary is shown and the action stays disabled.
 */
function IntentConfirmation({
  proposal,
  onConfirm,
}: {
  proposal: IntentProposal | null;
  onConfirm: (proposal: IntentProposal) => void;
}) {
  const [acknowledged, setAcknowledged] = useState<Record<IntentField, boolean>>({
    asset: false,
    amount: false,
    recipient: false,
    network: false,
  });

  // Reset acknowledgements whenever the proposal identity changes so a stale
  // acknowledgement can never authorize a different intent.
  const proposalKey = proposal
    ? `${proposal.asset}|${proposal.amount}|${proposal.recipient}|${proposal.network}`
    : '';
  useEffect(() => {
    setAcknowledged({ asset: false, amount: false, recipient: false, network: false });
  }, [proposalKey]);

  if (!proposal) {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        No validated transaction intent is available. Confirm the asset, amount,
        recipient, and network before any wallet action.
      </div>
    );
  }

  const allAcknowledged = INTENT_FIELDS.every((f) => acknowledged[f]);

  return (
    <div className="rounded border border-gray-300 p-3 text-sm">
      <h3 className="mb-2 font-semibold">Confirm transaction intent</h3>
      <ul className="mb-3 space-y-1">
        {INTENT_FIELDS.map((field) => (
          <li key={field} className="flex items-center gap-2">
            <input
              id={`intent-ack-${field}`}
              type="checkbox"
              checked={acknowledged[field]}
              onChange={(e) =>
                setAcknowledged((prev) => ({ ...prev, [field]: e.target.checked }))
              }
            />
            <label htmlFor={`intent-ack-${field}`}>
              <span className="font-medium">{INTENT_FIELD_LABEL[field]}:</span>{' '}
              <span className="font-mono">{proposal[field]}</span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={!allAcknowledged}
        onClick={() => {
          if (!allAcknowledged) return;
          onConfirm(proposal);
        }}
        className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
      >
        Confirm and continue
      </button>
    </div>
  );
}
