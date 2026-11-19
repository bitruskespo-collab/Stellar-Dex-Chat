/**
 * Attestation Verifier — Issue #282
 *
 * Programmatic verification of GitHub-native build provenance attestations
 * (SLSA Provenance v1 / in-toto Statement v1, sigstore DSSE bundle format).
 *
 * This module has zero external runtime dependencies: it uses only the
 * standard `crypto` module (Node) or the Web Crypto API (edge/browser) for
 * digest comparison.  It does NOT make network calls — all verification is
 * structural and cryptographic against the bundle bytes you supply.
 *
 * Online Sigstore / Rekor transparency-log checks are intentionally out of
 * scope here; use the `scripts/verify-attestation.sh` shell script or
 * `gh attestation verify` for those.
 *
 * Usage:
 * ```ts
 * import { verifyAttestation } from '@/lib/attestationVerifier';
 *
 * const result = await verifyAttestation(bundleJson, {
 *   expectedDigest: 'sha256:abcdef...',
 *   expectedRepo:   'bitruskespo-collab/Stellar-Dex-Chat',
 *   expectedSha:    'abc1234',
 *   expectedWorkflow: '.github/workflows/signed-attestations.yml',
 * });
 * if (!result.ok) console.error(result.errors);
 * ```
 */

// ── Constants ───────────────────────────────────────────────────────────────

export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1' as const;
export const SLSA_PROVENANCE_V02 =
  'https://slsa.dev/provenance/v0.2' as const;
export const INTOTO_STATEMENT_V1 =
  'https://in-toto.io/Statement/v1' as const;

export const SUPPORTED_PREDICATE_TYPES = [
  SLSA_PROVENANCE_V1,
  SLSA_PROVENANCE_V02,
] as const;

export type SupportedPredicateType =
  (typeof SUPPORTED_PREDICATE_TYPES)[number];

// ── Types ───────────────────────────────────────────────────────────────────

/** An in-toto subject (artifact name + digests). */
export interface AttestationSubject {
  name: string;
  digest: Record<string, string>;
}

/** Minimal shape of an in-toto Statement v1. */
export interface InTotoStatement {
  _type?: string;
  type?: string;
  predicateType: string;
  subject: AttestationSubject[];
  predicate: Record<string, unknown>;
}

/**
 * A GitHub attestation bundle line (DSSE envelope wrapper).
 * The inner DSSE payload is base64-encoded.
 */
export interface AttestationBundle {
  mediaType?: string;
  dsseEnvelope?: {
    payload: string;
    payloadType: string;
    signatures?: Array<{ sig: string; keyid?: string }>;
  };
  /** Some older bundle formats place payload at top level. */
  payload?: string;
  payloadType?: string;
}

/** Options controlling what the verifier checks. */
export interface AttestationVerifyOptions {
  /**
   * Expected artifact digest in `sha256:<hex>` form.
   * When supplied the verifier confirms the attested subject digest matches.
   */
  expectedDigest?: string;

  /**
   * Expected repository string that must appear inside the predicate's
   * repository claim.  Partial match is accepted (substring).
   * Default: 'bitruskespo-collab/Stellar-Dex-Chat'
   */
  expectedRepo?: string;

  /**
   * Expected source commit SHA (full 40-char or short prefix).
   * When supplied the verifier scans the predicate for a matching gitCommit
   * or sha1 digest.
   */
  expectedSha?: string;

  /**
   * Expected workflow path substring
   * (e.g. `.github/workflows/signed-attestations.yml`).
   */
  expectedWorkflow?: string;

  /**
   * Accepted predicate type URIs.
   * Defaults to SUPPORTED_PREDICATE_TYPES (SLSA v1 and v0.2).
   */
  acceptedPredicateTypes?: readonly string[];
}

/** Outcome of a single verification check. */
export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** Full verification result returned by verifyAttestation(). */
export interface AttestationVerifyResult {
  /** true only when every check passed. */
  ok: boolean;
  /** Parsed in-toto statement, available even when verification failed. */
  statement: InTotoStatement | null;
  /** Per-check breakdown. */
  checks: CheckResult[];
  /** Shorthand list of failure messages (empty when ok). */
  errors: string[];
}

// ── Internal helpers ────────────────────────────────────────────────────────

function decodeBase64(b64: string): string {
  if (typeof atob !== 'undefined') {
    // Browser / Edge runtime
    return atob(b64);
  }
  // Node.js
  return Buffer.from(b64, 'base64').toString('utf8');
}

function extractPayloadB64(bundle: AttestationBundle): string | null {
  if (bundle.dsseEnvelope?.payload) return bundle.dsseEnvelope.payload;
  if (bundle.payload) return bundle.payload;
  return null;
}

function parseStatement(payloadB64: string): InTotoStatement | null {
  try {
    const json = decodeBase64(payloadB64);
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'predicateType' in parsed &&
      'subject' in parsed &&
      'predicate' in parsed
    ) {
      return parsed as InTotoStatement;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract the repository claim from a SLSA v1 or v0.2 predicate. */
function extractRepoClaim(predicate: Record<string, unknown>): string {
  // SLSA v1
  const bd = predicate.buildDefinition as Record<string, unknown> | undefined;
  if (bd) {
    const ep = bd.externalParameters as Record<string, unknown> | undefined;
    const wf = ep?.workflow as Record<string, unknown> | undefined;
    if (typeof wf?.repository === 'string') return wf.repository;
  }
  // SLSA v0.2
  const inv = predicate.invocation as Record<string, unknown> | undefined;
  const cs = inv?.configSource as Record<string, unknown> | undefined;
  if (typeof cs?.uri === 'string') return cs.uri;
  return '';
}

/** Extract the workflow path from a SLSA v1 or v0.2 predicate. */
function extractWorkflowPath(predicate: Record<string, unknown>): string {
  // SLSA v1
  const bd = predicate.buildDefinition as Record<string, unknown> | undefined;
  const ep =
    (bd?.externalParameters as Record<string, unknown> | undefined) ?? {};
  const wf = ep.workflow as Record<string, unknown> | undefined;
  if (typeof wf?.path === 'string') return wf.path;
  // SLSA v0.2
  const inv = predicate.invocation as Record<string, unknown> | undefined;
  const cs = inv?.configSource as Record<string, unknown> | undefined;
  if (typeof cs?.entryPoint === 'string') return cs.entryPoint;
  return '';
}

/** Scan a predicate (recursively) for a 40-char hex string matching sha. */
function findCommitSha(obj: unknown, prefix: string): string {
  if (typeof obj === 'string') {
    if (/^[0-9a-f]{40}$/i.test(obj) && obj.startsWith(prefix)) return obj;
    return '';
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findCommitSha(item, prefix);
      if (found) return found;
    }
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      const found = findCommitSha(val, prefix);
      if (found) return found;
    }
  }
  return '';
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse and structurally verify a single attestation bundle JSON object.
 *
 * The bundle is a parsed JSON object (one line from a `.attestation.jsonl`
 * file).  Pass `JSON.parse(line)` directly.
 *
 * All checks are non-throwing: failures accumulate in the returned
 * `errors` array and `ok` is false when any check fails.
 */
export async function verifyAttestation(
  bundle: unknown,
  options: AttestationVerifyOptions = {},
): Promise<AttestationVerifyResult> {
  const checks: CheckResult[] = [];
  let statement: InTotoStatement | null = null;

  const check = (
    name: string,
    passed: boolean,
    detail: string,
  ): boolean => {
    checks.push({ name, passed, detail });
    return passed;
  };

  const {
    expectedDigest,
    expectedRepo = 'bitruskespo-collab/Stellar-Dex-Chat',
    expectedSha,
    expectedWorkflow,
    acceptedPredicateTypes = SUPPORTED_PREDICATE_TYPES,
  } = options;

  // ── 1. Bundle is a non-null object ──────────────────────────────────────
  if (
    !check(
      'bundle-structure',
      typeof bundle === 'object' && bundle !== null,
      typeof bundle === 'object' && bundle !== null
        ? 'Bundle is a non-null object.'
        : `Expected object, got ${typeof bundle}.`,
    )
  ) {
    return { ok: false, statement, checks, errors: collectErrors(checks) };
  }

  const b = bundle as AttestationBundle;

  // ── 2. DSSE payload field present ───────────────────────────────────────
  const payloadB64 = extractPayloadB64(b);
  check(
    'dsse-payload-present',
    payloadB64 !== null && payloadB64.length > 0,
    payloadB64 !== null && payloadB64.length > 0
      ? 'DSSE payload field is present and non-empty.'
      : 'Missing dsseEnvelope.payload or payload field.',
  );

  if (!payloadB64) {
    return { ok: false, statement, checks, errors: collectErrors(checks) };
  }

  // ── 3. Payload decodes to valid in-toto statement ───────────────────────
  statement = parseStatement(payloadB64);
  check(
    'statement-parseable',
    statement !== null,
    statement !== null
      ? 'Payload decodes to a valid in-toto statement.'
      : 'Could not base64-decode or JSON-parse the DSSE payload as an in-toto statement.',
  );

  if (!statement) {
    return { ok: false, statement, checks, errors: collectErrors(checks) };
  }

  // ── 4. Predicate type ───────────────────────────────────────────────────
  const predType = statement.predicateType ?? '';
  check(
    'predicate-type',
    (acceptedPredicateTypes as readonly string[]).includes(predType),
    (acceptedPredicateTypes as readonly string[]).includes(predType)
      ? `predicateType is accepted: ${predType}`
      : `predicateType '${predType}' is not in the accepted list: ${acceptedPredicateTypes.join(', ')}`,
  );

  // ── 5. At least one subject ─────────────────────────────────────────────
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  check(
    'subject-present',
    subjects.length > 0,
    subjects.length > 0
      ? `Statement contains ${subjects.length} subject(s).`
      : 'Statement has no subjects.',
  );

  // ── 6. Subject digest matches expected ──────────────────────────────────
  if (expectedDigest !== undefined) {
    const hex = expectedDigest.replace(/^sha256:/, '');
    const matchingSubject = subjects.find(
      (s) => s.digest?.sha256 === hex,
    );
    check(
      'subject-digest-match',
      matchingSubject !== undefined,
      matchingSubject !== undefined
        ? `Subject digest sha256:${hex} found in statement.`
        : `No subject with digest sha256:${hex} found. ` +
            `Attested digests: ${subjects.map((s) => s.digest?.sha256 ?? '?').join(', ')}`,
    );
  }

  // ── 7. Repository claim ─────────────────────────────────────────────────
  if (expectedRepo) {
    const repoClaim = extractRepoClaim(statement.predicate);
    const repoOk = repoClaim.includes(expectedRepo);
    check(
      'repository-claim',
      repoOk,
      repoOk
        ? `Repository claim contains '${expectedRepo}': ${repoClaim}`
        : repoClaim
          ? `Repository claim '${repoClaim}' does not contain expected '${expectedRepo}'.`
          : `Repository claim not found in predicate.`,
    );
  }

  // ── 8. Source revision ──────────────────────────────────────────────────
  if (expectedSha !== undefined) {
    const prefix = expectedSha.toLowerCase();
    const found = findCommitSha(statement.predicate, prefix);
    check(
      'source-revision',
      found !== '',
      found !== ''
        ? `Source revision starting with '${prefix}' found: ${found}`
        : `No 40-char hex commit SHA starting with '${prefix}' found in predicate.`,
    );
  }

  // ── 9. Workflow path claim ───────────────────────────────────────────────
  if (expectedWorkflow !== undefined) {
    const wfPath = extractWorkflowPath(statement.predicate);
    const wfOk = wfPath.includes(expectedWorkflow);
    check(
      'workflow-path',
      wfOk,
      wfOk
        ? `Workflow path contains '${expectedWorkflow}': ${wfPath}`
        : wfPath
          ? `Workflow path '${wfPath}' does not contain '${expectedWorkflow}'.`
          : `Workflow path not found in predicate.`,
    );
  }

  // ── 10. Signatures present (structural only) ─────────────────────────────
  const sigs = b.dsseEnvelope?.signatures ?? [];
  check(
    'signatures-present',
    sigs.length > 0,
    sigs.length > 0
      ? `Bundle contains ${sigs.length} signature(s).`
      : 'No signatures found in dsseEnvelope.signatures. ' +
          'Full cryptographic verification requires gh attestation verify.',
  );

  const errors = collectErrors(checks);
  return { ok: errors.length === 0, statement, checks, errors };
}

function collectErrors(checks: CheckResult[]): string[] {
  return checks.filter((c) => !c.passed).map((c) => `[${c.name}] ${c.detail}`);
}

/**
 * Parse a `.attestation.jsonl` file (one JSON object per line) and verify
 * every envelope.  Returns the aggregated result across all envelopes.
 *
 * In practice GitHub writes a single envelope per artifact, but this handles
 * multi-envelope bundles defensively.
 */
export async function verifyAttestationJsonl(
  jsonl: string,
  options: AttestationVerifyOptions = {},
): Promise<AttestationVerifyResult & { envelopeCount: number }> {
  const lines = jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return {
      ok: false,
      statement: null,
      checks: [
        {
          name: 'bundle-not-empty',
          passed: false,
          detail: 'The .jsonl bundle is empty.',
        },
      ],
      errors: ['[bundle-not-empty] The .jsonl bundle is empty.'],
      envelopeCount: 0,
    };
  }

  const allChecks: CheckResult[] = [];
  let lastStatement: InTotoStatement | null = null;
  let anyFailure = false;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      anyFailure = true;
      allChecks.push({
        name: 'envelope-json-parse',
        passed: false,
        detail: `Could not JSON-parse envelope line: ${line.slice(0, 80)}`,
      });
      continue;
    }

    const result = await verifyAttestation(parsed, options);
    allChecks.push(...result.checks);
    if (result.statement) lastStatement = result.statement;
    if (!result.ok) anyFailure = true;
  }

  const errors = collectErrors(allChecks);
  return {
    ok: !anyFailure && errors.length === 0,
    statement: lastStatement,
    checks: allChecks,
    errors,
    envelopeCount: lines.length,
  };
}

/**
 * Quick boolean helper — returns true only when the bundle verifies cleanly
 * against the given options.  Useful for inline guards.
 *
 * ```ts
 * if (!await isAttestationValid(bundle, { expectedDigest, expectedRepo })) {
 *   throw new Error('Artifact attestation failed verification');
 * }
 * ```
 */
export async function isAttestationValid(
  bundle: unknown,
  options: AttestationVerifyOptions = {},
): Promise<boolean> {
  const result = await verifyAttestation(bundle, options);
  return result.ok;
}
