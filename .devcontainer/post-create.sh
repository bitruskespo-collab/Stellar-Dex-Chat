#!/usr/bin/env bash
# Post-create setup for the DEX with Fiat devcontainer.
# Installs/verifies tooling so checks run without host toolchain assumptions.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Rust toolchain / target ---
rustup target add wasm32-unknown-unknown
rustup component add rustfmt clippy

# --- Stellar CLI (pinned) ---
STELLAR_CLI_VERSION="21.0.0"
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

echo "Devcontainer setup complete."
echo "Contract checks:  cargo test --workspace && cargo clippy --all-targets"
echo "Frontend checks:  (cd Dechat/dex_with_fiat_frontend && pnpm lint && pnpm test)"
echo "Integration:      (cd Dechat/dex_with_fiat_frontend && pnpm exec playwright test)"
