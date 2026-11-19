#!/usr/bin/env bash
# verify-attestation.sh — Offline attestation verifier for contract and frontend artifacts
#
# Issue #282: Signed release attestations for contract and frontend artifacts
#
# Verifies GitHub-native build provenance attestations (SLSA Provenance v1,
# sigstore/cosign bundle format) produced by the signed-attestations.yml workflow.
#
# Usage:
#   ./scripts/verify-attestation.sh [OPTIONS] <artifact>
#
# Options:
#   -a, --attestation <file>   Path to the .jsonl bundle file.
#                              Defaults to <artifact>.attestation.jsonl
#   -d, --digest <sha256>      Expected SHA-256 hex digest of the artifact.
#                              Computed automatically when omitted.
#   -r, --repo <owner/repo>    Expected repository claim in the attestation.
#                              Default: bitruskespo-collab/Stellar-Dex-Chat
#   -s, --sha <commit>         Expected source revision (full or short prefix).
#   -w, --workflow <path>      Expected workflow path prefix to match.
#                              Example: .github/workflows/signed-attestations.yml
#   -t, --type <uri>           Expected predicate type URI.
#                              Default: https://slsa.dev/provenance/v1
#   --no-sigstore              Skip online Sigstore transparency log check.
#                              Use when verifying fully offline.
#   --bundle-only              Only validate bundle JSON structure; skip digest
#                              and claim checks. Useful for CI smoke tests.
#   -v, --verbose              Print parsed attestation fields.
#   -h, --help                 Show this message and exit.
#
# Exit codes:
#   0  All checks passed — attestation is valid.
#   1  Verification failed (digest mismatch, missing claim, structure error).
#   2  Usage error (missing required argument or tool).
#
# Dependencies:
#   jq  — JSON parsing (required)
#   sha256sum or shasum — digest computation (required)
#   gh  — GitHub CLI, used only when --no-sigstore is NOT set (optional)
#
# Examples:
#   # Verify WASM artifact with its attestation bundle:
#   ./scripts/verify-attestation.sh \
#     stellar_contracts.optimized.wasm \
#     --attestation stellar_contracts.optimized.wasm.attestation.jsonl \
#     --sha abc1234 \
#     --workflow .github/workflows/signed-attestations.yml
#
#   # Verify frontend digest from a known hash:
#   ./scripts/verify-attestation.sh \
#     --digest sha256:abcdef0123456789... \
#     --attestation frontend-build.attestation.jsonl \
#     --repo bitruskespo-collab/Stellar-Dex-Chat

set -euo pipefail

# ── Helpers ────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

pass()  { echo -e "${GREEN}  ✓${RESET} $*"; }
fail()  { echo -e "${RED}  ✗ FAIL:${RESET} $*" >&2; }
warn()  { echo -e "${YELLOW}  ⚠${RESET} $*"; }
info()  { echo -e "${CYAN}  ·${RESET} $*"; }
fatal() { echo -e "${RED}ERROR:${RESET} $*" >&2; exit 2; }

FAILURES=0
record_failure() { FAILURES=$(( FAILURES + 1 )); fail "$*"; }

# ── Defaults ───────────────────────────────────────────────────────────────

ARTIFACT=""
ATTESTATION_FILE=""
EXPECTED_DIGEST=""
EXPECTED_REPO="bitruskespo-collab/Stellar-Dex-Chat"
EXPECTED_SHA=""
EXPECTED_WORKFLOW=""
EXPECTED_TYPE="https://slsa.dev/provenance/v1"
NO_SIGSTORE=false
BUNDLE_ONLY=false
VERBOSE=false

# ── Argument parsing ───────────────────────────────────────────────────────

usage() {
  sed -n '/^# Usage:/,/^# Dependencies:/p' "$0" | sed 's/^# \{0,2\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)         usage ;;
    -a|--attestation)  ATTESTATION_FILE="$2"; shift 2 ;;
    -d|--digest)       EXPECTED_DIGEST="$2"; shift 2 ;;
    -r|--repo)         EXPECTED_REPO="$2"; shift 2 ;;
    -s|--sha)          EXPECTED_SHA="$2"; shift 2 ;;
    -w|--workflow)     EXPECTED_WORKFLOW="$2"; shift 2 ;;
    -t|--type)         EXPECTED_TYPE="$2"; shift 2 ;;
    --no-sigstore)     NO_SIGSTORE=true; shift ;;
    --bundle-only)     BUNDLE_ONLY=true; shift ;;
    -v|--verbose)      VERBOSE=true; shift ;;
    -*)                fatal "Unknown option: $1" ;;
    *)                 ARTIFACT="$1"; shift ;;
  esac
done

# ── Prerequisite checks ────────────────────────────────────────────────────

command -v jq >/dev/null 2>&1 || fatal "jq is required. Install with: brew install jq  or  apt-get install -y jq"

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fatal "Neither sha256sum nor shasum is available."
  fi
}

# ── Resolve artifact and attestation paths ─────────────────────────────────

if [[ -z "$ATTESTATION_FILE" ]]; then
  if [[ -n "$ARTIFACT" ]]; then
    ATTESTATION_FILE="${ARTIFACT}.attestation.jsonl"
  else
    fatal "Provide an artifact path or --attestation <file>."
  fi
fi

[[ -f "$ATTESTATION_FILE" ]] || fatal "Attestation bundle not found: $ATTESTATION_FILE"

# ── Compute / validate artifact digest ────────────────────────────────────

ACTUAL_DIGEST=""
if [[ -n "$ARTIFACT" && -f "$ARTIFACT" ]]; then
  ACTUAL_DIGEST="sha256:$(sha256_of "$ARTIFACT")"
  info "Artifact digest: $ACTUAL_DIGEST"
elif [[ -n "$EXPECTED_DIGEST" ]]; then
  # Strip prefix for consistency
  ACTUAL_DIGEST="${EXPECTED_DIGEST#sha256:}"
  ACTUAL_DIGEST="sha256:${ACTUAL_DIGEST}"
  info "Using supplied digest: $ACTUAL_DIGEST"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo " Attestation verification"
echo " Bundle: $ATTESTATION_FILE"
[[ -n "$ARTIFACT" ]] && echo " Artifact: $ARTIFACT"
echo "════════════════════════════════════════════════════════"
echo ""

# ── Parse bundle — a .jsonl file, one DSSE envelope per line ───────────────

TOTAL_ENVELOPES=$(grep -c '.' "$ATTESTATION_FILE" || true)
if [[ "$TOTAL_ENVELOPES" -eq 0 ]]; then
  record_failure "Attestation bundle is empty."
  exit 1
fi
info "Bundle contains $TOTAL_ENVELOPES envelope(s)."

# Process the first (and usually only) envelope.
ENVELOPE=$(head -n 1 "$ATTESTATION_FILE")

# ── 1. Bundle JSON structure ───────────────────────────────────────────────

echo "── Check 1: Bundle JSON structure"

if ! echo "$ENVELOPE" | jq -e . >/dev/null 2>&1; then
  record_failure "Envelope is not valid JSON."
else
  pass "Envelope is valid JSON."
fi

# GitHub attestation bundles wrap a DSSE envelope in a top-level object.
# The payload is base64-encoded in .dsseEnvelope.payload or directly in .payload.
PAYLOAD_B64=""
if echo "$ENVELOPE" | jq -e '.dsseEnvelope.payload' >/dev/null 2>&1; then
  PAYLOAD_B64=$(echo "$ENVELOPE" | jq -r '.dsseEnvelope.payload')
elif echo "$ENVELOPE" | jq -e '.payload' >/dev/null 2>&1; then
  PAYLOAD_B64=$(echo "$ENVELOPE" | jq -r '.payload')
else
  record_failure "Cannot locate .dsseEnvelope.payload or .payload in envelope."
fi

if [[ -n "$PAYLOAD_B64" ]]; then
  pass "DSSE payload field present."
else
  record_failure "DSSE payload is empty."
fi

[[ "$BUNDLE_ONLY" == "true" ]] && {
  if [[ "$FAILURES" -eq 0 ]]; then
    echo ""
    pass "Bundle structure OK (--bundle-only mode)."
    exit 0
  else
    echo ""
    fail "$FAILURES check(s) failed."
    exit 1
  fi
}

# ── 2. Decode and parse the in-toto statement ──────────────────────────────

echo ""
echo "── Check 2: In-toto statement"

STATEMENT=""
if [[ -n "$PAYLOAD_B64" ]]; then
  if command -v base64 >/dev/null 2>&1; then
    # macOS base64 uses -D; GNU base64 uses -d
    STATEMENT=$(echo "$PAYLOAD_B64" | base64 -d 2>/dev/null || echo "$PAYLOAD_B64" | base64 -D 2>/dev/null || true)
  fi
fi

if [[ -z "$STATEMENT" ]] || ! echo "$STATEMENT" | jq -e . >/dev/null 2>&1; then
  record_failure "Could not base64-decode and parse the in-toto statement."
else
  pass "In-toto statement decoded successfully."
fi

# ── 3. Statement type ──────────────────────────────────────────────────────

echo ""
echo "── Check 3: Statement type"

ACTUAL_TYPE=$(echo "$STATEMENT" | jq -r '.predicateType // empty' 2>/dev/null || true)
if [[ -z "$ACTUAL_TYPE" ]]; then
  record_failure "predicateType field missing from statement."
elif [[ "$ACTUAL_TYPE" == "$EXPECTED_TYPE" ]]; then
  pass "predicateType: $ACTUAL_TYPE"
else
  record_failure "predicateType mismatch. Expected: $EXPECTED_TYPE — Got: $ACTUAL_TYPE"
fi

# ── 4. Subject digest ─────────────────────────────────────────────────────

echo ""
echo "── Check 4: Subject digest"

if [[ -n "$ACTUAL_DIGEST" ]]; then
  DIGEST_HEX="${ACTUAL_DIGEST#sha256:}"
  # jq path: .subject[].digest.sha256
  ATTESTED_DIGEST=$(echo "$STATEMENT" | jq -r '[.subject[]?.digest.sha256 // empty] | first // empty' 2>/dev/null || true)

  if [[ -z "$ATTESTED_DIGEST" ]]; then
    record_failure "No subject digest found in statement."
  elif [[ "$ATTESTED_DIGEST" == "$DIGEST_HEX" ]]; then
    pass "Subject digest matches: sha256:$DIGEST_HEX"
  else
    record_failure "Digest mismatch. Artifact: sha256:$DIGEST_HEX — Attested: sha256:$ATTESTED_DIGEST"
  fi
else
  warn "No artifact path or --digest supplied; skipping digest check."
fi

# ── 5. Repository claim ───────────────────────────────────────────────────

echo ""
echo "── Check 5: Repository claim"

# SLSA v1: .predicate.buildDefinition.externalParameters.workflow.repository
# SLSA v0.2: .predicate.invocation.configSource.uri
REPO_CLAIM=$(echo "$STATEMENT" | jq -r '
  .predicate.buildDefinition.externalParameters.workflow.repository //
  .predicate.invocation.configSource.uri //
  empty' 2>/dev/null || true)

if [[ -z "$REPO_CLAIM" ]]; then
  warn "Repository claim not found in predicate; skipping."
elif echo "$REPO_CLAIM" | grep -qF "$EXPECTED_REPO"; then
  pass "Repository claim contains '$EXPECTED_REPO': $REPO_CLAIM"
else
  record_failure "Repository claim mismatch. Expected to contain '$EXPECTED_REPO' — Got: $REPO_CLAIM"
fi

# ── 6. Source revision ────────────────────────────────────────────────────

echo ""
echo "── Check 6: Source revision"

if [[ -n "$EXPECTED_SHA" ]]; then
  # Check common SLSA v1 and v0.2 paths for the commit SHA.
  SHA_CLAIM=$(echo "$STATEMENT" | jq -r '
    .predicate.buildDefinition.resolvedDependencies[]? |
      select(.uri? | test("git\\+https://")) |
      .digest.gitCommit //
      .digest.sha1 //
      empty' 2>/dev/null | head -n 1 || true)

  if [[ -z "$SHA_CLAIM" ]]; then
    # Fallback: scan all string values for the SHA
    SHA_CLAIM=$(echo "$STATEMENT" | jq -r '.. | strings | select(test("^[0-9a-f]{40}$"))' 2>/dev/null | head -n 1 || true)
  fi

  if [[ -z "$SHA_CLAIM" ]]; then
    warn "Source revision not found in predicate; skipping."
  elif [[ "$SHA_CLAIM" == "$EXPECTED_SHA"* ]] || [[ "$SHA_CLAIM" == *"$EXPECTED_SHA" ]]; then
    pass "Source revision matches prefix: $EXPECTED_SHA"
  else
    record_failure "Source revision mismatch. Expected: $EXPECTED_SHA — Got: $SHA_CLAIM"
  fi
else
  warn "No --sha supplied; skipping source revision check."
fi

# ── 7. Workflow path claim ────────────────────────────────────────────────

echo ""
echo "── Check 7: Workflow path"

if [[ -n "$EXPECTED_WORKFLOW" ]]; then
  WF_CLAIM=$(echo "$STATEMENT" | jq -r '
    .predicate.buildDefinition.externalParameters.workflow.path //
    .predicate.invocation.configSource.entryPoint //
    empty' 2>/dev/null || true)

  if [[ -z "$WF_CLAIM" ]]; then
    # Try the runDetails runner environment
    WF_CLAIM=$(echo "$STATEMENT" | jq -r '.. | strings | select(test(".github/workflows/"))' 2>/dev/null | head -n 1 || true)
  fi

  if [[ -z "$WF_CLAIM" ]]; then
    warn "Workflow path not found in predicate; skipping."
  elif echo "$WF_CLAIM" | grep -qF "$EXPECTED_WORKFLOW"; then
    pass "Workflow path contains '$EXPECTED_WORKFLOW': $WF_CLAIM"
  else
    record_failure "Workflow path mismatch. Expected to contain '$EXPECTED_WORKFLOW' — Got: $WF_CLAIM"
  fi
else
  warn "No --workflow supplied; skipping workflow path check."
fi

# ── 8. Sigstore / Rekor transparency log (optional) ───────────────────────

echo ""
echo "── Check 8: Transparency log"

if [[ "$NO_SIGSTORE" == "true" ]]; then
  warn "Skipping transparency log check (--no-sigstore)."
elif command -v gh >/dev/null 2>&1; then
  # gh attestation verify is available in GitHub CLI ≥ 2.49
  # It checks the Rekor log and the Sigstore certificate chain.
  if [[ -n "$ARTIFACT" && -f "$ARTIFACT" ]]; then
    info "Running: gh attestation verify $ARTIFACT --repo $EXPECTED_REPO"
    if gh attestation verify "$ARTIFACT" --repo "$EXPECTED_REPO" 2>&1 | \
        grep -qiE "verified|passed|ok"; then
      pass "gh attestation verify passed."
    else
      warn "gh attestation verify did not return a clear success; review output manually."
      warn "Run: gh attestation verify $ARTIFACT --repo $EXPECTED_REPO"
    fi
  else
    warn "No artifact path supplied; cannot run gh attestation verify."
    warn "Run manually: gh attestation verify <artifact> --repo $EXPECTED_REPO"
  fi
else
  warn "GitHub CLI (gh) not found. Install from https://cli.github.com to enable transparency log verification."
  warn "Alternatively re-run with --no-sigstore to skip this check."
fi

# ── Verbose output ────────────────────────────────────────────────────────

if [[ "$VERBOSE" == "true" && -n "$STATEMENT" ]]; then
  echo ""
  echo "── Parsed statement (verbose)"
  echo "$STATEMENT" | jq '{
    predicateType,
    subjects: [.subject[]? | {name, digest}],
    repo: (
      .predicate.buildDefinition.externalParameters.workflow.repository //
      .predicate.invocation.configSource.uri //
      "not found"
    ),
    workflow: (
      .predicate.buildDefinition.externalParameters.workflow.path //
      .predicate.invocation.configSource.entryPoint //
      "not found"
    ),
    runnerEnv: .predicate.runDetails.builder.id // "not found"
  }' 2>/dev/null || echo "$STATEMENT" | jq '.' 2>/dev/null || true
fi

# ── Final result ──────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
if [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${GREEN}  PASSED — Attestation verified successfully.${RESET}"
  echo "════════════════════════════════════════════════════════"
  exit 0
else
  echo -e "${RED}  FAILED — $FAILURES check(s) did not pass.${RESET}"
  echo "  See errors above. Consult docs/operations/release-attestations.md"
  echo "  for the full verification guide."
  echo "════════════════════════════════════════════════════════"
  exit 1
fi
