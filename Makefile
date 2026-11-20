.PHONY: ci frontend-typecheck frontend-lint frontend-build frontend-test frontend-e2e contracts-test secret-scan secret-scan-staged secret-scan-test

# Reproduces the validation matrix used by the pull-request workflows.
ci: secret-scan secret-scan-test frontend-typecheck frontend-lint frontend-build frontend-test frontend-e2e contracts-test

secret-scan:
	python3 tools/secret_scanner.py --path . --check-env

secret-scan-staged:
	python3 tools/secret_scanner.py --staged

secret-scan-test:
	python3 -m unittest discover -s tools/tests -v

frontend-typecheck:
	pnpm --dir Dechat/dex_with_fiat_frontend typecheck

frontend-lint:
	pnpm --dir Dechat/dex_with_fiat_frontend lint

frontend-build:
	pnpm --dir Dechat/dex_with_fiat_frontend build

frontend-test:
	pnpm --dir Dechat/dex_with_fiat_frontend test:coverage

frontend-e2e:
	pnpm --dir Dechat/dex_with_fiat_frontend test:e2e

contracts-test:
	cargo test --manifest-path Dechat/stellar-contracts/Cargo.toml
	cargo build --manifest-path Dechat/stellar-contracts/Cargo.toml --target wasm32-unknown-unknown --release
	cargo clippy --manifest-path Dechat/stellar-contracts/Cargo.toml --all-targets --all-features -- -D warnings
