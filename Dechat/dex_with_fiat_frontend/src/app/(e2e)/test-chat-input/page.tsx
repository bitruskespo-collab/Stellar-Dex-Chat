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

/**
 * Payout identifiers (bank account, IBAN, wallet address, payout reference)
 * must never enter a stored trace. Matched by key name and by value shape.
 */
const PAYOUT_KEY = /(payout|iban|account|routing|wallet|address|beneficiary|bank)/i;
const PAYOUT_VALUE = /(\b0x[0-9a-fA-F]{6,}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b)/;

/** Redact sensitive argument values before they enter a trace. */
function redactArgs(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    const s = String(v);
    out[k] =
      SENSITIVE_KEY.test(k) || PAYOUT_KEY.test(k) || PAYOUT_VALUE.test(s)
        ? '[REDACTED]'
        : s;
  }
  return out;
}

/**
 * Retention policy for stored model traces and evaluation fixtures.
 *
 * Traces (prompts/completions) are kept for a short debugging window;
 * evaluation fixtures are kept longer because they are synthetic and pinned.
 * Expired entries are purged on read and on write so retention is enforced
 * without a background job.
 */
const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FIXTURE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface RetainedTrace {
  /** Owning user id (opaque, never an email or wallet address). */
  userId: string;
  /** Session id the trace was recorded under. */
  sessionId: string;
  recordedAt: number;
  trace: ConversationTrace;
}

interface RetainedFixture {
  fixture: string;
  recordedAt: number;
  trace: ConversationTrace;
}

/** In-memory retention store; nothing is persisted client-side. */
const traceStore = new Map<string, RetainedTrace>();
const fixtureStore = new Map<string, RetainedFixture>();

function traceKey(userId: string, sessionId: string, recordedAt: number): string {
  return `${userId}\u0000${sessionId}\u0000${recordedAt}`;
}

/** Purge expired traces and fixtures. Returns counts removed. */
function purgeExpired(now: number = Date.now()): { traces: number; fixtures: number } {
  let traces = 0;
  let fixtures = 0;
  for (const [k, v] of traceStore) {
    if (now - v.recordedAt > TRACE_RETENTION_MS) {
      traceStore.delete(k);
      traces++;
    }
  }
  for (const [k, v] of fixtureStore) {
    if (now - v.recordedAt > FIXTURE_RETENTION_MS) {
      fixtureStore.delete(k);
      fixtures++;
    }
  }
  return { traces, fixtures };
}

/**
 * Record a trace at the write boundary. Arguments are redacted here so
 * secrets and payout identifiers can never reach the store.
 */
function recordTrace(
  userId: string,
  sessionId: string,
  trace: ConversationTrace,
  now: number = Date.now(),
): void {
  purgeExpired(now);
  const safe: ConversationTrace = {
    ...trace,
    steps: trace.steps.map((s) => ({ ...s, args: redactArgs(s.args) })),
  };
  traceStore.set(traceKey(userId, sessionId, now), {
    userId,
    sessionId,
    recordedAt: now,
    trace: safe,
  });
}

/** Record an evaluation fixture (synthetic, pinned). */
function recordFixture(fixture: ConversationTrace, now: number = Date.now()): void {
  purgeExpired(now);
  const safe: ConversationTrace = {
    ...fixture,
    steps: fixture.steps.map((s) => ({ ...s, args: redactArgs(s.args) })),
  };
  fixtureStore.set(fixture.fixture, { fixture: fixture.fixture, recordedAt: now, trace: safe });
}

/**
 * Delete traces for a user. Authorization: callers may only delete their own
 * traces; a mismatched actor is rejected and nothing is removed.
 */
function deleteTracesByUser(
  actorId: string,
  userId: string,
): { deleted: number; authorized: boolean } {
  if (actorId !== userId) return { deleted: 0, authorized: false };
  let deleted = 0;
  for (const [k, v] of traceStore) {
    if (v.userId === userId) {
      traceStore.delete(k);
      deleted++;
    }
  }
  return { deleted, authorized: true };
}

/**
 * Delete traces for a session. Authorization: the actor must own the session's
 * traces. Returns `notFound` when no traces exist so callers can recover.
 */
function deleteTracesBySession(
  actorId: string,
  sessionId: string,
): { deleted: number; authorized: boolean; notFound: boolean } {
  const owned = [...traceStore.values()].filter((v) => v.sessionId === sessionId);
  if (owned.length === 0) return { deleted: 0, authorized: true, notFound: true };
  if (owned.some((v) => v.userId !== actorId)) {
    return { deleted: 0, authorized: false, notFound: false };
  }
  let deleted = 0;
  for (const [k, v] of traceStore) {
    if (v.sessionId === sessionId) {
      traceStore.delete(k);
      deleted++;
    }
  }
  return { deleted, authorized: true, notFound: false };
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
