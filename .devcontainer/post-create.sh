#!/usr/bin/env bash
# Post-create setup for the DEX with Fiat devcontainer.
# Installs/verifies tooling so checks run without host toolchain assumptions.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Pinned toolchain versions (canonical manifest) ---
# Keep these in sync with rust-toolchain.toml and CI workflows.
VERSIONS_FILE="$REPO_ROOT/toolchain-versions.env"
if [ -f "$VERSIONS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$VERSIONS_FILE"
fi

RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-1.79.0}"
RUST_TARGET="${RUST_TARGET:-wasm32-unknown-unknown}"
STELLAR_CLI_VERSION="${STELLAR_CLI_VERSION:-21.0.0}"
SOROBAN_SDK_VERSION="${SOROBAN_SDK_VERSION:-21.0.0}"
RUSTFMT_VERSION="${RUSTFMT_VERSION:-1.7.0}"
CLIPPY_VERSION="${CLIPPY_VERSION:-0.1.79}"

# --- Rust toolchain / target ---
if command -v rustup >/dev/null 2>&1; then
  rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt,clippy
  rustup override set "$RUST_TOOLCHAIN"
fi
rustup target add "$RUST_TARGET"
rustup component add rustfmt clippy

# --- Stellar CLI (pinned) ---
if ! command -v stellar >/dev/null 2>&1; then
  cargo install --locked stellar-cli --version "$STELLAR_CLI_VERSION"
fi

# --- Node / pnpm ---
corepack enable
corepack prepare pnpm@9.1.0 --activate

# --- Frontend deps ---
if [ -f "Dechat/dex_with_fiat_frontend/package.json" ]; then
  (cd Dechat/dex_with_fiat_frontend && pnpm install --frozen-lockfile)
fi

# --- Playwright browsers for integration/e2e checks ---
if [ -f "Dechat/dex_with_fiat_frontend/package.json" ]; then
  (cd Dechat/dex_with_fiat_frontend && pnpm exec playwright install --with-deps || true)
fi

# --- Verify installed tool versions against the pinned manifest ---
verify_toolchain() {
  local failures=0

  check_version() {
    local name="$1" actual="$2" expected="$3"
    if [ "$actual" != "$expected" ]; then
      echo "MISMATCH: $name expected '$expected' but found '$actual'" >&2
      failures=$((failures + 1))
    else
      echo "OK: $name $actual"
    fi
  }

  local rustc_ver
  rustc_ver="$(rustc --version 2>/dev/null | awk '{print $2}' || echo 'missing')"
  check_version "rustc" "$rustc_ver" "$RUST_TOOLCHAIN"

  local rustfmt_ver
  rustfmt_ver="$(rustfmt --version 2>/dev/null | awk '{print $2}' || echo 'missing')"
  check_version "rustfmt" "$rustfmt_ver" "$RUSTFMT_VERSION"

  local clippy_ver
  clippy_ver="$(cargo clippy --version 2>/dev/null | awk '{print $2}' || echo 'missing')"
  check_version "clippy" "$clippy_ver" "$CLIPPY_VERSION"

  local stellar_ver
  stellar_ver="$(stellar --version 2>/dev/null | awk '{print $2}' || echo 'missing')"
  check_version "stellar-cli" "$stellar_ver" "$STELLAR_CLI_VERSION"

  if ! rustup target list --installed 2>/dev/null | grep -qx "$RUST_TARGET"; then
    echo "MISMATCH: rust target '$RUST_TARGET' is not installed" >&2
    failures=$((failures + 1))
  else
    echo "OK: rust target $RUST_TARGET"
  fi

  if [ "$failures" -ne 0 ]; then
    echo "Toolchain verification failed with $failures mismatch(es)." >&2
    echo "Update toolchain-versions.env or reinstall the pinned tools." >&2
    return 1
  fi
  echo "Toolchain verification passed (Soroban SDK pinned at $SOROBAN_SDK_VERSION)."
}

verify_toolchain

echo "Devcontainer setup complete."
echo "Contract checks:  cargo test --workspace && cargo clippy --all-targets"
echo "Frontend checks:  (cd Dechat/dex_with_fiat_frontend && pnpm lint && pnpm test)"
echo "Integration:      (cd Dechat/dex_with_fiat_frontend && pnpm exec playwright test)"
