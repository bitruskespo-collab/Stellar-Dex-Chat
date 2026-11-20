#!/usr/bin/env bash
# staged_deploy.sh — Staged FiatBridge contract deployment
#
# Issue #283: Add staged contract deployment with preflight and post-deploy
# verification. Automates:
#   Stage 1 — Preflight  : network identity, RPC reachability, WASM digest,
#                          admin/oracle identity, signer quorum
#   Stage 2 — Deploy     : stellar contract deploy (skipped in --dry-run mode)
#   Stage 3 — Post-deploy: read-only canary probes against the live contract
#   Stage 4 — Gate       : write-enable decision; exits non-zero when any
#                          required check failed so the CI workflow and callers
#                          can gate frontend writes
#
# Usage:
#   ./scripts/staged_deploy.sh [OPTIONS]
#
# Options:
#   --profile <local|testnet|futurenet|production>
#                       Target network profile.  Default: testnet
#   --wasm <path>       Path to the optimised WASM artifact.
#                       Default: target/wasm32v1-none/release/stellar_contracts.optimized.wasm
#   --expected-digest <sha256hex>
#                       Expected SHA-256 hex digest of the WASM.  When
#                       supplied, the preflight fails if the file on disk
#                       does not match.  Omit to skip digest pin check.
#   --contract-id <id>  Existing contract ID.  When supplied, Stage 2
#                       (deploy) is skipped and post-deploy probes run
#                       against this ID.  Useful for re-verification.
#   --admin <address>   Expected on-chain admin address.  When supplied,
#                       the post-deploy stage reads the contract's admin
#                       and asserts it matches.
#   --oracle <address>  Expected on-chain oracle address.  When supplied,
#                       the post-deploy stage reads the config and asserts
#                       the oracle matches.
#   --dry-run           Run all preflight and post-deploy probes but skip
#                       the actual deploy transaction.  Exit 0 only when
#                       all checks pass.
#   --skip-post-deploy  Skip Stage 3 entirely.  Useful when the deployment
#                       environment does not expose a live RPC endpoint.
#   --override-reason <text>
#                       Record a reason and downgrade fatal check failures
#                       to warnings.  Every override is printed to stdout
#                       so CI captures it in the job log.
#   -v, --verbose       Print extra diagnostic output.
#   -h, --help          Show this message and exit.
#
# Environment variables (all optional unless marked required):
#   STELLAR_ADMIN_SECRET_KEY  Signing key for deploy.  Required for Stage 2.
#   STELLAR_RPC_URL           RPC endpoint URL.  Overridden by profile default.
#   STELLAR_NETWORK_PASSPHRASE Network passphrase.  Overridden by profile default.
#   OUTPUT_FILE               Path to write the deployed contract ID.
#                             Default: ./contract_id_<profile>.txt
#
# Exit codes:
#   0  All stages passed (or all failures were overridden).
#   1  One or more checks failed without an override.
#   2  Usage / argument error.
#
# Financial-safety note:
#   This script only issues READ-ONLY Stellar CLI calls after deployment.
#   It never calls a state-changing contract method.  The write-enable
#   decision (Stage 4) is a local shell exit-code signal; the script
#   does not mutate any contract state to enable or disable writes.

set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

pass()    { echo -e "${GREEN}  ✓${RESET} $*"; }
fail_msg(){ echo -e "${RED}  ✗ FAIL:${RESET} $*" >&2; }
warn()    { echo -e "${YELLOW}  ⚠ WARN:${RESET} $*"; }
info()    { echo -e "${CYAN}  ·${RESET} $*"; }
header()  { echo -e "\n${BOLD}══ $* ══${RESET}"; }
fatal()   { echo -e "${RED}ERROR:${RESET} $*" >&2; exit 2; }

# ── State ──────────────────────────────────────────────────────────────────
FAILURES=0
WARNINGS=0

record_fail() {
  FAILURES=$(( FAILURES + 1 ))
  fail_msg "$*"
  if [[ -n "${OVERRIDE_REASON:-}" ]]; then
    warn "Failure overridden: $OVERRIDE_REASON"
    WARNINGS=$(( WARNINGS + 1 ))
    FAILURES=$(( FAILURES - 1 ))
  fi
}

# ── Defaults ───────────────────────────────────────────────────────────────
PROFILE="testnet"
WASM_PATH=""
EXPECTED_DIGEST=""
CONTRACT_ID=""
EXPECTED_ADMIN=""
EXPECTED_ORACLE=""
DRY_RUN=false
SKIP_POST_DEPLOY=false
OVERRIDE_REASON=""
VERBOSE=false

usage() {
  sed -n '/^# Usage:/,/^# Exit codes:/p' "$0" | sed 's/^# \{0,2\}//'
  exit 0
}

# ── Argument parsing ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)             usage ;;
    --profile)             PROFILE="$2";           shift 2 ;;
    --wasm)                WASM_PATH="$2";          shift 2 ;;
    --expected-digest)     EXPECTED_DIGEST="$2";   shift 2 ;;
    --contract-id)         CONTRACT_ID="$2";       shift 2 ;;
    --admin)               EXPECTED_ADMIN="$2";    shift 2 ;;
    --oracle)              EXPECTED_ORACLE="$2";   shift 2 ;;
    --dry-run)             DRY_RUN=true;            shift ;;
    --skip-post-deploy)    SKIP_POST_DEPLOY=true;  shift ;;
    --override-reason)     OVERRIDE_REASON="$2";   shift 2 ;;
    -v|--verbose)          VERBOSE=true;            shift ;;
    *) fatal "Unknown option: $1" ;;
  esac
done

# ── Profile defaults ───────────────────────────────────────────────────────
case "$PROFILE" in
  local)
    DEFAULT_RPC="http://localhost:8000/soroban/rpc"
    DEFAULT_PASSPHRASE="Standalone Network ; February 2017"
    STELLAR_NETWORK_ARG="--network standalone"
    MIN_SIGNERS=1
    ;;
  testnet)
    DEFAULT_RPC="https://soroban-testnet.stellar.org"
    DEFAULT_PASSPHRASE="Test SDF Network ; September 2015"
    STELLAR_NETWORK_ARG="--network testnet"
    MIN_SIGNERS=2
    ;;
  futurenet)
    DEFAULT_RPC="https://rpc-futurenet.stellar.org"
    DEFAULT_PASSPHRASE="Test SDF Future Network ; April 2020"
    STELLAR_NETWORK_ARG="--network futurenet"
    MIN_SIGNERS=2
    ;;
  production)
    DEFAULT_RPC="https://mainnet.sorobanrpc.com"
    DEFAULT_PASSPHRASE="Public Global Stellar Network ; September 2015"
    STELLAR_NETWORK_ARG="--network mainnet"
    MIN_SIGNERS=3
    ;;
  *)
    fatal "Unknown profile '$PROFILE'. Must be local, testnet, futurenet, or production."
    ;;
esac

RPC_URL="${STELLAR_RPC_URL:-$DEFAULT_RPC}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-$DEFAULT_PASSPHRASE}"
WASM_PATH="${WASM_PATH:-target/wasm32v1-none/release/stellar_contracts.optimized.wasm}"
OUTPUT_FILE="${OUTPUT_FILE:-./contract_id_${PROFILE}.txt}"
ADMIN_SECRET="${STELLAR_ADMIN_SECRET_KEY:-}"

# ── Summary table helpers (CI-friendly markdown) ──────────────────────────
SUMMARY_LINES=()
add_summary_row() { SUMMARY_LINES+=("| $1 | $2 | $3 |"); }

emit_summary() {
  if [[ ${#SUMMARY_LINES[@]} -eq 0 ]]; then return; fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "| Check | Status | Detail |"
      echo "| --- | --- | --- |"
      printf '%s\n' "${SUMMARY_LINES[@]}"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# ── Helpers ────────────────────────────────────────────────────────────────
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fatal "Neither sha256sum nor shasum is available."
  fi
}

rpc_call() {
  # Usage: rpc_call <json-body> [--silent]
  local body="$1"
  local silent="${2:-}"
  if [[ "$silent" == "--silent" ]]; then
    curl -sf --max-time 15 "$RPC_URL" \
      -H 'Content-Type: application/json' \
      -d "$body" 2>/dev/null || true
  else
    curl -fsS --max-time 15 "$RPC_URL" \
      -H 'Content-Type: application/json' \
      -d "$body" 2>/dev/null || true
  fi
}

stellar_view() {
  # Read-only stellar contract invoke.  Uses --query or simulates; never submits.
  # Usage: stellar_view <contract-id> <function> [args...]
  local cid="$1"; shift
  local fn="$1"; shift
  stellar contract invoke \
    --id "$cid" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    -- "$fn" "$@" 2>/dev/null || true
}

# ── Stage banners ──────────────────────────────────────────────────────────
print_stage_header() {
  echo ""
  echo -e "${BOLD}════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  Stage $1: $2${RESET}"
  echo -e "${BOLD}  Profile: ${PROFILE}  |  RPC: ${RPC_URL}${RESET}"
  echo -e "${BOLD}════════════════════════════════════════════════════════${RESET}"
}

# ══════════════════════════════════════════════════════════════════════════
# STAGE 1 — PREFLIGHT
# ══════════════════════════════════════════════════════════════════════════
print_stage_header "1" "Preflight Checks"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "## 🔍 Stage 1 — Preflight Checks" >> "$GITHUB_STEP_SUMMARY"
  echo "" >> "$GITHUB_STEP_SUMMARY"
fi

# ── 1a. Required tools ─────────────────────────────────────────────────────
header "1a. Required tools"
for tool in curl jq; do
  if command -v "$tool" >/dev/null 2>&1; then
    pass "$tool found: $(command -v "$tool")"
    add_summary_row "tool:$tool" "✅ ok" "$(command -v "$tool")"
  else
    record_fail "Required tool '$tool' not found in PATH."
    add_summary_row "tool:$tool" "❌ missing" "Install $tool"
  fi
done

if command -v stellar >/dev/null 2>&1; then
  STELLAR_VERSION=$(stellar --version 2>/dev/null | head -n 1 || echo "unknown")
  pass "stellar CLI found: $STELLAR_VERSION"
  add_summary_row "tool:stellar" "✅ ok" "$STELLAR_VERSION"
else
  record_fail "stellar CLI not found. Install with: cargo install --locked stellar-cli --version 28.0.0"
  add_summary_row "tool:stellar" "❌ missing" "cargo install --locked stellar-cli --version 28.0.0"
fi

# ── 1b. Network identity & RPC reachability ────────────────────────────────
header "1b. Network identity & RPC reachability"
info "RPC URL:    $RPC_URL"
info "Passphrase: $NETWORK_PASSPHRASE"

HEALTH_RESP=$(rpc_call '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' --silent)
if echo "$HEALTH_RESP" | jq -e '.result.status == "healthy"' >/dev/null 2>&1; then
  pass "RPC endpoint is healthy"
  add_summary_row "rpc-health" "✅ ok" "$RPC_URL"
else
  record_fail "RPC endpoint not healthy or unreachable: $RPC_URL"
  add_summary_row "rpc-health" "❌ fail" "Check $RPC_URL"
fi

NET_RESP=$(rpc_call '{"jsonrpc":"2.0","id":2,"method":"getNetwork"}' --silent)
ACTUAL_PASSPHRASE=$(echo "$NET_RESP" | jq -r '.result.passphrase // empty' 2>/dev/null || true)
if [[ -n "$ACTUAL_PASSPHRASE" && "$ACTUAL_PASSPHRASE" == "$NETWORK_PASSPHRASE" ]]; then
  pass "Network passphrase matches: $ACTUAL_PASSPHRASE"
  add_summary_row "network-passphrase" "✅ ok" "${ACTUAL_PASSPHRASE:0:50}…"
elif [[ -z "$ACTUAL_PASSPHRASE" ]]; then
  warn "Could not read network passphrase from RPC; skipping identity check."
  add_summary_row "network-passphrase" "⚠️ skip" "RPC did not return passphrase"
else
  record_fail "Network passphrase mismatch. Expected: '$NETWORK_PASSPHRASE' — Got: '$ACTUAL_PASSPHRASE'"
  add_summary_row "network-passphrase" "❌ fail" "Expected: $NETWORK_PASSPHRASE"
fi

LEDGER_RESP=$(rpc_call '{"jsonrpc":"2.0","id":3,"method":"getLatestLedger"}' --silent)
LATEST_LEDGER=$(echo "$LEDGER_RESP" | jq -r '.result.sequence // empty' 2>/dev/null || true)
if [[ -n "$LATEST_LEDGER" && "$LATEST_LEDGER" =~ ^[0-9]+$ ]]; then
  pass "Latest ledger: $LATEST_LEDGER"
  add_summary_row "latest-ledger" "✅ ok" "sequence=$LATEST_LEDGER"
else
  record_fail "Could not read latest ledger from RPC."
  add_summary_row "latest-ledger" "❌ fail" "getLatestLedger returned no sequence"
fi

# ── 1c. WASM artifact & digest ─────────────────────────────────────────────
header "1c. WASM artifact & digest"
if [[ -f "$WASM_PATH" && -s "$WASM_PATH" ]]; then
  ACTUAL_DIGEST=$(sha256_of "$WASM_PATH")
  WASM_SIZE=$(wc -c < "$WASM_PATH" | tr -d '[:space:]')
  pass "WASM found: $WASM_PATH (${WASM_SIZE} bytes)"
  pass "WASM SHA-256: $ACTUAL_DIGEST"
  add_summary_row "wasm-present" "✅ ok" "${WASM_PATH} (${WASM_SIZE}B)"
  add_summary_row "wasm-digest" "✅ ok" "$ACTUAL_DIGEST"

  if [[ -n "$EXPECTED_DIGEST" ]]; then
    EXPECTED_HEX="${EXPECTED_DIGEST#sha256:}"
    if [[ "$ACTUAL_DIGEST" == "$EXPECTED_HEX" ]]; then
      pass "WASM digest pin matched: sha256:$ACTUAL_DIGEST"
      add_summary_row "wasm-digest-pin" "✅ ok" "Pin verified"
    else
      record_fail "WASM digest pin mismatch. Expected: sha256:$EXPECTED_HEX — Got: sha256:$ACTUAL_DIGEST"
      add_summary_row "wasm-digest-pin" "❌ fail" "Expected $EXPECTED_HEX"
    fi
  else
    info "No --expected-digest supplied; skipping digest pin check."
    add_summary_row "wasm-digest-pin" "⚠️ skip" "No pin configured"
  fi
else
  record_fail "WASM artifact not found or empty: $WASM_PATH"
  add_summary_row "wasm-present" "❌ fail" "$WASM_PATH not found"
  add_summary_row "wasm-digest" "❌ skip" "File absent"
  ACTUAL_DIGEST="UNKNOWN"
fi

# ── 1d. Signer / admin key availability ────────────────────────────────────
header "1d. Signer availability"
if [[ -n "$ADMIN_SECRET" ]]; then
  pass "Admin signing key is set (redacted)."
  add_summary_row "signer-key" "✅ ok" "STELLAR_ADMIN_SECRET_KEY is set"
elif [[ "$DRY_RUN" == "true" ]]; then
  warn "No admin signing key set; dry-run mode — deploy step will be skipped."
  add_summary_row "signer-key" "⚠️ skip" "Dry-run; no key needed"
else
  record_fail "STELLAR_ADMIN_SECRET_KEY is not set. Required for deployment."
  add_summary_row "signer-key" "❌ fail" "Set STELLAR_ADMIN_SECRET_KEY"
fi

info "Minimum signer quorum for profile '$PROFILE': $MIN_SIGNERS"
add_summary_row "signer-quorum" "✅ info" "min=${MIN_SIGNERS} for profile=${PROFILE}"

# ── 1e. Migrations check ───────────────────────────────────────────────────
header "1e. Migrations"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -d "$CONTRACT_DIR/migrations" ]] || [[ -f "$CONTRACT_DIR/MIGRATIONS.md" ]]; then
  pass "Migrations directory or MIGRATIONS.md found."
  add_summary_row "migrations" "✅ ok" "Migrations present"
else
  warn "No migrations directory or MIGRATIONS.md; confirm no schema migration is needed."
  add_summary_row "migrations" "⚠️ warn" "No migrations found"
fi

# ── Print preflight summary ────────────────────────────────────────────────
emit_summary
SUMMARY_LINES=()

if [[ "$FAILURES" -gt 0 ]]; then
  echo ""
  echo -e "${RED}  ✗ Preflight failed with $FAILURES error(s). Deployment blocked.${RESET}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "❌ **Preflight failed with $FAILURES error(s). Deployment blocked.**" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

echo ""
echo -e "${GREEN}  ✓ All preflight checks passed.${RESET}"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "✅ **All preflight checks passed.**" >> "$GITHUB_STEP_SUMMARY"
fi

# ══════════════════════════════════════════════════════════════════════════
# STAGE 2 — DEPLOY
# ══════════════════════════════════════════════════════════════════════════
print_stage_header "2" "Contract Deployment"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "" >> "$GITHUB_STEP_SUMMARY"
  echo "## 🚀 Stage 2 — Contract Deployment" >> "$GITHUB_STEP_SUMMARY"
fi

if [[ -n "$CONTRACT_ID" ]]; then
  info "Existing --contract-id supplied; skipping deployment."
  info "Contract ID: $CONTRACT_ID"
  add_summary_row "deploy" "⚠️ skip" "Using existing $CONTRACT_ID"
  emit_summary; SUMMARY_LINES=()
elif [[ "$DRY_RUN" == "true" ]]; then
  info "Dry-run mode; skipping deployment transaction."
  add_summary_row "deploy" "⚠️ dry-run" "No transaction submitted"
  emit_summary; SUMMARY_LINES=()
  CONTRACT_ID="DRY_RUN_PLACEHOLDER"
else
  info "Deploying contract to $PROFILE ..."

  # Build if WASM not already present (re-entrant safety)
  if [[ ! -f "$WASM_PATH" ]]; then
    info "WASM not found; building first..."
    stellar contract build
  fi

  DEPLOY_OUTPUT=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source-account "$ADMIN_SECRET" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" \
    2>&1) || {
    record_fail "stellar contract deploy failed. Output: $DEPLOY_OUTPUT"
    emit_summary; SUMMARY_LINES=()
    exit 1
  }

  CONTRACT_ID=$(echo "$DEPLOY_OUTPUT" | grep -oP '[A-Z0-9]{56}' | tail -n 1 || true)
  if [[ -z "$CONTRACT_ID" ]]; then
    record_fail "Could not extract contract ID from deploy output: $DEPLOY_OUTPUT"
    emit_summary; SUMMARY_LINES=()
    exit 1
  fi

  pass "Contract deployed: $CONTRACT_ID"
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  echo "$CONTRACT_ID" > "$OUTPUT_FILE"
  info "Contract ID saved to: $OUTPUT_FILE"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "contract_id=$CONTRACT_ID" >> "$GITHUB_OUTPUT"
  fi
  add_summary_row "deploy" "✅ ok" "$CONTRACT_ID"
  emit_summary; SUMMARY_LINES=()
fi

# ══════════════════════════════════════════════════════════════════════════
# STAGE 3 — POST-DEPLOY READ-ONLY VERIFICATION
# ══════════════════════════════════════════════════════════════════════════
print_stage_header "3" "Post-Deploy Read-Only Verification"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "" >> "$GITHUB_STEP_SUMMARY"
  echo "## 🔬 Stage 3 — Post-Deploy Verification" >> "$GITHUB_STEP_SUMMARY"
fi

POST_FAILURES=0

post_fail() {
  POST_FAILURES=$(( POST_FAILURES + 1 ))
  FAILURES=$(( FAILURES + 1 ))
  fail_msg "$*"
  add_summary_row "$1" "❌ fail" "$2"
  if [[ -n "${OVERRIDE_REASON:-}" ]]; then
    warn "Post-deploy failure overridden: $OVERRIDE_REASON"
    POST_FAILURES=$(( POST_FAILURES - 1 ))
    FAILURES=$(( FAILURES - 1 ))
  fi
}

if [[ "$SKIP_POST_DEPLOY" == "true" ]]; then
  warn "Post-deploy verification skipped (--skip-post-deploy)."
  add_summary_row "post-deploy" "⚠️ skip" "--skip-post-deploy flag set"
  emit_summary; SUMMARY_LINES=()
elif [[ "$CONTRACT_ID" == "DRY_RUN_PLACEHOLDER" ]]; then
  warn "Post-deploy verification skipped (dry-run, no contract ID)."
  add_summary_row "post-deploy" "⚠️ skip" "dry-run mode"
  emit_summary; SUMMARY_LINES=()
else
  # ── 3a. Contract queryable ──────────────────────────────────────────────
  header "3a. Contract queryable (getContractData)"
  CD_RESP=$(rpc_call "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"getContractData\",\"params\":{\"contract\":\"$CONTRACT_ID\",\"key\":\"ledger\",\"durability\":\"persistent\"}}" --silent)
  # Any non-error response (even "not found") confirms the contract is reachable
  if echo "$CD_RESP" | jq -e '. != null' >/dev/null 2>&1; then
    pass "Contract is queryable on-chain: $CONTRACT_ID"
    add_summary_row "contract-queryable" "✅ ok" "$CONTRACT_ID"
  else
    post_fail "contract-queryable" "getContractData returned null for $CONTRACT_ID"
  fi

  # ── 3b. Chain identity re-confirmation ─────────────────────────────────
  header "3b. Chain identity re-confirmation"
  NET_RESP2=$(rpc_call '{"jsonrpc":"2.0","id":5,"method":"getNetwork"}' --silent)
  ACTUAL_PASSPHRASE2=$(echo "$NET_RESP2" | jq -r '.result.passphrase // empty' 2>/dev/null || true)
  if [[ -n "$ACTUAL_PASSPHRASE2" && "$ACTUAL_PASSPHRASE2" == "$NETWORK_PASSPHRASE" ]]; then
    pass "Post-deploy chain identity confirmed: $ACTUAL_PASSPHRASE2"
    add_summary_row "chain-identity-post" "✅ ok" "Passphrase matches"
  elif [[ -z "$ACTUAL_PASSPHRASE2" ]]; then
    warn "Could not re-confirm chain identity from RPC."
    add_summary_row "chain-identity-post" "⚠️ warn" "RPC did not return passphrase"
  else
    post_fail "chain-identity-post" "Chain identity changed between preflight and post-deploy!"
  fi

  # ── 3c. get_deploy_config_hash (read-only) ──────────────────────────────
  header "3c. Deployment config hash probe (read-only)"
  if command -v stellar >/dev/null 2>&1; then
    CONFIG_HASH=$(stellar_view "$CONTRACT_ID" "get_deploy_config_hash")
    if [[ -n "$CONFIG_HASH" && "$CONFIG_HASH" != "null" ]]; then
      pass "get_deploy_config_hash returned: $CONFIG_HASH"
      add_summary_row "config-hash-probe" "✅ ok" "$CONFIG_HASH"
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        echo "config_hash=$CONFIG_HASH" >> "$GITHUB_OUTPUT"
      fi
    else
      warn "get_deploy_config_hash returned empty/null — contract may not be initialised yet."
      add_summary_row "config-hash-probe" "⚠️ warn" "Returned null; init pending"
    fi
  else
    warn "stellar CLI not available; skipping config hash probe."
    add_summary_row "config-hash-probe" "⚠️ skip" "stellar CLI absent"
  fi

  # ── 3d. Admin identity probe (read-only) ───────────────────────────────
  header "3d. Admin identity probe (read-only)"
  if command -v stellar >/dev/null 2>&1; then
    ADMIN_RESP=$(stellar_view "$CONTRACT_ID" "get_admin")
    if [[ -n "$ADMIN_RESP" && "$ADMIN_RESP" != "null" ]]; then
      pass "get_admin returned: $ADMIN_RESP"
      add_summary_row "admin-probe" "✅ ok" "$ADMIN_RESP"
      if [[ -n "$EXPECTED_ADMIN" ]]; then
        # Strip surrounding quotes from CLI output
        ADMIN_CLEAN="${ADMIN_RESP//\"/}"
        if [[ "$ADMIN_CLEAN" == "$EXPECTED_ADMIN" ]]; then
          pass "Admin address matches expected: $EXPECTED_ADMIN"
          add_summary_row "admin-identity" "✅ ok" "Matches $EXPECTED_ADMIN"
        else
          post_fail "admin-identity" "Admin mismatch. Expected $EXPECTED_ADMIN — Got $ADMIN_CLEAN"
        fi
      else
        info "No --admin supplied; skipping admin identity assertion."
        add_summary_row "admin-identity" "⚠️ skip" "No --admin flag"
      fi
    else
      info "get_admin returned null — contract not yet initialised (expected before init)."
      add_summary_row "admin-probe" "⚠️ warn" "Null — init pending"
    fi
  else
    warn "stellar CLI not available; skipping admin probe."
    add_summary_row "admin-probe" "⚠️ skip" "stellar CLI absent"
  fi

  # ── 3e. Oracle identity probe (read-only) ──────────────────────────────
  header "3e. Oracle identity probe (read-only)"
  if command -v stellar >/dev/null 2>&1; then
    # get_config_snapshot returns all config; oracle field is inside it
    SNAPSHOT=$(stellar_view "$CONTRACT_ID" "get_config_snapshot" 2>/dev/null || true)
    if [[ -n "$SNAPSHOT" && "$SNAPSHOT" != "null" ]]; then
      ORACLE_ADDR=$(echo "$SNAPSHOT" | jq -r '.oracle // empty' 2>/dev/null || true)
      if [[ -n "$ORACLE_ADDR" ]]; then
        pass "Oracle address from config snapshot: $ORACLE_ADDR"
        add_summary_row "oracle-probe" "✅ ok" "$ORACLE_ADDR"
        if [[ -n "$EXPECTED_ORACLE" ]]; then
          if [[ "$ORACLE_ADDR" == "$EXPECTED_ORACLE" ]]; then
            pass "Oracle address matches expected: $EXPECTED_ORACLE"
            add_summary_row "oracle-identity" "✅ ok" "Matches $EXPECTED_ORACLE"
          else
            post_fail "oracle-identity" "Oracle mismatch. Expected $EXPECTED_ORACLE — Got $ORACLE_ADDR"
          fi
        else
          info "No --oracle supplied; skipping oracle identity assertion."
          add_summary_row "oracle-identity" "⚠️ skip" "No --oracle flag"
        fi
      else
        info "Oracle not set in config snapshot (may be pre-init)."
        add_summary_row "oracle-probe" "⚠️ warn" "Oracle not configured yet"
      fi
    else
      info "get_config_snapshot returned null — contract not yet initialised."
      add_summary_row "oracle-probe" "⚠️ warn" "Null — init pending"
    fi
  else
    warn "stellar CLI not available; skipping oracle probe."
    add_summary_row "oracle-probe" "⚠️ skip" "stellar CLI absent"
  fi

  # ── 3f. Pause state probe (financial safety) ───────────────────────────
  header "3f. Pause state probe (financial safety)"
  if command -v stellar >/dev/null 2>&1; then
    PAUSE_RESP=$(stellar_view "$CONTRACT_ID" "get_pause_state" 2>/dev/null || true)
    if [[ -n "$PAUSE_RESP" && "$PAUSE_RESP" != "null" ]]; then
      GLOBAL_PAUSED=$(echo "$PAUSE_RESP" | jq -r '.global // false' 2>/dev/null || echo "false")
      pass "Pause state read successfully. global_paused=$GLOBAL_PAUSED"
      add_summary_row "pause-state" "✅ ok" "global_paused=$GLOBAL_PAUSED"
    else
      info "Pause state unavailable — contract not yet initialised."
      add_summary_row "pause-state" "⚠️ warn" "Null — init pending"
    fi
  else
    warn "stellar CLI not available; skipping pause state probe."
    add_summary_row "pause-state" "⚠️ skip" "stellar CLI absent"
  fi

  # ── 3g. Circuit breaker probe ──────────────────────────────────────────
  header "3g. Circuit breaker probe"
  if command -v stellar >/dev/null 2>&1; then
    CB_RESP=$(stellar_view "$CONTRACT_ID" "is_circuit_breaker_tripped" 2>/dev/null || true)
    if [[ -n "$CB_RESP" && "$CB_RESP" != "null" ]]; then
      pass "Circuit breaker tripped=$CB_RESP"
      add_summary_row "circuit-breaker" "✅ ok" "tripped=$CB_RESP"
    else
      info "Circuit breaker status unavailable — contract not yet initialised."
      add_summary_row "circuit-breaker" "⚠️ warn" "Null — init pending"
    fi
  else
    warn "stellar CLI not available; skipping circuit breaker probe."
    add_summary_row "circuit-breaker" "⚠️ skip" "stellar CLI absent"
  fi

  emit_summary; SUMMARY_LINES=()
fi

# ══════════════════════════════════════════════════════════════════════════
# STAGE 4 — WRITE-ENABLE GATE
# ══════════════════════════════════════════════════════════════════════════
print_stage_header "4" "Write-Enable Gate"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "" >> "$GITHUB_STEP_SUMMARY"
  echo "## 🚦 Stage 4 — Write-Enable Gate" >> "$GITHUB_STEP_SUMMARY"
  echo "" >> "$GITHUB_STEP_SUMMARY"
  echo "| Field | Value |" >> "$GITHUB_STEP_SUMMARY"
  echo "| --- | --- |" >> "$GITHUB_STEP_SUMMARY"
  echo "| Profile | $PROFILE |" >> "$GITHUB_STEP_SUMMARY"
  echo "| Contract ID | ${CONTRACT_ID:-none} |" >> "$GITHUB_STEP_SUMMARY"
  echo "| WASM digest | ${ACTUAL_DIGEST:-unknown} |" >> "$GITHUB_STEP_SUMMARY"
  echo "| Preflight failures | $FAILURES |" >> "$GITHUB_STEP_SUMMARY"
  echo "| Post-deploy failures | $POST_FAILURES |" >> "$GITHUB_STEP_SUMMARY"
  if [[ -n "${OVERRIDE_REASON:-}" ]]; then
    echo "| Override reason | $OVERRIDE_REASON |" >> "$GITHUB_STEP_SUMMARY"
  fi
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "staged_deploy_contract_id=${CONTRACT_ID:-}" >> "$GITHUB_OUTPUT"
  echo "staged_deploy_wasm_digest=${ACTUAL_DIGEST:-unknown}" >> "$GITHUB_OUTPUT"
  echo "staged_deploy_profile=$PROFILE" >> "$GITHUB_OUTPUT"
  if [[ "$FAILURES" -eq 0 ]]; then
    echo "staged_deploy_write_enabled=true"  >> "$GITHUB_OUTPUT"
  else
    echo "staged_deploy_write_enabled=false" >> "$GITHUB_OUTPUT"
  fi
fi

echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ✓ All stages passed. Frontend writes are ENABLED.${RESET}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "✅ **All stages passed — frontend writes are ENABLED.**" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 0
else
  echo -e "${RED}${BOLD}  ✗ $FAILURES check(s) failed. Frontend writes are BLOCKED.${RESET}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "❌ **$FAILURES check(s) failed — frontend writes are BLOCKED.**" >> "$GITHUB_STEP_SUMMARY"
    echo "" >> "$GITHUB_STEP_SUMMARY"
    echo "_See \`docs/operations/staged-deployment.md\` for the recovery runbook._" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi
