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
 * Typed, versioned schema for AI tool-call proposals.
 *
 * Model output is validated against this strict schema before it reaches any
 * transaction code. Unknown fields and unsupported operations are rejected,
 * and a safe, sanitized explanation is preserved for user-facing
 * clarification. The schema version is explicit so future revisions can be
 * detected and rejected rather than silently misinterpreted.
 */
const TOOL_CALL_SCHEMA_VERSION = 1 as const;

/** Operations the client is allowed to propose. Anything else is rejected. */
const SUPPORTED_OPERATIONS = ['swap', 'send'] as const;
type SupportedOperation = (typeof SUPPORTED_OPERATIONS)[number];

interface ToolCallProposal {
  schemaVersion: typeof TOOL_CALL_SCHEMA_VERSION;
  operation: SupportedOperation;
  /** Canonical amount after deterministic parsing; never a raw utterance. */
  amount: number;
  /** ISO 4217 or token symbol resolved from the utterance. */
  currency: string;
  /** Optional destination for `send`; must be absent for `swap`. */
  recipient?: string;
  /** Safe, sanitized explanation for user-facing clarification. */
  explanation: string;
}

type ToolCallValidation =
  | { ok: true; proposal: ToolCallProposal }
  | { ok: false; reason: string; explanation: string };

const TOOL_CALL_FIELDS = new Set([
  'schemaVersion',
  'operation',
  'amount',
  'currency',
  'recipient',
  'explanation',
]);

/** Strip control characters and cap length so explanations stay safe to render. */
function sanitizeExplanation(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.slice(0, 280);
}

/**
 * Validate untrusted model output against the strict, versioned tool-call
 * schema. Rejects unknown fields, unsupported operations, wrong schema
 * versions, and malformed values. Never throws; always returns a safe
 * explanation on failure.
 */
function validateToolCallProposal(raw: unknown): ToolCallValidation {
  const fallback = 'I could not safely interpret that request. Please rephrase it.';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object', explanation: fallback };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!TOOL_CALL_FIELDS.has(key)) {
      return { ok: false, reason: `unknown-field:${key}`, explanation: fallback };
    }
  }
  if (obj.schemaVersion !== TOOL_CALL_SCHEMA_VERSION) {
    return { ok: false, reason: 'unsupported-schema-version', explanation: fallback };
  }
  if (
    typeof obj.operation !== 'string' ||
    !(SUPPORTED_OPERATIONS as readonly string[]).includes(obj.operation)
  ) {
    return { ok: false, reason: 'unsupported-operation', explanation: fallback };
  }
  if (typeof obj.amount !== 'number' || !Number.isFinite(obj.amount) || obj.amount <= 0) {
    return { ok: false, reason: 'invalid-amount', explanation: fallback };
  }
  if (typeof obj.currency !== 'string' || obj.currency.trim() === '') {
    return { ok: false, reason: 'invalid-currency', explanation: fallback };
  }
  if (obj.recipient !== undefined && typeof obj.recipient !== 'string') {
    return { ok: false, reason: 'invalid-recipient', explanation: fallback };
  }
  if (obj.operation === 'swap' && obj.recipient !== undefined) {
    return { ok: false, reason: 'unexpected-recipient', explanation: fallback };
  }
  const explanation = sanitizeExplanation(obj.explanation);
  if (explanation === '') {
    return { ok: false, reason: 'missing-explanation', explanation: fallback };
  }
  return {
    ok: true,
    proposal: {
      schemaVersion: TOOL_CALL_SCHEMA_VERSION,
      operation: obj.operation as SupportedOperation,
      amount: obj.amount,
      currency: obj.currency,
      recipient: obj.recipient as string | undefined,
      explanation,
    },
  };
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
