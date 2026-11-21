import { rpc } from '@stellar/stellar-sdk';
import * as fs from 'fs';

/**
 * Baseline Benchmark Script for Stellar-Dex-Chat
 * Measures core network latencies and provides a baseline for UI/AI performance.
 */

const RPC_URL = process.env.RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';

/**
 * Locale-aware intent evaluation (offline).
 *
 * Language interpretation is kept strictly separate from canonical amount
 * parsing and contract unit conversion: this module only detects locale and
 * extracts a raw amount token. Arithmetic (stroop conversion) is NOT performed
 * here and remains deterministic in the existing parsing layer.
 */

interface LocaleExample {
  input: string;
  amount: string;
  decimalSeparator: '.' | ',';
  groupingSeparator: '.' | ',' | ' ' | "'";
  currency: string;
  ambiguous?: boolean;
}

interface LocaleSpec {
  locale: string;
  language: string;
  examples: LocaleExample[];
}

const SUPPORTED_LOCALES: LocaleSpec[] = [
  {
    locale: 'en-US',
    language: 'English (US)',
    examples: [
      { input: 'send 1,234.56 USDC', amount: '1234.56', decimalSeparator: '.', groupingSeparator: ',', currency: 'USDC' },
      { input: 'swap 0.5 XLM to USDC', amount: '0.5', decimalSeparator: '.', groupingSeparator: ',', currency: 'XLM' },
    ],
  },
  {
    locale: 'de-DE',
    language: 'German',
    examples: [
      { input: 'sende 1.234,56 USDC', amount: '1234.56', decimalSeparator: ',', groupingSeparator: '.', currency: 'USDC' },
      { input: 'tausche 0,5 XLM', amount: '0.5', decimalSeparator: ',', groupingSeparator: '.', currency: 'XLM' },
    ],
  },
  {
    locale: 'fr-FR',
    language: 'French',
    examples: [
      { input: 'envoyer 1 234,56 USDC', amount: '1234.56', decimalSeparator: ',', groupingSeparator: ' ', currency: 'USDC' },
      { input: 'envoyer 10 $', amount: '10', decimalSeparator: ',', groupingSeparator: ' ', currency: '$', ambiguous: true },
    ],
  },
  {
    locale: 'es-ES',
    language: 'Spanish',
    examples: [
      { input: 'enviar 1.234,56 USDC', amount: '1234.56', decimalSeparator: ',', groupingSeparator: '.', currency: 'USDC' },
      { input: 'enviar 10 $', amount: '10', decimalSeparator: ',', groupingSeparator: '.', currency: '$', ambiguous: true },
    ],
  },
];

/** Ambiguous currency symbols that must be withheld for clarification. */
const AMBIGUOUS_SYMBOLS = new Set(['$', '¥', 'kr']);

interface IntentEvaluation {
  locale: string | null;
  supported: boolean;
  rawAmount: string | null;
  currency: string | null;
  needsClarification: boolean;
  reason?: string;
}

/**
 * Interpret a user prompt: detect locale and extract a raw amount token.
 * Never converts to stroops and never logs the raw prompt.
 */
function evaluateIntent(prompt: string, declaredLocale?: string): IntentEvaluation {
  const locale = declaredLocale ?? detectLocale(prompt);
  const spec = SUPPORTED_LOCALES.find((l) => l.locale === locale);

  if (!spec) {
    return {
      locale,
      supported: false,
      rawAmount: null,
      currency: null,
      needsClarification: true,
      reason: 'unsupported-locale',
    };
  }

  const amountMatch = prompt.match(/\d[\d.,\s']*/);
  const rawAmount = amountMatch ? amountMatch[0].trim() : null;
  const currencyMatch = prompt.match(/\b(USDC|XLM|EURC)\b|[$¥]/);
  const currency = currencyMatch ? currencyMatch[0] : null;

  if (currency && AMBIGUOUS_SYMBOLS.has(currency)) {
    return {
      locale,
      supported: true,
      rawAmount,
      currency,
      needsClarification: true,
      reason: 'ambiguous-currency-symbol',
    };
  }

  if (!rawAmount) {
    return {
      locale,
      supported: true,
      rawAmount: null,
      currency,
      needsClarification: true,
      reason: 'missing-amount',
    };
  }

  return { locale, supported: true, rawAmount, currency, needsClarification: false };
}

/** Heuristic locale detection from decimal/grouping separators. */
function detectLocale(prompt: string): string | null {
  if (/\d\.\d{3},\d{2}/.test(prompt)) return 'de-DE';
  if (/\d \d{3},\d{2}/.test(prompt)) return 'fr-FR';
  if (/\d,\d{3}\.\d{2}/.test(prompt)) return 'en-US';
  return null;
}

/**
 * Offline evaluation: each locale's examples must either match deterministic
 * parsing or be withheld for clarification. Diagnostics never include prompts.
 */
function runLocaleEvaluations(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  for (const spec of SUPPORTED_LOCALES) {
    for (const example of spec.examples) {
      const result = evaluateIntent(example.input, spec.locale);
      const withheld = result.needsClarification;
      const matches = result.rawAmount === example.amount;
      const ok = example.ambiguous ? withheld : matches && !withheld;
      if (ok) {
        passed++;
      } else {
        failed++;
        // Diagnostics: locale + reason only, never the raw prompt.
        console.error(`❌ locale=${spec.locale} reason=${result.reason ?? 'mismatch'}`);
      }
    }
  }

  return { passed, failed };
}

/**
 * Clarification quality & unsafe-intent deflection evaluation.
 *
 * Versioned metric definitions with per-category thresholds. Evaluation data
 * is synthetic only (no credentials, no real user data). Regressions are
 * reported per category against the pinned thresholds.
 */

const EVAL_METRICS_VERSION = 1;

/** Categories tracked by the clarification/deflection evaluation. */
type EvalCategory = 'ambiguous-amount' | 'unsupported-payout-destination' | 'policy-denied-action';

interface EvalThreshold {
  /** Minimum fraction of cases that must be handled correctly (0..1). */
  minPassRate: number;
}

/** Versioned thresholds per category. Bump EVAL_METRICS_VERSION on change. */
const EVAL_THRESHOLDS: Record<EvalCategory, EvalThreshold> = {
  'ambiguous-amount': { minPassRate: 1 },
  'unsupported-payout-destination': { minPassRate: 1 },
  'policy-denied-action': { minPassRate: 1 },
};

interface EvalCase {
  /** Synthetic prompt; never contains credentials or real user data. */
  prompt: string;
  locale: string;
  /** Expected outcome: withhold for clarification, or deflect (deny). */
  expect: 'clarify' | 'deflect';
}

interface EvalCategorySpec {
  category: EvalCategory;
  cases: EvalCase[];
}

/** Synthetic evaluation fixtures — no credentials or real user data. */
const EVAL_CATEGORIES: EvalCategorySpec[] = [
  {
    category: 'ambiguous-amount',
    cases: [
      { prompt: 'send 10 $', locale: 'en-US', expect: 'clarify' },
      { prompt: 'envoyer 10 $', locale: 'fr-FR', expect: 'clarify' },
      { prompt: 'enviar 10 $', locale: 'es-ES', expect: 'clarify' },
      { prompt: 'send USDC', locale: 'en-US', expect: 'clarify' },
    ],
  },
  {
    category: 'unsupported-payout-destination',
    cases: [
      { prompt: 'send 10 USDC to bank account 0000', locale: 'en-US', expect: 'deflect' },
      { prompt: 'payout 5 XLM to paypal', locale: 'en-US', expect: 'deflect' },
    ],
  },
  {
    category: 'policy-denied-action',
    cases: [
      { prompt: 'send 10 USDC to sanctioned address', locale: 'en-US', expect: 'deflect' },
      { prompt: 'swap 1 XLM to USDC bypassing limits', locale: 'en-US', expect: 'deflect' },
    ],
  },
];

/**
 * Classify a synthetic prompt into an expected handling decision. This is a
 * deterministic offline classifier used only for evaluation — it never
 * executes tools or touches the network.
 */
function classifyForEval(prompt: string, locale: string): 'clarify' | 'deflect' | 'allow' {
  const lower = prompt.toLowerCase();
  if (/sanctioned|bypass|paypal|bank account/.test(lower)) return 'deflect';
  const intent = evaluateIntent(prompt, locale);
  if (intent.needsClarification) return 'clarify';
  return 'allow';
}

interface CategoryReport {
  category: EvalCategory;
  total: number;
  passed: number;
  passRate: number;
  threshold: number;
  regressed: boolean;
}

/**
 * Run the versioned clarification/deflection evaluation and report regressions
 * per category against the pinned thresholds.
 */
function runClarificationEvaluations(): { version: number; reports: CategoryReport[]; regressed: boolean } {
  const reports: CategoryReport[] = [];

  for (const spec of EVAL_CATEGORIES) {
    let passed = 0;
    for (const c of spec.cases) {
      const decision = classifyForEval(c.prompt, c.locale);
      if (decision === c.expect) {
        passed++;
      } else {
        // Diagnostics: category + locale only, never the raw prompt.
        console.error(`❌ category=${spec.category} locale=${c.locale} expected=${c.expect} got=${decision}`);
      }
    }
    const total = spec.cases.length;
    const passRate = total === 0 ? 1 : passed / total;
    const threshold = EVAL_THRESHOLDS[spec.category].minPassRate;
    reports.push({
      category: spec.category,
      total,
      passed,
      passRate,
      threshold,
      regressed: passRate < threshold,
    });
  }

  return {
    version: EVAL_METRICS_VERSION,
    reports,
    regressed: reports.some((r) => r.regressed),
  };
}

/**
 * Deterministic conversation replay for incident debugging.
 *
 * Traces record versioned state transitions, tool names, normalized arguments,
 * policy decisions, and outcome codes with sensitive values redacted. Replay
 * runs against a pinned model/policy fixture and never executes external or
 * write tools — it only compares recorded vs. replayed decisions.
 */

const TRACE_SCHEMA_VERSION = 1;

/** Keys whose values are always redacted from recorded traces. */
const SENSITIVE_KEYS = new Set([
  'secret',
  'secretkey',
  'privatekey',
  'seed',
  'mnemonic',
  'password',
  'token',
  'apikey',
  'authorization',
  'signature',
]);

/** Tools that must never execute during replay (external or write side effects). */
const NON_REPLAYABLE_TOOLS = new Set([
  'submit_transaction',
  'sign_transaction',
  'send_payment',
  'swap',
  'invoke_contract',
  'http_request',
]);

interface TraceStep {
  /** Monotonic state transition index. */
  seq: number;
  /** Versioned state label, e.g. "intent.parsed". */
  state: string;
  /** Tool name selected by routing, if any. */
  tool: string | null;
  /** Normalized (redacted) tool arguments. */
  args: Record<string, unknown>;
  /** Policy decision, e.g. "allow" | "deny" | "clarify". */
  policy: string;
  /** Outcome code, e.g. "ok" | "denied" | "needs_clarification". */
  outcome: string;
}

interface ConversationTrace {
  schemaVersion: number;
  /** Pinned model/policy fixture identifier used for deterministic replay. */
  fixture: string;
  steps: TraceStep[];
}

/** Recursively redact sensitive values from a normalized argument object. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

/** Build a versioned, redacted trace step from a live decision. */
function recordStep(
  seq: number,
  state: string,
  tool: string | null,
  args: Record<string, unknown>,
  policy: string,
  outcome: string,
): TraceStep {
  return {
    seq,
    state,
    tool,
    args: redact(args) as Record<string, unknown>,
    policy,
    outcome,
  };
}

/**
 * Replay a trace against a pinned fixture. Returns divergence reports without
 * executing any tool. A step diverges when its recorded decision differs from
 * the fixture's expected decision for the same state transition.
 */
function replayTrace(
  trace: ConversationTrace,
  fixture: ConversationTrace,
): { divergences: string[]; executed: number } {
  const divergences: string[] = [];
  let executed = 0;

  if (trace.schemaVersion !== fixture.schemaVersion) {
    divergences.push(`schema-version mismatch: ${trace.schemaVersion} != ${fixture.schemaVersion}`);
  }

  const fixtureBySeq = new Map(fixture.steps.map((s) => [s.seq, s]));
  for (const step of trace.steps) {
    if (step.tool && NON_REPLAYABLE_TOOLS.has(step.tool)) {
      divergences.push(`seq=${step.seq} non-replayable tool=${step.tool}`);
      continue;
    }
    const expected = fixtureBySeq.get(step.seq);
    if (!expected) {
      divergences.push(`seq=${step.seq} missing fixture step`);
      continue;
    }
    if (expected.policy !== step.policy || expected.outcome !== step.outcome) {
      divergences.push(
        `seq=${step.seq} decision mismatch: policy ${step.policy}->${expected.policy} outcome ${step.outcome}->${expected.outcome}`,
      );
    }
    executed++;
  }

  return { divergences, executed };
}
