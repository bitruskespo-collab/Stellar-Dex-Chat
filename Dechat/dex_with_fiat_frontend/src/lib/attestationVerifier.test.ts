import { describe, expect, it } from 'vitest';
import {
  isAttestationValid,
  SLSA_PROVENANCE_V1,
  SLSA_PROVENANCE_V02,
  verifyAttestation,
  verifyAttestationJsonl,
} from './attestationVerifier';

// ── Fixture helpers ────────────────────────────────────────────────────────

const REPO = 'bitruskespo-collab/Stellar-Dex-Chat';
const WASM_DIGEST_HEX =
  'a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2';
const COMMIT_SHA = 'deadbeef1234567890abcdef1234567890abcdef';
const WORKFLOW_PATH = '.github/workflows/signed-attestations.yml';

/** Build a minimal valid SLSA v1 in-toto statement. */
function makeStatement(overrides: Record<string, unknown> = {}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: SLSA_PROVENANCE_V1,
    subject: [
      {
        name: 'stellar_contracts.optimized.wasm',
        digest: { sha256: WASM_DIGEST_HEX },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa.dev/provenance/v1',
        externalParameters: {
          workflow: {
            repository: `git+https://github.com/${REPO}`,
            path: WORKFLOW_PATH,
            ref: 'refs/heads/main',
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${REPO}@refs/heads/main`,
            digest: { gitCommit: COMMIT_SHA },
          },
        ],
      },
      runDetails: {
        builder: {
          id: 'https://github.com/actions/runner',
        },
        metadata: {
          invocationId: `https://github.com/${REPO}/actions/runs/12345`,
        },
      },
    },
    ...overrides,
  };
}

/** Encode a statement as a DSSE bundle. */
function makeBundle(
  statement: object = makeStatement(),
  withSigs = true,
): object {
  const payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
    dsseEnvelope: {
      payload,
      payloadType: 'application/vnd.in-toto+json',
      ...(withSigs
        ? { signatures: [{ sig: 'fakeSigBase64==', keyid: '' }] }
        : { signatures: [] }),
    },
  };
}

function makeJsonl(bundles: object[]): string {
  return bundles.map((b) => JSON.stringify(b)).join('\n');
}

// ── 1. Happy path ──────────────────────────────────────────────────────────

describe('verifyAttestation — happy path', () => {
  it('returns ok:true for a fully valid SLSA v1 bundle', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedDigest: `sha256:${WASM_DIGEST_HEX}`,
      expectedRepo: REPO,
      expectedSha: COMMIT_SHA,
      expectedWorkflow: WORKFLOW_PATH,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.statement).not.toBeNull();
  });

  it('returns ok:true with no options (structural check only)', async () => {
    const result = await verifyAttestation(makeBundle());
    expect(result.ok).toBe(true);
  });

  it('accepts SLSA v0.2 predicate type', async () => {
    const stmt = makeStatement({ predicateType: SLSA_PROVENANCE_V02 });
    const result = await verifyAttestation(makeBundle(stmt), {
      acceptedPredicateTypes: [SLSA_PROVENANCE_V02],
    });
    expect(result.ok).toBe(true);
  });

  it('short commit SHA prefix still matches', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedSha: 'deadbeef',
    });
    const shaCheck = result.checks.find((c) => c.name === 'source-revision');
    expect(shaCheck?.passed).toBe(true);
  });

  it('digest without sha256: prefix is normalised', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedDigest: WASM_DIGEST_HEX, // no prefix
    });
    const digestCheck = result.checks.find(
      (c) => c.name === 'subject-digest-match',
    );
    expect(digestCheck?.passed).toBe(true);
  });

  it('populates statement field on success', async () => {
    const result = await verifyAttestation(makeBundle());
    expect(result.statement?.predicateType).toBe(SLSA_PROVENANCE_V1);
    expect(result.statement?.subject).toHaveLength(1);
  });

  it('reports all checks individually', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedDigest: `sha256:${WASM_DIGEST_HEX}`,
      expectedRepo: REPO,
      expectedSha: COMMIT_SHA,
      expectedWorkflow: WORKFLOW_PATH,
    });
    const names = result.checks.map((c) => c.name);
    expect(names).toContain('bundle-structure');
    expect(names).toContain('dsse-payload-present');
    expect(names).toContain('statement-parseable');
    expect(names).toContain('predicate-type');
    expect(names).toContain('subject-present');
    expect(names).toContain('subject-digest-match');
    expect(names).toContain('repository-claim');
    expect(names).toContain('source-revision');
    expect(names).toContain('workflow-path');
    expect(names).toContain('signatures-present');
  });
});

// ── 2. Bundle structure failures ───────────────────────────────────────────

describe('verifyAttestation — bundle structure failures', () => {
  it('fails when bundle is null', async () => {
    const result = await verifyAttestation(null);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('bundle-structure'))).toBe(
      true,
    );
  });

  it('fails when bundle is a string', async () => {
    const result = await verifyAttestation('not-an-object');
    expect(result.ok).toBe(false);
  });

  it('fails when bundle is a number', async () => {
    const result = await verifyAttestation(42);
    expect(result.ok).toBe(false);
  });

  it('fails when dsseEnvelope.payload is missing', async () => {
    const result = await verifyAttestation({
      dsseEnvelope: { payloadType: 'application/vnd.in-toto+json' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('dsse-payload-present'))).toBe(
      true,
    );
  });

  it('fails when payload is an empty string', async () => {
    const result = await verifyAttestation({ dsseEnvelope: { payload: '' } });
    expect(result.ok).toBe(false);
  });

  it('fails when payload is not valid base64 JSON', async () => {
    const result = await verifyAttestation({
      dsseEnvelope: { payload: 'not-base64-json!!!' },
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('statement-parseable')),
    ).toBe(true);
  });
});

// ── 3. Predicate type ──────────────────────────────────────────────────────

describe('verifyAttestation — predicate type', () => {
  it('fails for an unknown predicate type', async () => {
    const stmt = makeStatement({
      predicateType: 'https://unknown.example/provenance/v99',
    });
    const result = await verifyAttestation(makeBundle(stmt));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('predicate-type'))).toBe(true);
  });

  it('succeeds when custom acceptedPredicateTypes includes the type', async () => {
    const customType = 'https://my-org.example/provenance/v1';
    const stmt = makeStatement({ predicateType: customType });
    const result = await verifyAttestation(makeBundle(stmt), {
      acceptedPredicateTypes: [customType],
    });
    expect(result.ok).toBe(true);
  });
});

// ── 4. Subject digest ──────────────────────────────────────────────────────

describe('verifyAttestation — subject digest', () => {
  it('fails when digest does not match', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('subject-digest-match')),
    ).toBe(true);
  });

  it('fails when statement has no subjects', async () => {
    const stmt = makeStatement({ subject: [] });
    const result = await verifyAttestation(makeBundle(stmt), {
      expectedDigest: `sha256:${WASM_DIGEST_HEX}`,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('subject-present'))).toBe(
      true,
    );
  });

  it('succeeds with multiple subjects when one matches', async () => {
    const other = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const stmt = makeStatement({
      subject: [
        { name: 'other-artifact', digest: { sha256: other } },
        {
          name: 'stellar_contracts.optimized.wasm',
          digest: { sha256: WASM_DIGEST_HEX },
        },
      ],
    });
    const result = await verifyAttestation(makeBundle(stmt), {
      expectedDigest: `sha256:${WASM_DIGEST_HEX}`,
    });
    const digestCheck = result.checks.find(
      (c) => c.name === 'subject-digest-match',
    );
    expect(digestCheck?.passed).toBe(true);
  });
});

// ── 5. Repository claim ────────────────────────────────────────────────────

describe('verifyAttestation — repository claim', () => {
  it('fails when repo does not match', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedRepo: 'other-org/other-repo',
    });
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('repository-claim')),
    ).toBe(true);
  });

  it('passes when repo is a substring of a full github URL', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedRepo: REPO,
    });
    const repoCheck = result.checks.find((c) => c.name === 'repository-claim');
    expect(repoCheck?.passed).toBe(true);
  });

  it('gracefully handles missing repo claim in predicate', async () => {
    const stmt = makeStatement({
      predicate: { buildDefinition: {}, runDetails: {} },
    });
    const result = await verifyAttestation(makeBundle(stmt), {
      expectedRepo: REPO,
    });
    // Check should fail (not found), not throw
    expect(result.ok).toBe(false);
    expect(() => result.checks).not.toThrow();
  });
});

// ── 6. Source revision ─────────────────────────────────────────────────────

describe('verifyAttestation — source revision', () => {
  it('fails when SHA is not in predicate', async () => {
    const stmt = makeStatement({
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: `git+https://github.com/${REPO}`,
              path: WORKFLOW_PATH,
            },
          },
          resolvedDependencies: [], // empty — no SHA
        },
        runDetails: {},
      },
    });
    const result = await verifyAttestation(makeBundle(stmt), {
      expectedSha: COMMIT_SHA,
    });
    const shaCheck = result.checks.find((c) => c.name === 'source-revision');
    expect(shaCheck?.passed).toBe(false);
  });

  it('passes when SHA appears nested deep in predicate', async () => {
    // The SHA is embedded inside a string value that also contains other chars
    const stmt = makeStatement({
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: `git+https://github.com/${REPO}`,
              path: WORKFLOW_PATH,
            },
          },
          resolvedDependencies: [
            {
              uri: `git+https://github.com/${REPO}@refs/heads/main`,
              digest: { gitCommit: COMMIT_SHA },
            },
          ],
        },
      },
    });
    const result = await verifyAttestation(makeBundle(stmt), {
      expectedSha: COMMIT_SHA.slice(0, 8), // short prefix
    });
    const shaCheck = result.checks.find((c) => c.name === 'source-revision');
    expect(shaCheck?.passed).toBe(true);
  });
});

// ── 7. Workflow path ───────────────────────────────────────────────────────

describe('verifyAttestation — workflow path', () => {
  it('fails when workflow path does not match', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedWorkflow: '.github/workflows/other-workflow.yml',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('workflow-path'))).toBe(true);
  });

  it('passes with an exact match', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedWorkflow: WORKFLOW_PATH,
    });
    const wfCheck = result.checks.find((c) => c.name === 'workflow-path');
    expect(wfCheck?.passed).toBe(true);
  });

  it('passes with a partial path match', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedWorkflow: 'signed-attestations',
    });
    const wfCheck = result.checks.find((c) => c.name === 'workflow-path');
    expect(wfCheck?.passed).toBe(true);
  });
});

// ── 8. Signatures ──────────────────────────────────────────────────────────

describe('verifyAttestation — signatures', () => {
  it('fails the signatures check when signatures array is empty', async () => {
    const result = await verifyAttestation(makeBundle(makeStatement(), false));
    const sigCheck = result.checks.find((c) => c.name === 'signatures-present');
    expect(sigCheck?.passed).toBe(false);
    // Signatures absence is a check failure but the detail should guide user
    expect(sigCheck?.detail).toMatch(/gh attestation verify/);
  });

  it('passes when signatures are present', async () => {
    const result = await verifyAttestation(makeBundle(makeStatement(), true));
    const sigCheck = result.checks.find((c) => c.name === 'signatures-present');
    expect(sigCheck?.passed).toBe(true);
  });
});

// ── 9. JSONL multi-envelope ────────────────────────────────────────────────

describe('verifyAttestationJsonl', () => {
  it('verifies a single-line bundle', async () => {
    const jsonl = makeJsonl([makeBundle()]);
    const result = await verifyAttestationJsonl(jsonl, {
      expectedDigest: `sha256:${WASM_DIGEST_HEX}`,
      expectedRepo: REPO,
    });
    expect(result.ok).toBe(true);
    expect(result.envelopeCount).toBe(1);
  });

  it('fails on empty jsonl', async () => {
    const result = await verifyAttestationJsonl('');
    expect(result.ok).toBe(false);
    expect(result.envelopeCount).toBe(0);
    expect(result.errors.some((e) => e.includes('bundle-not-empty'))).toBe(
      true,
    );
  });

  it('fails when any envelope fails', async () => {
    // First envelope: valid; second: broken payload
    const badBundle = { dsseEnvelope: { payload: '' } };
    const jsonl = makeJsonl([makeBundle(), badBundle]);
    const result = await verifyAttestationJsonl(jsonl);
    expect(result.ok).toBe(false);
    expect(result.envelopeCount).toBe(2);
  });

  it('accumulates checks from all envelopes', async () => {
    const jsonl = makeJsonl([makeBundle(), makeBundle()]);
    const result = await verifyAttestationJsonl(jsonl);
    // Each envelope contributes its own check set
    expect(result.checks.length).toBeGreaterThan(10);
  });

  it('handles trailing newline gracefully', async () => {
    const jsonl = makeJsonl([makeBundle()]) + '\n\n';
    const result = await verifyAttestationJsonl(jsonl);
    expect(result.ok).toBe(true);
    expect(result.envelopeCount).toBe(1);
  });

  it('fails when a line is not valid JSON', async () => {
    const jsonl = JSON.stringify(makeBundle()) + '\nnot-json-at-all';
    const result = await verifyAttestationJsonl(jsonl);
    expect(result.ok).toBe(false);
  });
});

// ── 10. isAttestationValid helper ─────────────────────────────────────────

describe('isAttestationValid', () => {
  it('returns true for a valid bundle', async () => {
    expect(await isAttestationValid(makeBundle())).toBe(true);
  });

  it('returns false for a null bundle', async () => {
    expect(await isAttestationValid(null)).toBe(false);
  });

  it('returns false when digest does not match', async () => {
    expect(
      await isAttestationValid(makeBundle(), {
        expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).toBe(false);
  });
});

// ── 11. Edge cases ─────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('falls back to top-level payload field if dsseEnvelope absent', async () => {
    const payload = Buffer.from(
      JSON.stringify(makeStatement()),
    ).toString('base64');
    const bundle = { payload, payloadType: 'application/vnd.in-toto+json' };
    const result = await verifyAttestation(bundle);
    // structural checks pass (no sigs in this form)
    const payloadCheck = result.checks.find(
      (c) => c.name === 'dsse-payload-present',
    );
    expect(payloadCheck?.passed).toBe(true);
  });

  it('does not throw on a deeply nested empty predicate', async () => {
    const stmt = makeStatement({ predicate: {} });
    await expect(verifyAttestation(makeBundle(stmt))).resolves.toBeDefined();
  });

  it('errors array is empty on full success', async () => {
    const result = await verifyAttestation(makeBundle(), {
      expectedDigest: `sha256:${WASM_DIGEST_HEX}`,
      expectedRepo: REPO,
      expectedSha: COMMIT_SHA,
      expectedWorkflow: WORKFLOW_PATH,
    });
    expect(result.errors).toHaveLength(0);
  });

  it('errors array contains one entry per failing check', async () => {
    // Three things wrong: bad digest, bad repo, bad workflow
    const result = await verifyAttestation(makeBundle(), {
      expectedDigest: 'sha256:' + '0'.repeat(64),
      expectedRepo: 'wrong-org/wrong-repo',
      expectedWorkflow: 'wrong-workflow.yml',
    });
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
